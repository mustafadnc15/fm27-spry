'use strict';
// Tests for the Director's database tools. Run: node --test server/test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlayerDatabase, expandPositions } = require('../database');
const { runTool, validate } = require('../tools');
const { dbFixture } = require('./dbfixture');

function setup(realism = false, judging = 12) {
  const { dump, db } = dbFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truedof-db-'));
  fs.writeFileSync(path.join(dir, 'players-db.json'), JSON.stringify(db));
  const database = new PlayerDatabase(path.join(dir, 'players-db.json'));
  const ctx = {
    ownClub: dump.club.name, today: dump.meta.gameDate, transferBudget: 2_000_000, wageHeadroom: 3000, topWage: 7000,
    realism, judging, dataDir: dir,
  };
  return { database, ctx, dir, db };
}

// Parse "CA 138" (or the low end of a realism range) and the club out of result lines
const lines = text => text.split('\n').filter(l => /^\d+\. /.test(l));
const caOf = l => Number(l.match(/CA (\d+)/)[1]);

test('positions accept common names', () => {
  assert.deepStrictEqual(expandPositions(['CB']), ['DC']);
  assert.deepStrictEqual(expandPositions(['LB']).sort(), ['DL', 'WBL']);
  assert.deepStrictEqual(expandPositions('striker'), ['ST']);
});

test('starter search: at or above our first choice, never our own players', () => {
  const { database, ctx } = setup();
  const r = runTool(database, 'search_players', { positions: ['ST'], role: 'starter', limit: 25 }, ctx);
  assert.strictEqual(r.isError, false);
  assert.match(r.text, /Our current options there: Main Striker CA 125/);
  const ls = lines(r.text);
  assert.ok(ls.length > 0);
  ls.forEach(l => { assert.ok(caOf(l) >= 122, l); assert.ok(!l.includes('Eskişehirspor')); });
});

test('backup search: around or a bit below our starter', () => {
  const { database, ctx } = setup();
  const ls = lines(runTool(database, 'search_players', { positions: ['ST'], role: 'backup', limit: 25 }, ctx).text);
  assert.ok(ls.length > 0);
  ls.forEach(l => assert.ok(caOf(l) <= 127 && caOf(l) >= 95, l));
});

test('affordable_only: fee within budget, or free / expiring contract', () => {
  const { database, ctx, db } = setup();
  const ls = lines(runTool(database, 'search_players', { positions: ['DC'], affordable_only: true, limit: 25 }, ctx).text);
  assert.ok(ls.length > 0);
  for (const l of ls) {
    const row = db.players.find(p => p.id === Number(l.match(/id (\d+)$/)[1]));
    const cheapRoute = !row.c || row.x === '2027-06-30';
    assert.ok(cheapRoute || (row.v ?? 0) <= 2_000_000, l);
    assert.ok(row.w <= 7000, l);
  }
});

test('other filters: age, free agents, sort by potential', () => {
  const { database, ctx } = setup();
  lines(runTool(database, 'search_players', { max_age: 21, limit: 25 }, ctx).text).forEach(l => assert.ok(Number(l.match(/\((\d+),/)[1]) <= 21, l));
  lines(runTool(database, 'search_players', { free_agents_only: true }, ctx).text).forEach(l => assert.match(l, /FREE AGENT/));
  assert.match(runTool(database, 'search_players', { sort_by: 'potential' }, ctx).text, /sorted by potential/);
});

test('similar players finds the near-copy first, and not the player himself', () => {
  const { database, ctx } = setup();
  const r = runTool(database, 'find_similar_players', { player: 'Main Striker' }, ctx);
  const ls = lines(r.text);
  assert.match(ls[0], /Striker Twin/);
  assert.ok(!ls.some(l => l.startsWith('1. Main Striker')));
  assert.match(r.text, /compared on finishing/);
});

test('profile shows everything; unknown names are explained', () => {
  const { database, ctx } = setup();
  const t = runTool(database, 'get_player_profile', { player: 'emirhan topcu' }, ctx).text;   // accents and case don't matter
  assert.match(t, /Emirhan Topçu/);
  assert.match(t, /technical: .*finishing \d+/);
  assert.match(t, /hidden: consistency/);
  assert.match(runTool(database, 'get_player_profile', { player: 'Nobody Atall' }, ctx).text, /No player called/);
});

test('realism: ranges instead of numbers, hidden attributes unknown at low judging', () => {
  const { database, ctx } = setup(true, 4);
  const s = runTool(database, 'search_players', { positions: ['ST'], limit: 5 }, ctx).text;
  lines(s).forEach(l => assert.match(l, /CA \d+-\d+ (weak|average|decent|good|very good|excellent|world class)/));
  const p = runTool(database, 'get_player_profile', { player: 'Other Player 8' }, ctx).text;
  assert.match(p, /hidden attributes: unknown/);
  assert.match(p, /finishing \d+-\d+/);
});

test('add_to_shortlist appends once', () => {
  const { database, ctx, dir } = setup();
  assert.match(runTool(database, 'add_to_shortlist', { player: '999001' }, ctx).text, /Added Striker Twin/);
  assert.match(runTool(database, 'add_to_shortlist', { player: 'Striker Twin' }, ctx).text, /already on the shortlist/);
  const text = fs.readFileSync(path.join(dir, 'shortlist.txt'), 'utf8');
  assert.strictEqual((text.match(/uid:999001/g) || []).length, 1);
});

test('bad tool input is refused, missing database is explained', () => {
  assert.match(validate('search_players', { min_ca: 'lots' }), /must be a number/);
  assert.match(validate('search_players', { role: 'captain' }), /must be one of/);
  assert.match(validate('find_similar_players', {}), /Missing "player"/);
  assert.match(validate('search_players', { hack: 1 }), /Unknown field/);
  const missing = new PlayerDatabase(path.join(os.tmpdir(), 'does-not-exist', 'players-db.json'));
  const r = runTool(missing, 'search_players', {}, {});
  assert.strictEqual(r.isError, true);
  assert.match(r.text, /press F8/);
});
