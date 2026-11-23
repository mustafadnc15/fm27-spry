'use strict';
// Browser side of the Director chat. The conversation is kept in this browser (localStorage)
// and sent to the local server with each question.

const $ = id => document.getElementById(id);
const chatEl = $('chat'), input = $('input'), sendBtn = $('sendBtn');
const STORE = 'truedof-chat-v1';
let history = load();
let busy = false;

function load() { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } }
function save() { try { localStorage.setItem(STORE, JSON.stringify(history.slice(-60))); } catch { /* private mode: fine */ } }

// --- tiny, safe markdown: escape everything first, then add bold, code, headings and bullets
function esc(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function md(text) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = []; let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/) || line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet) { if (!list) { list = []; } list.push(`<li>${inline(bullet[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) out.push(`<h3>${inline(h[1])}</h3>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

function bubble(role, text, extraClass = '') {
  const div = document.createElement('div');
  div.className = `msg ${role} ${extraClass}`.trim();
  if (role === 'user') div.textContent = text; else div.innerHTML = md(text);
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function render() {
  chatEl.innerHTML = '';
  if (!history.length) bubble('assistant', "I've got the squad file in front of me. Ask me about weak spots, contracts, youngsters, or give me a transfer target and I'll tell you straight whether we should sign him.");
  history.forEach(m => bubble(m.role, m.content));
  $('starters').classList.toggle('hidden', history.length > 0);
}

function notice(text) {
  const n = $('notice');
  n.textContent = text || '';
  n.classList.toggle('hidden', !text);
}

async function refreshState() {
  try {
    const s = await (await fetch('/api/state')).json();
    const d = s.dump;
    $('clubline').textContent = d
      ? `${d.club || '?'} · ${d.league || ''} · game date ${d.gameDate || '?'} · data from ${String(d.generatedAt || '').replace('T', ' ')} · ${viewLabel(s.settings)}`
      : 'No game data yet: load your save in FM27 and press F8.';
    const warn = [];
    if (!s.hasKey) warn.push('No Anthropic API key found. Copy .env.example to .env, put your key in it, and restart the app.');
    if (s.status && s.status.state === 'error') warn.push('Last FM dump failed: ' + s.status.message);
    notice(warn.join(' '));
    return s;
  } catch {
    notice('Lost connection to the TrueDoF app. Is the window running it still open?');
  }
}

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true; sendBtn.disabled = true;
  history.push({ role: 'user', content: text.trim() });
  save(); render();
  const reply = bubble('assistant', 'Thinking…', 'thinking');
  let answer = '', failed = '';
  const tools = [];   // little "Searching the database…" notes shown while he works
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!chunk.startsWith('data: ')) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.type === 'text') { answer += ev.text; reply.classList.remove('thinking'); reply.innerHTML = md(answer); chatEl.scrollTop = chatEl.scrollHeight; }
        else if (ev.type === 'tool') {
          const t = document.createElement('div'); t.className = 'tool-note'; t.textContent = ev.text + '…';
          reply.after(t); tools.push(t);
          if (!answer) { reply.textContent = 'Thinking…'; }
          chatEl.scrollTop = chatEl.scrollHeight;
        }
        else if (ev.type === 'error') failed = ev.message;
      }
    }
  } catch (e) {
    failed = 'Could not reach the TrueDoF app: ' + e.message;
  }
  tools.forEach(t => t.remove());
  if (answer) history.push({ role: 'assistant', content: answer });
  else history.pop();   // nothing came back: drop the question so the conversation stays valid
  save();
  if (!answer) reply.remove();
  if (failed) bubble('assistant', failed, 'error');
  if (!answer) { input.value = text; }   // let the user retry
  busy = false; sendBtn.disabled = false;
  input.focus();
}

$('composer').addEventListener('submit', e => { e.preventDefault(); const t = input.value; input.value = ''; send(t); });
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); } });
$('starters').addEventListener('click', e => { if (e.target.tagName === 'BUTTON') send(e.target.textContent); });
$('newBtn').addEventListener('click', () => { if (busy) return; history = []; save(); render(); });

$('refreshBtn').addEventListener('click', async () => {
  const b = $('refreshBtn'); b.disabled = true; b.textContent = 'Waiting for FM…';
  try {
    const r = await (await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    if (!r.ok) notice(r.message || ('FM dump failed: ' + (r.status && r.status.message)));
    else await refreshState();
  } catch { notice('Refresh failed: lost connection to the TrueDoF app.'); }
  b.disabled = false; b.textContent = 'Refresh from FM';
});

$('briefingBtn').addEventListener('click', async () => {
  const [text, s] = await Promise.all([fetch('/api/briefing').then(r => r.text()), refreshState()]);
  $('briefingText').textContent = text;
  $('briefingMeta').textContent = s ? `About ${s.briefingTokens} tokens, sent with every question; view: ${viewLabel(s.settings)}.` : '';
  $('briefingDlg').showModal();
});

$('settingsBtn').addEventListener('click', async () => {
  const s = await refreshState(); if (!s) return;
  document.querySelectorAll('input[name=visibility]').forEach(r => { r.checked = r.value === s.settings.visibility; });
  syncJudging();
  $('judging').value = s.settings.judging; $('judgingVal').textContent = s.settings.judging;
  $('effort').value = s.settings.effort;
  $('philosophy').value = s.settings.philosophy;
  $('tacticText').textContent = tacticText(s.tactic, s.dataDir);
  $('settingsDlg').showModal();
});
function tacticText(t, dir) {
  if (!t) return `No tactic yet. Create tactic.txt in ${dir} to describe it.`;
  const f = t.formation || {};
  return [
    `${t.name || 'Unnamed tactic'}  (${f.inPossession || '?'} with the ball, ${f.outOfPossession || '?'} without)`,
    `Style: ${t.style || 'not set'}`,
    `Priority attributes: ${(t.priority || []).join(', ') || 'none'}`,
    '', ...(t.slots || []),
    '', `Attribute guide (wanted-player-attributes.txt): ${t.hasWantedAttributes ? 'loaded' : 'not found'}`,
    ...((t.problems || []).length ? ['', 'Problems in the file:', ...t.problems.map(p => '- ' + p)] : []),
  ].join('\n');
}
function viewLabel(s) {
  return s.visibility === 'everything' ? 'sees everything (CA/PA)' : s.visibility === 'scouted' ? `scouted estimates (judging ${s.judging}/20)` : 'sees what you see in FM';
}
function syncJudging() {
  const scouted = (document.querySelector('input[name=visibility]:checked') || {}).value === 'scouted';
  $('judgingRow').classList.toggle('disabled', !scouted);
  $('judging').disabled = !scouted;
}
document.querySelectorAll('input[name=visibility]').forEach(r => r.addEventListener('change', syncJudging));
$('judging').addEventListener('input', () => { $('judgingVal').textContent = $('judging').value; });
$('settingsDlg').addEventListener('close', async () => {
  if ($('settingsDlg').returnValue !== 'save') return;
  await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibility: (document.querySelector('input[name=visibility]:checked') || {}).value, judging: Number($('judging').value), effort: $('effort').value, philosophy: $('philosophy').value }),
  });
  refreshState();
});

render();
refreshState();
input.focus();
