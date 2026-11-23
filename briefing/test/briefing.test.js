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

test('squad status vs best XI is flagged', () => {
  const d = fixture();
  const bench = d.squad.find(p => p.name === 'Bench Mid');
  bench.contract.squadStatus = 'Star Player'; bench.contract.squadStatusGroup = 'key player';
  const text = buildBriefing(d);
  assert.ok(text.includes('Bench Mid has squad status "Star Player" but is not in the best XI'));
});

test('shortlist shows loans and arranged transfers', () => {
  const d = fixture();
  d.shortlist[0].onLoanAt = 'FC Barcelona'; d.shortlist[0].loanEnds = '2027-06-30';
  d.transfers.push({ playerUid: d.shortlist[0].uid, player: 'Target Striker', from: 'Rival FC', to: 'Big Club', status: 'arranged', date: '2027-07-01', involves: 'shortlist' });
  const text = buildBriefing(d);
  assert.ok(text.includes('(Rival FC, on loan at FC Barcelona until 2027-06-30)'));
  assert.ok(text.includes('ALREADY ARRANGED: moving to Big Club on 2027-07-01'));
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
  d.club = { name: 'X' }; d.shortlist = []; d.shortlistNotFound = [];
  d.shortlistStatus = "shortlist.txt: 0 player line(s) read. 3 line(s) start with # and were IGNORED"; d.meta = {}; d.leagueTable = undefined;
  d.squad.forEach(p => { delete p.morale; p.contract = null; });
  const text = buildBriefing(d);
  assert.ok(text.includes('Shortlist is empty') && text.includes('IGNORED'));
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

// ---------------------------------------------------------------- realism
const { perceive } = require('../realism');

test('realism: true value always inside the range, wider when judging is worse', () => {
  const d = fixture();
  for (const J of [1, 5, 10, 15, 20]) {
    const v = perceive(d, J);
    v.squad.forEach((p, i) => {
      const t = d.squad[i];
      assert.ok(p.caRange[0] <= t.ca && t.ca <= p.caRange[1], `CA outside range at J${J}`);
      assert.ok(p.paRange[0] <= t.pa && t.pa <= p.paRange[1], `PA outside range at J${J}`);
      for (const [k, r] of Object.entries(p.attrRanges)) {
        const tv = t.technical[k] ?? t.mental[k] ?? t.physical[k] ?? t.goalkeeping[k];
        assert.ok(r[0] <= tv && tv <= r[1], `${k} outside range at J${J}`);
      }
    });
  }
  const width = J => { const v = perceive(d, J); return v.shortlist.reduce((t, p) => t + p.caRange[1] - p.caRange[0], 0); };
  assert.ok(width(3) > width(12) && width(12) > width(19));
});

test('realism: estimates are stable (no re-rolling) and own players are clearer', () => {
  const d = fixture();
  assert.deepStrictEqual(perceive(d, 8).shortlist[0].caRange, perceive(d, 8).shortlist[0].caRange);
  const v = perceive(d, 6);
  const ownW = v.squad[0].caRange[1] - v.squad[0].caRange[0];
  const otherW = v.shortlist[0].caRange[1] - v.shortlist[0].caRange[0];
  assert.ok(ownW < otherW);
});

test('realism: low judging hides hidden attributes; facts are untouched; briefing shows ranges', () => {
  const d = fixture();
  const v = perceive(d, 4);
  assert.strictEqual(v.shortlist[0].hidden, undefined);
  assert.strictEqual(v.shortlist[0].personality, undefined);
  assert.strictEqual(v.squad[0].contract.wageWeekly, d.squad[0].contract.wageWeekly);
  assert.strictEqual(v.squad[0].age, d.squad[0].age);
  assert.strictEqual(d.squad[0].caRange, undefined, 'original dump must not be modified');
  const text = buildBriefing(v);
  assert.ok(text.includes('REALISM ON'));
  assert.ok(/CA\d+-\d+ (weak|average|decent|good|very good|excellent|world class)/.test(text));
  assert.ok(estimateTokens(text) <= 3000);
});

// ---------------------------------------------------------------- attributes-only view
const { fmView } = require('../realism');
const { ratingAt, dumpGetter } = require('../ratings');

test('attributes-only view: ratings instead of CA, no PA, no hidden attributes', () => {
  const d = fixture();
  const v = fmView(d);
  const text = buildBriefing(v);
  assert.match(text, /VIEW: like the manager in FM with attribute masking off/);
  assert.match(text, /## BEST XI BY POSITION RATING: .*\(avg rating \d+\.\d\)/);
  assert.match(text, /## PROMISING YOUTH/);
  assert.ok(!/\bCA\d|\bPA\d|CA ~?\d/.test(text), 'no CA/PA numbers may appear');
  assert.ok(!/inconsistent|big games|injury-prone/.test(text), 'hidden attributes must not leak');
  const atakan = v.squad.find(p => p.name === 'Atakan Ordu');
  assert.strictEqual(atakan.caText, ratingAt(dumpGetter(d.squad[0]), 'GK').toFixed(1));
  assert.strictEqual(d.squad[0].pa, 129, 'original dump must not be modified');
  assert.ok(estimateTokens(text) <= 3000);
});

test('league table: every team listed, ours marked, gaps and home/away summary', () => {
  const rec = (w, d, l, gf, ga) => ({ played: w + d + l, won: w, drawn: d, lost: l, goalsFor: gf, goalsAgainst: ga, points: 3 * w + d });
  const row = (position, club, isUs, home, away) => ({
    position, club, isUs, home, away, played: home.played + away.played, won: home.won + away.won, drawn: home.drawn + away.drawn,
    lost: home.lost + away.lost, goalsFor: home.goalsFor + away.goalsFor, goalsAgainst: home.goalsAgainst + away.goalsAgainst,
    goalDifference: home.goalsFor + away.goalsFor - home.goalsAgainst - away.goalsAgainst, points: home.points + away.points,
  });
  const lt = { mapped: true, competition: 'Test Lig', rows: [
    row(1, 'Leaders FC', false, rec(2, 0, 0, 5, 1), rec(1, 1, 0, 3, 2)),
    row(2, 'Us United', true, rec(2, 0, 0, 4, 0), rec(0, 1, 1, 1, 3)),
    row(3, 'Third Town', false, rec(1, 0, 1, 2, 2), rec(0, 0, 2, 0, 4)),
  ] };
  const lines = require('../briefing').leagueTableLines(lt);
  assert.match(lines[0], /LEAGUE TABLE: Test Lig/);
  assert.strictEqual(lines.filter(l => /^\s*\d+\. |^>>/.test(l)).length, 3);
  assert.match(lines[2], /^>> 2\. Us United 4 2 1 1 5-3 \+2 7$/);
  const you = lines[lines.length - 1];
  assert.match(you, /You: 2\. of 3, 7 pts, 3 pts behind the leader, 4 ahead of Third Town \(3\.\)/);
  assert.match(you, /Home 2-0-0 \(4-0, 6 pts\), away 0-1-1 \(1-3, 1 pts\)/);
  assert.ok(!you.includes('About'), 'all 4 games played: no games-left note');

  const d = fixture(); d.leagueTable = lt;
  assert.ok(buildBriefing(d).includes('>> 2. Us United'));
  d.leagueTable = { mapped: false, note: 'reason here', rows: [] };
  assert.ok(buildBriefing(d).includes('League table: not available (reason here)'));
});
