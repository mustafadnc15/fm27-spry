'use strict';
// A made-up players-db.json (same format the plugin writes): our squad from the briefing fixture,
// plus ~300 players at other clubs with varied positions, levels, prices and contracts.
const { fixture } = require('../../briefing/test/fixture');

const POS = ['GK', 'SW', 'DL', 'DC', 'DR', 'DM', 'ML', 'MC', 'MR', 'AML', 'AMC', 'AMR', 'ST', 'WBL', 'WBR'];

function dbFixture() {
  const dump = fixture();
  const attrKeys = [...Object.keys(dump.squad[0].technical), ...Object.keys(dump.squad[0].mental), ...Object.keys(dump.squad[0].physical), ...Object.keys(dump.squad[0].goalkeeping)];
  const attrGroups = [...Object.keys(dump.squad[0].technical).map(() => 'technical'), ...Object.keys(dump.squad[0].mental).map(() => 'mental'),
    ...Object.keys(dump.squad[0].physical).map(() => 'physical'), ...Object.keys(dump.squad[0].goalkeeping).map(() => 'goalkeeping')];
  const hiddenKeys = ['consistency', 'dirtiness', 'importantMatches', 'injuryProneness', 'versatility'];
  const personalityKeys = ['adaptability', 'ambition', 'loyalty', 'pressure', 'professionalism', 'sportsmanship', 'temperament', 'controversy'];

  const toRow = (p, club) => ({
    id: p.uid, n: p.name, a: p.age, nat: p.nationality, c: club, lg: club ? 'Trendyol 1. Lig' : undefined, ca: p.ca, pa: p.pa,
    pos: p.naturalPositions.join('/'), acc: p.accomplishedPositions.join('/') || undefined,
    pr: POS.map(k => p.positionRatings[k] || 1),
    at: attrKeys.map((k, i) => p[attrGroups[i]][k] || 1),
    hd: hiddenKeys.map(k => p.hidden[k] || 1), ps: personalityKeys.map(k => p.personality[k] || 1),
    v: p.valueGbp, w: p.contract && p.contract.wageWeekly, x: p.contract && p.contract.expires,
  });

  const players = dump.squad.map(p => toRow(p, dump.club.name));

  // Other clubs: deterministic spread of positions / abilities / prices
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const r = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const outfield = ['DC', 'DL', 'DR', 'DM', 'MC', 'AMC', 'AML', 'AMR', 'ST'];
  for (let i = 0; i < 300; i++) {
    const main = i % 25 === 0 ? 'GK' : outfield[i % outfield.length];
    const ca = r(80, 170);
    const lvl = Math.round(ca / 10);
    const pr = POS.map(k => (k === main ? 20 : 1));
    const at = attrKeys.map((k, j) => Math.max(1, Math.min(20, lvl + r(-4, 4) + (attrGroups[j] === 'goalkeeping' && main !== 'GK' ? -8 : 0))));
    const free = i % 40 === 3;
    players.push({
      id: 100000 + i, n: `Other Player ${i}`, a: r(17, 34), nat: i % 3 ? 'Turkey' : 'Brazil', c: free ? undefined : `Club ${i % 20}`,
      lg: free ? undefined : (i % 2 ? 'Trendyol Süper Lig' : 'Trendyol 1. Lig'), ca, pa: Math.min(200, ca + r(0, 30)),
      pos: main, pr, at, hd: hiddenKeys.map(() => r(3, 17)), ps: personalityKeys.map(() => r(3, 18)),
      v: free ? undefined : ca * ca * 40, w: ca * 30, x: i % 10 === 5 ? '2027-06-30' : '2029-06-30', tl: i % 13 === 0 ? 1 : undefined,
    });
  }
  // A near-copy of our main striker at another club, cheap: the "similar players" test looks for him.
  const ms = players.find(p => p.n === 'Main Striker');
  players.push({ ...ms, id: 999001, n: 'Striker Twin', c: 'Club 5', lg: 'Trendyol 1. Lig', a: 23, v: 20000, at: ms.at.map(v => Math.max(1, v - 1)), ca: ms.ca - 4 });

  return {
    dump,
    db: { meta: { generatedAt: '2026-11-23T02:23:56', gameDate: dump.meta.gameDate, currency: 'GBP', attrKeys, attrGroups, hiddenKeys, personalityKeys, positionKeys: POS }, players },
  };
}

module.exports = { dbFixture };
