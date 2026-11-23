#!/usr/bin/env node
'use strict';
// TrueDoF Director chat: a small local web app at http://localhost:8766
//
//   node server/server.js
//
// It reads %LOCALAPPDATA%\TrueDoF\dump-latest.json (written by the FM plugin), builds the
// briefing, and sends your questions plus the briefing to Claude. Your API key is read from
// the .env file in the project folder and never leaves this program.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Anthropic = require('@anthropic-ai/sdk');
const { buildBriefing, estimateTokens } = require('../briefing/briefing');
const { perceive } = require('../briefing/realism');
const { systemPrompt, DEFAULT_PHILOSOPHY } = require('./director');
const { PlayerDatabase } = require('./database');
const { TOOLS, runTool, describe } = require('./tools');

const ROOT = path.join(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 8766;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const DATA_DIR = process.env.TRUEDOF_DATA_DIR || defaultDataDir();
const SETTINGS_FILE = path.join(DATA_DIR, 'director-settings.json');
const PUBLIC = path.join(__dirname, 'public');
const database = new PlayerDatabase(path.join(DATA_DIR, 'players-db.json'));
const MAX_HISTORY = 40;   // messages kept per request (oldest dropped first)

// ---------------------------------------------------------------- helpers

function defaultDataDir() {
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'TrueDoF');
  return path.join(os.homedir(), '.local', 'share', 'TrueDoF');
}

/** Minimal .env reader: KEY=value lines, # comments. Doesn't override real environment variables. */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

const DEFAULT_SETTINGS = { realism: false, judging: 12, effort: 'medium', philosophy: DEFAULT_PHILOSOPHY };

function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(input) {
  const s = readSettings();
  if (typeof input.realism === 'boolean') s.realism = input.realism;
  if (Number.isFinite(Number(input.judging))) s.judging = Math.max(1, Math.min(20, Math.round(Number(input.judging))));
  if (['low', 'medium', 'high'].includes(input.effort)) s.effort = input.effort;
  if (typeof input.philosophy === 'string') s.philosophy = input.philosophy.slice(0, 2000);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return s;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

function readDump() { return readJson(path.join(DATA_DIR, 'dump-latest.json')); }

/** The briefing exactly as the Director will see it (with realism applied if on). */
function currentBriefing(settings) {
  const dump = readDump();
  if (!dump) return { dump: null, text: null };
  const seen = settings.realism ? perceive(dump, settings.judging) : dump;
  return { dump, text: buildBriefing(seen) };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// Only this PC may talk to the app: right Host header, and same-origin for POSTs.
function allowed(req) {
  const okHosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  if (!okHosts.includes(req.headers.host)) return false;
  if (req.method === 'POST') {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false;
    const origin = req.headers.origin;
    if (origin && !okHosts.map(h => `http://${h}`).includes(origin)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- Claude

let client = null;
function claude() {
  // With no ANTHROPIC_API_KEY the SDK also looks for other credentials (e.g. an `ant auth login` profile).
  if (!client) client = new Anthropic(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {});
  return client;
}

/** Keep only well-formed user/assistant text turns, newest MAX_HISTORY, starting with a user turn. */
function cleanHistory(messages) {
  let list = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 20000) }));
  list = list.slice(-MAX_HISTORY);
  while (list.length && list[0].role !== 'user') list.shift();
  return list;
}

function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Your Anthropic API key was rejected. Check ANTHROPIC_API_KEY in the .env file, then restart the app.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Your API key is not allowed to use this model. Check your Anthropic account (Console) settings.';
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic says: too many requests or out of credit. Wait a minute, or check your plan/credit in the Anthropic Console.';
  if (e instanceof Anthropic.BadRequestError) return 'The request was rejected: ' + e.message;
  if (e instanceof Anthropic.InternalServerError) return 'Anthropic is having a problem right now (server error). Try again in a moment.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check your internet connection.';
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status}: ${e.message}`;
  if (/credentials|apiKey|api key|authentication/i.test(String(e && e.message)))
    return 'No Anthropic API key found. Put ANTHROPIC_API_KEY=... in the .env file in the TrueDoF folder, then restart the app.';
  return 'Something went wrong: ' + (e && e.message ? e.message : String(e));
}

const MAX_TOOL_ROUNDS = 8;   // at most this many rounds of tool use per question

/** Facts the database tools need about our club. */
function toolContext(dump, settings) {
  const club = dump.club || {};
  const wages = (dump.squad || []).map(p => p.contract && p.contract.wageWeekly).filter(w => w != null);
  return {
    ownClub: club.name, today: (dump.meta && dump.meta.gameDate) || new Date().toISOString().slice(0, 10),
    transferBudget: club.transferBudget ?? null,
    wageHeadroom: club.wageBudgetWeekly != null && club.wageSpendWeekly != null ? club.wageBudgetWeekly - club.wageSpendWeekly : null,
    topWage: wages.length ? Math.max(...wages) : null,
    realism: settings.realism, judging: settings.judging, dataDir: DATA_DIR,
  };
}

async function chat(req, res) {
  const body = await readBody(req);
  const history = cleanHistory(body.messages);
  if (!history.length || history[history.length - 1].role !== 'user') return send(res, 400, { error: 'Send a question first.' });

  const settings = readSettings();
  const { dump, text: briefing } = currentBriefing(settings);

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const event = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (!dump) {
    event({ type: 'error', message: 'No game data yet. Load your save in FM27 and press F8 (or "Refresh from FM"), then ask again.' });
    return res.end();
  }

  const ctx = toolContext(dump, settings);
  const system = [
    { type: 'text', text: systemPrompt({ clubName: dump.club && dump.club.name, philosophy: settings.philosophy, realism: settings.realism, databaseReady: database.load() }) },
    { type: 'text', text: `<club_briefing>\n${briefing}\n</club_briefing>`, cache_control: { type: 'ephemeral' } },
  ];
  const messages = [...history];   // grows with tool calls and results during this answer
  let stream = null, closed = false, wroteText = false;
  res.on('close', () => { closed = true; if (stream) stream.abort(); });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS && !closed; round++) {
      stream = claude().beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        thinking: { type: 'adaptive' },
        output_config: { effort: settings.effort },
        // If a safety check declines the request, the API retries on Anthropic's recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        tools: TOOLS,
        system,
        cache_control: { type: 'ephemeral' },   // also cache the conversation so far
        messages,
      });
      let roundText = false;
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          if (!roundText && wroteText) event({ type: 'text', text: '\n\n' });   // keep text from separate rounds apart
          roundText = wroteText = true;
          event({ type: 'text', text: ev.delta.text });
        }
      }
      const final = await stream.finalMessage();
      const u = final.usage || {};
      usage.input += u.input_tokens || 0; usage.output += u.output_tokens || 0;
      usage.cacheRead += u.cache_read_input_tokens || 0; usage.cacheWrite += u.cache_creation_input_tokens || 0;

      if (final.stop_reason === 'refusal') { event({ type: 'error', message: 'The model declined to answer this one. Try rephrasing the question.' }); break; }
      const calls = final.content.filter(b => b.type === 'tool_use');
      if (final.stop_reason === 'max_tokens') { event({ type: 'error', message: 'The answer was cut off because it got too long. Ask for a shorter answer.' }); break; }
      if (final.stop_reason !== 'tool_use' || !calls.length) break;

      // Run the tools he asked for, then let him continue with the results.
      messages.push({ role: 'assistant', content: final.content });
      const results = [];
      for (const call of calls) {
        event({ type: 'tool', text: describe(call.name, call.input) });
        const r = runTool(database, call.name, call.input, ctx);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      if (round === MAX_TOOL_ROUNDS - 1) event({ type: 'error', message: 'He searched a lot without finishing. Try a narrower question.' });
    }
    event({ type: 'done', model: MODEL, usage });
  } catch (e) {
    if (!closed && !(e && e.name === 'APIUserAbortError')) event({ type: 'error', message: friendlyError(e) });
  }
  res.end();
}

// ---------------------------------------------------------------- refresh from FM

async function refresh(res) {
  const statusFile = path.join(DATA_DIR, 'status.json');
  const before = readJson(statusFile);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'request.flag'), String(Date.now()));   // the plugin watches for this file
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const now = readJson(statusFile);
    if (now && now.state !== 'running' && (!before || now.timestamp !== before.timestamp))
      return send(res, 200, { ok: now.state === 'ok', status: now });
  }
  send(res, 200, { ok: false, status: before, message: 'FM did not respond within 60 seconds. Is FM27 running with the TrueDoF plugin and a save loaded? You can also press F8 in the game.' });
}

// ---------------------------------------------------------------- routes

const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function handle(req, res) {
  if (!allowed(req)) return send(res, 403, { error: 'Forbidden' });
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = path.join(PUBLIC, STATIC[url.pathname]);
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)]);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const settings = readSettings();
      const { dump, text } = currentBriefing(settings);
      return send(res, 200, {
        settings, model: MODEL, hasKey: !!process.env.ANTHROPIC_API_KEY, dataDir: DATA_DIR,
        status: readJson(path.join(DATA_DIR, 'status.json')),
        dump: dump && { club: dump.club && dump.club.name, league: dump.club && dump.club.league, gameDate: dump.meta && dump.meta.gameDate,
          generatedAt: dump.meta && dump.meta.generatedAt, squad: (dump.squad || []).length, shortlist: (dump.shortlist || []).length },
        briefingTokens: text ? estimateTokens(text) : 0,
        databasePlayers: database.load() ? database.rows.length : 0,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/briefing') {
      const { text } = currentBriefing(readSettings());
      return send(res, 200, text || 'No game data yet. Load your save in FM27 and press F8.', 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') return send(res, 200, saveSettings(await readBody(req)));
    if (req.method === 'POST' && url.pathname === '/api/refresh') return refresh(res);
    if (req.method === 'POST' && url.pathname === '/api/chat') return chat(req, res);
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
    else res.end();
  }
}

const server = http.createServer((req, res) => { handle(req, res); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`TrueDoF Director is ready: open http://localhost:${PORT} in your browser.`);
  console.log(`Game data folder: ${DATA_DIR}`);
  if (!process.env.ANTHROPIC_API_KEY) console.log('Note: no ANTHROPIC_API_KEY in .env. Add it there (see .env.example), then restart.');
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Is TrueDoF already running? Close it, or set PORT=8767 in .env.`);
  else console.error(e);
  process.exit(1);
});

module.exports = { cleanHistory, loadEnv };
