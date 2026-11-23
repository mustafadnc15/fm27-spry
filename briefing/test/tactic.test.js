'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTactic, readTactic, tacticLines, normalisePosition, normaliseAttribute } = require('../tactic');
const { buildBriefing, estimateTokens } = require('../briefing');
const { fixture } = require('./fixture');

// The manager's real file, as written for "ZaZ - Ace of Diamonds 2.0".
const ZAZ = `name: ZaZ - Ace of Diamonds 2.0
formation: 4-1-2-3-0 / 5-2-0-3-0
style: (e.g. Gegenpress / Vertical tiki-taka)
priority: pace, acceleration

GK-GK  = Ball-Playing Goalkeeper / Sweeper Keeper
DL-DL  = Full Back / Full Back
DC-DC  = Ball-Playing Centre-Back / Centre-Back
DC-DC  = Ball-Playing Centre-Back / Centre-Back
DR-DR  = Full Back / Full Back
DM-DC  = Defensive Midfielder / Centre-Back
MC-DM  = Attacking Midfielder / Defensive Midfielder
MC-DM  = Attacking Midfielder / Defensive Midfielder
AM(C)-AM(R)  = Second Striker / Winger
AM(C)-AM(C)  = Second Striker / Attacking Midfielder
AM(C)-AM(L)  = Second Striker / Winger
`;

test('parses the ZaZ tactic file: header, 11 slots, both phases', () => {
  const t = parseTactic(ZAZ);
  assert.deepStrictEqual(t.problems, []);
  assert.strictEqual(t.name, 'ZaZ - Ace of Diamonds 2.0');
  assert.deepStrictEqual(t.formation, { inPossession: '4-1-2-3-0', outOfPossession: '5-2-0-3-0' });
  assert.strictEqual(t.style, null, 'the "(e.g. …)" template hint is not a real style');
  assert.deepStrictEqual(t.priority, ['pace', 'acceleration']);
  assert.strictEqual(t.slots.length, 11);
  assert.deepStrictEqual(t.slots[5], {
    inPossession: { position: 'DM', role: 'Defensive Midfielder', duty: null },
    outOfPossession: { position: 'DC', role: 'Centre-Back', duty: null },
  });
  assert.strictEqual(t.slots[8].inPossession.position, 'AMC');
  assert.strictEqual(t.slots[8].outOfPossession.position, 'AMR');
});

test('short forms: one position or one role means the same in both phases; duties in brackets', () => {
  const t = parseTactic('ST = Advanced Forward (Attack)\nCB = Centre-Back');
  assert.deepStrictEqual(t.slots[0].outOfPossession, { position: 'ST', role: 'Advanced Forward', duty: 'Attack' });
  assert.strictEqual(t.slots[1].inPossession.position, 'DC');
  assert.ok(t.problems.some(p => /11/.test(p)), 'warns that a tactic has 11 slots');
});

test('bad lines are reported, never fatal', () => {
  const t = parseTactic('priority: pace, telepathy\nXX-DC = Centre-Back\nhello there\n# a comment');
  assert.deepStrictEqual(t.priority, ['pace']);
  assert.strictEqual(t.slots.length, 0);
  assert.strictEqual(t.problems.length, 3);
});

test('names people actually write', () => {
  assert.strictEqual(normalisePosition('AM(C)'), 'AMC');
  assert.strictEqual(normalisePosition('wb(l)'), 'WBL');
  assert.strictEqual(normalisePosition('CB'), 'DC');
  assert.strictEqual(normalisePosition('banana'), null);
  assert.strictEqual(normaliseAttribute('Jump Reach'), 'jumpingReach');
  assert.strictEqual(normaliseAttribute('Work Rate'), 'workRate');
  assert.strictEqual(normaliseAttribute('Natural Fitness'), 'naturalFitness');
});

test('readTactic: no file → null; with files → tactic plus the attribute guide', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truedof-tactic-'));
  try {
    assert.strictEqual(readTactic(dir), null);
    fs.writeFileSync(path.join(dir, 'tactic.txt'), '﻿' + ZAZ.replace(/\n/g, '\r\n'));   // Notepad style: BOM + CRLF
    fs.writeFileSync(path.join(dir, 'wanted-player-attributes.txt'), 'Pace: 12-20++\r\nStamina: 12-20+\r\n');
    const t = readTactic(dir);
    assert.strictEqual(t.slots.length, 11);
    assert.deepStrictEqual(t.problems, []);
    assert.strictEqual(t.wantedAttributes, 'Pace: 12-20++\nStamina: 12-20+');
    const text = tacticLines(t).join('\n');
    assert.match(text, /6\. DM→DC: Defensive Midfielder \/ Centre-Back/);
    assert.match(text, /Pace: 12-20\+\+/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('briefing shows the tactic section, and the tactic does not squeeze the squad list', () => {
  const t = parseTactic(ZAZ);
  t.wantedAttributes = 'Pace: 12-20++';
  const plain = buildBriefing(fixture());
  const withTactic = buildBriefing(fixture(), { tactic: t });
  assert.match(plain, /## YOUR TACTIC\nNo tactic set/);
  assert.match(withTactic, /## YOUR TACTIC\nTactic "ZaZ - Ace of Diamonds 2.0"/);
  assert.match(withTactic, /Priority attributes .*: pace, acceleration/);
  const squadCount = s => s.split('## FULL SQUAD')[1].trim().split('\n').length;
  assert.strictEqual(squadCount(withTactic), squadCount(plain));
  assert.ok(estimateTokens(withTactic) <= 3000 + estimateTokens(tacticLines(t).join('\n')));
});
