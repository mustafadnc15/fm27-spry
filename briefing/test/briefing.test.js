'use strict';
// Run: node --test briefing/test
const test = require('node:test');
const assert = require('node:assert');
const { buildBriefing, bestXI, estimateTokens, money } = require('../briefing');
const { fixture } = require('./fixture');

test('briefing has every section and stays under 3,000 tokens', () => {
  const text = buildBriefing(fixture());
  for (const s of ['## FINANCES', '## BEST XI', '## DEPTH', '## WEAK SPOTS', '## CONTRACTS EXPIRING', '## WAGE STRUCTURE',
                   '## HIGH-POTENTIAL YOUTH', '## SHORTLIST', '## FULL SQUAD'])
    assert.ok(text.includes(s), `missing ${s}`);
  assert.ok(estimateTokens(text) <= 3000, `too long: ${estimateTokens(text)} tokens`);
});

test('best XI: 11 different players, a real goalkeeper, best CB picked', () => {
  const d = fixture();
  const xi = bestXI(d.squad.filter(p => p.teamType === 0));
  const ps = xi.slots.map(s => s.p).filter(Boolean);
  assert.strictEqual(ps.length, 11);
  assert.strictEqual(new Set(ps.map(p => p.uid)).size, 11);
  assert.strictEqual(xi.slots[0].slot, 'GK');
  assert.strictEqual(xi.slots[0].p.name, 'Atakan Ordu');
  assert.ok(ps.some(p => p.name === 'Emirhan Topçu'));
});

test('loaned-out and youth players are not in the XI', () => {
  const text = buildBriefing(fixture());
  const xiBlock = text.split('## BEST XI')[1].split('## DEPTH')[0];
  assert.ok(!xiBlock.includes('Loanee Out'));
  assert.ok(!xiBlock.includes('Wonderkid Striker'));
});

test('contracts, youth, wages, morale', () => {
  const text = buildBriefing(fixture());
  const contracts = text.split('## CONTRACTS EXPIRING')[1].split('##')[0];
  assert.ok(contracts.includes('Old Stopper') && contracts.includes('pre-contract'));
  assert.ok(contracts.includes('Main Striker'));
  assert.ok(!contracts.includes('Atakan Ordu'));
  const youth = text.split('## HIGH-POTENTIAL YOUTH')[1].split('##')[0];
  assert.ok(youth.includes('Wonderkid Striker') && youth.includes('low professionalism'));
  assert.ok(youth.includes('Aldivan'));
  assert.ok(text.includes('Bora Göymen 6 (Fairly Poor)'));
  assert.ok(!/low \(senior players\):[^\n]*Reserve/.test(text), 'reserves should not crowd the morale line');
  assert.ok(text.includes('headroom'));
});

test('shortlist verdict inputs', () => {
  const text = buildBriefing(fixture());
  const sl = text.split('## SHORTLIST')[1];
  assert.ok(/Target Striker[\s\S]*UPGRADE/.test(sl));
  assert.ok(/Target Striker[\s\S]*over budget/.test(sl));
  assert.ok(/Cheap Fullback[\s\S]*affordable/.test(sl));
  assert.ok(sl.includes('not found: "Nobody Here"'));
});

test('copes with missing data (old dump, no finances, empty shortlist)', () => {
  const d = fixture();
  d.club = { name: 'X' }; d.shortlist = []; d.meta = {}; d.leagueTable = undefined;
  d.squad.forEach(p => { delete p.morale; p.contract = null; });
  const text = buildBriefing(d);
  assert.ok(text.includes('Shortlist is empty'));
  assert.ok(text.includes('Balance ?'));
});

test('money formatting', () => {
  assert.strictEqual(money(2561896), '£2.56M');
  assert.strictEqual(money(40086), '£40K');
  assert.strictEqual(money(6545), '£6.5K');
  assert.strictEqual(money(-1250000), '-£1.25M');
  assert.strictEqual(money(null), '?');
});

test('very large squads are trimmed to the token budget', () => {
  const d = fixture();
  for (let i = 0; i < 250; i++) d.squad.push({ ...d.squad[30], uid: 90000 + i, name: `Extra ${i}` });
  const text = buildBriefing(d);
  assert.ok(estimateTokens(text) <= 3000);
  assert.ok(text.includes('shown)'));
});
