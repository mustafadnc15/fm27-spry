'use strict';
// End-to-end test of the Director app against a FAKE Anthropic API (no key or internet needed).
// Run: node --test server/test
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fixture } = require('../../briefing/test/fixture');

// ---- fake Anthropic API: records requests, streams a short answer (or a 401 for key "bad")
const seen = [];
function startFakeApi() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
        const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (key === 'bad') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        const msgs = JSON.parse(body || '{}').messages || [];
        const last = msgs[msgs.length - 1] || {};
        const lastText = typeof last.content === 'string' ? last.content : '';
        if (/find me/i.test(lastText)) {
          // First round: the "model" calls search_players
          ev('message_start', { message: { id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Let me check the database.' } });
          ev('content_block_stop', { index: 0 });
          ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search_players', input: {} } });
          ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"positions":["ST"],' } });
          ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"role":"starter","limit":3}' } });
          ev('content_block_stop', { index: 1 });
          ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
          ev('message_stop', {});
          return res.end();
        }
        if (Array.isArray(last.content) && last.content[0] && last.content[0].type === 'tool_result') {
          // Second round: answer using the tool result
          const first = (last.content[0].content.split('\n').find(l => l.startsWith('1. ')) || '').split(' | ')[0];
          ev('message_start', { message: { id: 'msg_u', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 300, output_tokens: 1 } } });
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `Top pick: ${first}` } });
          ev('content_block_stop', { index: 0 });
          ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
          ev('message_stop', {});
          return res.end();
        }
        ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '**SIGN.** ' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'He is a clear upgrade.' } });
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } });
        ev('message_stop', {});
        res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function startApp(port, apiPort, dataDir, key) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), ANTHROPIC_BASE_URL: `http://127.0.0.1:${apiPort}`, ANTHROPIC_API_KEY: key, TRUEDOF_DATA_DIR: dataDir, LOCALAPPDATA: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (String(d).includes('ready')) resolve(child); });
    child.stderr.on('data', d => reject(new Error(String(d))));
  });
}

function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `localhost:${port}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const sse = text => text.split('\n\n').filter(c => c.startsWith('data: ')).map(c => JSON.parse(c.slice(6)));

test('Director app end to end', async t => {
  const api = await startFakeApi();
  const apiPort = api.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truedof-app-'));
  const port = 18766 + Math.floor(Math.random() * 1000);
  const app = await startApp(port, apiPort, dataDir, 'test-key');
  t.after(() => { app.kill(); api.close(); });

  await t.test('no dump yet: friendly error, no API call', async () => {
    const r = await request(port, 'POST', '/api/chat', { messages: [{ role: 'user', content: 'Hi' }] });
    assert.match(sse(r.text)[0].message, /press F8/);
    assert.strictEqual(seen.length, 0);
  });

  fs.writeFileSync(path.join(dataDir, 'dump-latest.json'), JSON.stringify(fixture()));

  await t.test('state and briefing endpoints', async () => {
    const s = JSON.parse((await request(port, 'GET', '/api/state')).text);
    assert.strictEqual(s.dump.club, 'Eskişehirspor Kulübü');
    assert.strictEqual(s.model, 'claude-sonnet-5-5');
    assert.ok(s.briefingTokens > 500);
    const b = await request(port, 'GET', '/api/briefing');
    assert.ok(b.text.includes('## BEST XI'));
    const page = await request(port, 'GET', '/');
    assert.ok(page.text.includes('TrueDoF Director'));
  });

  await t.test('chat streams the answer and sends the right request', async () => {
    const r = await request(port, 'POST', '/api/chat', { messages: [{ role: 'user', content: 'Should we sign Target Striker?' }] });
    const events = sse(r.text);
    assert.strictEqual(events.filter(e => e.type === 'text').map(e => e.text).join(''), '**SIGN.** He is a clear upgrade.');
    assert.ok(events.some(e => e.type === 'done'));
    const call = seen[seen.length - 1];
    assert.strictEqual(call.body.model, 'claude-sonnet-5-5');
    assert.strictEqual(call.body.stream, true);
    assert.strictEqual(call.body.fallbacks, 'default');
    assert.deepStrictEqual(call.body.thinking, { type: 'adaptive' });
    assert.strictEqual(call.body.output_config.effort, 'medium');
    assert.match(String(call.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.match(call.body.system[0].text, /Director of Football at Eskişehirspor/);
    assert.match(call.body.system[0].text, /exactly what the manager sees in FM with attribute masking off/);
    assert.match(call.body.system[1].text, /VIEW: like the manager in FM/);
    assert.ok(call.body.system[1].text.includes('<club_briefing>') && call.body.system[1].text.includes('Target Striker'));
    assert.deepStrictEqual(call.body.system[1].cache_control, { type: 'ephemeral' });
    assert.ok(call.headers['x-api-key'] === 'test-key' || call.headers.authorization === 'Bearer test-key');
  });

  await t.test('tactic.txt reaches the settings dialog, the briefing and the system prompt', async () => {
    const tacticFile = path.join(dataDir, 'tactic.txt');
    assert.strictEqual(JSON.parse((await request(port, 'GET', '/api/state')).text).tactic, null);
    assert.doesNotMatch(seen[seen.length - 1].body.system[0].text, /The manager's tactic/);
    fs.writeFileSync(tacticFile, 'name: Test Press\nformation: 4-3-3\npriority: pace\nGK = Goalkeeper\nDM-DC = Defensive Midfielder / Centre-Back\n');
    try {
      const s = JSON.parse((await request(port, 'GET', '/api/state')).text);
      assert.strictEqual(s.tactic.name, 'Test Press');
      assert.deepStrictEqual(s.tactic.priority, ['pace']);
      assert.strictEqual(s.tactic.slots[1], '2. DM→DC: Defensive Midfielder / Centre-Back [DM, FM24 equivalent] [CB, FM24 equivalent]');
      assert.match(s.tactic.rating, /FM role attributes 40%/);
      assert.ok(s.tactic.problems.some(p => /11/.test(p)));
      assert.match((await request(port, 'GET', '/api/briefing')).text, /## YOUR TACTIC\nTactic "Test Press"/);
      await request(port, 'POST', '/api/chat', { messages: [{ role: 'user', content: 'Who fits?' }] });
      assert.match(seen[seen.length - 1].body.system[0].text, /# The manager's tactic/);
    } finally { fs.unlinkSync(tacticFile); }
  });

  await t.test('the Director can search the player database mid-answer', async () => {
    const { db } = require('./dbfixture').dbFixture();
    fs.writeFileSync(path.join(dataDir, 'players-db.json'), JSON.stringify(db));
    const before = seen.length;
    const r = await request(port, 'POST', '/api/chat', { messages: [{ role: 'user', content: 'Find me a starting striker.' }] });
    const events = sse(r.text);
    assert.ok(events.some(e => e.type === 'tool' && /Searching the player database: ST, starter/.test(e.text)));
    const text = events.filter(e => e.type === 'text').map(e => e.text).join('');
    assert.match(text, /^Let me check the database\.\n\nTop pick: 1\. Other Player \d+ \(\d+, ST\)/);
    // two API calls: the question, then the tool result
    assert.strictEqual(seen.length - before, 2);
    const second = seen[seen.length - 1].body;
    assert.ok(second.tools.some(t => t.name === 'search_players' && t.eager_input_streaming === true));
    const toolResult = second.messages[second.messages.length - 1].content[0];
    assert.strictEqual(toolResult.tool_use_id, 'toolu_1');
    assert.match(toolResult.content, /Our current options there: Main Striker rating \d+\.\d as ST/);
    assert.match(second.system[0].text, /search the whole player database/);
  });

  await t.test('realism setting changes what the Director sees', async () => {
    const everything = JSON.parse((await request(port, 'POST', '/api/settings', { visibility: 'everything' })).text);
    assert.strictEqual(everything.visibility, 'everything');
    assert.match((await request(port, 'GET', '/api/briefing')).text, /## BEST XI BY CA/);
    await request(port, 'POST', '/api/chat', { messages: [{ role: 'user', content: 'Verdict?' }] });
    assert.match(seen[seen.length - 1].body.system[0].text, /You see everything: true current ability/);
    const saved = JSON.parse((await request(port, 'POST', '/api/settings', { visibility: 'scouted', judging: 6, effort: 'low' })).text);
    assert.strictEqual(saved.visibility, 'scouted');
    assert.ok((await request(port, 'GET', '/api/briefing')).text.includes('REALISM ON'));
    await request(port, 'POST', '/api/chat', { messages: [{ role: 'user', content: 'Verdict?' }] });
    const call = seen[seen.length - 1];
    assert.match(call.body.system[0].text, /Realism mode: abilities/);
    assert.ok(call.body.system[1].text.includes('REALISM ON'));
    assert.strictEqual(call.body.output_config.effort, 'low');
  });

  await t.test('history is cleaned (must start with the user, junk dropped)', async () => {
    await request(port, 'POST', '/api/chat', { messages: [{ role: 'assistant', content: 'hello' }, { role: 'system', content: 'evil' }, { role: 'user', content: 'Q1' }] });
    const msgs = seen[seen.length - 1].body.messages;
    assert.deepStrictEqual(msgs, [{ role: 'user', content: 'Q1' }]);
  });

  await t.test('refresh writes request.flag and waits for the plugin', async () => {
    const statusFile = path.join(dataDir, 'status.json');
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'ok', timestamp: '2027-01-01T00:00:00' }));
    const fakePlugin = setInterval(() => {
      const flag = path.join(dataDir, 'request.flag');
      if (fs.existsSync(flag)) { fs.unlinkSync(flag); fs.writeFileSync(statusFile, JSON.stringify({ state: 'ok', timestamp: '2027-01-01T00:00:09', message: 'Dumped' })); }
    }, 100);
    const r = JSON.parse((await request(port, 'POST', '/api/refresh', {})).text);
    clearInterval(fakePlugin);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status.timestamp, '2027-01-01T00:00:09');
  });

  await t.test('other websites are blocked', async () => {
    assert.strictEqual((await request(port, 'GET', '/api/state', null, { Host: 'evil.example:8766' })).status, 403);
    assert.strictEqual((await request(port, 'POST', '/api/settings', { visibility: 'everything' }, { Origin: 'https://evil.example' })).status, 403);
    const form = await request(port, 'POST', '/api/chat', null, { 'Content-Type': 'text/plain' });
    assert.strictEqual(form.status, 403);
  });
});

test('bad API key gives a clear message', async t => {
  const api = await startFakeApi();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truedof-app-'));
  fs.writeFileSync(path.join(dataDir, 'dump-latest.json'), JSON.stringify(fixture()));
  const port = 19866 + Math.floor(Math.random() * 1000);
  const app = await startApp(port, api.address().port, dataDir, 'bad');
  t.after(() => { app.kill(); api.close(); });
  const r = await request(port, 'POST', '/api/chat', { messages: [{ role: 'user', content: 'Hi' }] });
  const err = sse(r.text).find(e => e.type === 'error');
  assert.ok(err, 'expected an error event');
  assert.match(err.message, /API key was rejected/);
});
