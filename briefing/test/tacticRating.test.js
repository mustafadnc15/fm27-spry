'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTactic } = require('../tactic');
const { findRole, parseRoleOverrides } = require('../roles');
const T = require('../tacticRating');
const { buildBriefing } = require('../briefing');
const { fixture } = require('./fixture');

const GUIDE = `Priority: Pace, Acceleration and Stamina are by far the most effective attributes.
Minimum requirements: 6-12 in Work Rate, Anticipation, and Strength. These hurt a lot when below 6.
Special: Jumping Reach (especially for defenders).
Good to have: 6-12 in Balance, Concentration and Natural Fitness.
Pace: 12-20++
Acceleration: 12-20+
Stamina: 12-20+
Work Rate: 6-12
Anticipation: 6-20
Strength: 6-20
Jump Reach: 12-20*
Balance: 6-12
Concentration: 6-12
Natural Fitness: 6-12`;

// The shape of the manager's measured table (role-to-attribute.txt), shortened.
const ENGINE = `Results
Attribute\tTeam\tST\tAM\tWB\tCB\tDM
Acceleration †\t+0.34*\t+0.70*\t+0.30*\t+0.33*\t+0.34*\t+0.23*
Pace †\t+0.34*\t+0.90*\t+0.39*\t+0.40*\t+0.23*\t+0.11
Jumping Reach †\t+0.22*\t+0.73*\t+0.05\t+0.10*\t+0.35*\t+0.09
Pressure\t+0.06*\t+0.13*\t+0.01\t+0.05\t+0.08\t+0.07
Off The Ball\t-0.01\t-0.01\t-0.03\t+0.02\t-0.02\t-0.01
Marking\t-0.01\t+0.07\t-0.01\t-0.03\t-0.04\t+0.02`;

const TACTIC = `name: Test
priority: pace, acceleration
GK = Sweeper Keeper
DL = Full Back
DC = Ball-Playing Centre-Back / Centre-Back
DC = Ball-Playing Centre-Back / Centre-Back
DR = Full Back
DM-DC = Defensive Midfielder / Centre-Back
MC-DM = Attacking Midfielder / Defensive Midfielder
MC-DM = Attacking Midfielder / Defensive Midfielder
AM(C)-AM(R) = Second Striker / Winger
AM(C) = Second Striker / Attacking Midfielder
AM(C)-AM(L) = Second Striker / Winger`;

// A player as a getter: every attribute `base`, with some overrides.
const player = (base, over = {}) => k => (k in over ? over[k] : base);
const natural = () => 20;

test('roles: names, abbreviations and phases', () => {
  assert.strictEqual(findRole('Full Back', 'ip').abbr, 'FB');
  assert.strictEqual(findRole('ball-playing centre-back', 'ip').abbr, 'BCB');
  assert.strictEqual(findRole('Ball-Playing Defender', 'ip').abbr, 'BCB');
  assert.strictEqual(findRole('IF', 'ip').name, 'Inside Forward');
  assert.strictEqual(findRole('Second Striker', 'ip').basis, 'fm24');
  assert.strictEqual(findRole('Channel Midfielder', 'ip').basis, 'p4fm');
  assert.strictEqual(findRole('banana', 'ip'), null);
});

test('roles.txt overrides a role, and bad lines are reported', () => {
  const { overrides, problems } = parseRoleOverrides('Second Striker = key: Finishing, Pace | pref: Composure\nnonsense line\nWinger = key: telepathy');
  const ss = findRole('Second Striker', 'ip', overrides);
  assert.deepStrictEqual(ss.key, ['finishing', 'pace']);
  assert.deepStrictEqual(ss.pref, ['composure']);
  assert.strictEqual(ss.basis, 'file');
  assert.strictEqual(problems.length, 3);
});

test('the attribute guide becomes rules with the right kinds', () => {
  const rules = Object.fromEntries(T.parseGuide(GUIDE).map(r => [r.attr, r]));
  assert.strictEqual(rules.pace.kind, 'top');
  assert.strictEqual(rules.stamina.kind, 'priority');
  assert.strictEqual(rules.workRate.kind, 'minimum');
  assert.strictEqual(rules.jumpingReach.kind, 'special');
  assert.strictEqual(rules.balance.kind, 'good');
  assert.strictEqual(rules.anticipation.hi, 20);
});

test('curves: minimums hurt below the floor, special counts most above 12', () => {
  const min = { lo: 6, hi: 12, kind: 'minimum' }, sp = { lo: 12, hi: 20, kind: 'special' };
  assert.strictEqual(T.curve(min, 4), 2);          // 2 below the floor costs 4
  assert.strictEqual(T.curve(min, 10), 10);
  assert.ok(Math.abs(T.curve(min, 16) - 13.2) < 1e-9);   // above 12 counts 0.3
  assert.ok(T.curve(sp, 18) - T.curve(sp, 12) > 2 * (T.curve(sp, 12) - T.curve(sp, 6)));
});

test('engine table: only confirmed values, hidden attributes kept apart', () => {
  const e = T.parseEngineWeights(ENGINE);
  assert.deepStrictEqual(e.groups, ['ST', 'AM', 'WB', 'CB', 'DM']);
  assert.strictEqual(e.weights.ST.pace, 0.9);
  assert.strictEqual(e.weights.DM.pace, undefined, 'unconfirmed +0.11 is not used');
  assert.strictEqual(e.weights.ST.marking, undefined);
  assert.deepStrictEqual(e.hidden, ['Pressure']);
});

test('a slot mixes the tested groups: Second Striker at AMC is part ST, DM→DC is DM and CB', () => {
  const m = T.buildModel(parseTactic(TACTIC), {}, T.parseEngineWeights(ENGINE));
  const ss = m.slots[8], dmdc = m.slots[5];
  assert.ok(ss.engine.pace > 0.39 && ss.engine.pace < 0.9);
  assert.ok(Math.abs(dmdc.engine.acceleration - (0.23 + 0.34) / 2) < 1e-9);
  assert.deepStrictEqual(m.slots[0].engine, {}, 'goalkeepers: no engine weights');
  assert.strictEqual(m.roleWeight, 0.25);
});

test('tactic rating: a fast player beats a slow technician; out of position costs', () => {
  const t = parseTactic(TACTIC); t.wantedAttributes = GUIDE;
  const m = T.buildModel(t, {}, T.parseEngineWeights(ENGINE));
  const slot = m.slots[8];   // Second Striker / Winger
  const runner = T.rateSlot(m, slot, player(10, { pace: 18, acceleration: 18, stamina: 16 }), natural);
  const artist = T.rateSlot(m, slot, player(10, { finishing: 18, technique: 18, passing: 18, firstTouch: 18, dribbling: 18 }), natural);
  assert.ok(runner.score > artist.score, `${runner.score} vs ${artist.score}`);
  assert.ok(runner.goals > artist.goals);
  const stranger = T.rateSlot(m, slot, player(10, { pace: 18, acceleration: 18, stamina: 16 }), () => 12);
  assert.ok(stranger.score < runner.score && stranger.fit === 0.75);
  const keeperInAttack = T.rateSlot(m, slot, player(10), p => (p === 'GK' ? 20 : 1));
  assert.strictEqual(keeperInAttack.fit, 0);
});

test('resolveSlot: number, positions, role in the tactic, any role', () => {
  const m = T.buildModel(parseTactic(TACTIC));
  assert.strictEqual(T.resolveSlot(m, '6').label, 'DM→DC');
  assert.strictEqual(T.resolveSlot(m, 'DM-DC').index, 6);
  assert.strictEqual(T.resolveSlot(m, 'AM(C)-AM(L)').index, 11);
  assert.strictEqual(T.resolveSlot(m, 'Second Striker').index, 9);
  const inf = T.resolveSlot(m, 'IF');
  assert.strictEqual(inf.index, null);
  assert.deepStrictEqual(inf.anyOf, ['AML', 'AMR', 'ML', 'MR']);
  assert.strictEqual(T.resolveSlot(m, 'banana'), null);
});

test('best XI fills every slot with different players and swaps to the best total', () => {
  const m = T.buildModel(parseTactic(TACTIC), {}, T.parseEngineWeights(ENGINE));
  const d = fixture();
  const pool = d.squad.filter(p => p.teamType === 0 && !p.onLoanAt);
  const { dumpGetter } = require('../ratings');
  const xi = T.bestXI(m, pool.map(p => ({ id: p.uid, get: dumpGetter(p), prOf: k => (p.positionRatings || {})[k] || 0, ref: p })));
  const ids = xi.slots.filter(s => s.c).map(s => s.c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok((xi.slots[0].c.ref.naturalPositions || []).includes('GK'), 'a real goalkeeper in goal');
});

test('briefing with a tactic: tactic XI, requirements in weak spots, shortlist vs a slot', () => {
  const t = parseTactic(TACTIC); t.wantedAttributes = GUIDE;
  const m = T.buildModel(t, {}, T.parseEngineWeights(ENGINE));
  const text = buildBriefing(fixture(), { model: m });
  assert.match(text, /## BEST XI FOR YOUR TACTIC: Test \(avg tactic rating \d+\.\d\)/);
  assert.match(text, / 6\. DM→DC Defensive Midfielder \/ Centre-Back: \S/);
  assert.match(text, /eng [+-]\d/);
  assert.match(text, /Pac\d+ Acc\d+ Sta\d+ Jum\d+/);
  assert.match(text, /fit: best slot .* \(tactic \d+\.\d\) vs our /);
  assert.ok(!text.includes('## BEST XI BY'), 'generic XI replaced');
  // without a tactic, the old generic XI is still there
  assert.match(buildBriefing(fixture()), /## BEST XI BY CA/);
});
