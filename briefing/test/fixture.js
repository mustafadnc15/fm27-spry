'use strict';
// A made-up but realistic dump (same shape as the plugin's dump-latest.json), for tests.

const KEYS = Layout();
function Layout() {
  return {
    technical: ['corners', 'crossing', 'dribbling', 'finishing', 'firstTouch', 'freeKicks', 'heading', 'longShots', 'longThrows', 'marking', 'passing', 'penaltyTaking', 'tackling', 'technique'],
    mental: ['aggression', 'anticipation', 'bravery', 'composure', 'concentration', 'decisions', 'determination', 'flair', 'leadership', 'offTheBall', 'positioning', 'teamwork', 'vision', 'workRate'],
    physical: ['acceleration', 'agility', 'balance', 'jumpingReach', 'naturalFitness', 'pace', 'stamina', 'strength'],
    goalkeeping: ['aerialReach', 'commandOfArea', 'communication', 'eccentricity', 'handling', 'kicking', 'oneOnOnes', 'punching', 'reflexes', 'rushingOut', 'throwing'],
  };
}
const POS = ['GK', 'SW', 'DL', 'DC', 'DR', 'DM', 'ML', 'MC', 'MR', 'AML', 'AMC', 'AMR', 'ST', 'WBL', 'WBR'];

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const r = (a, b) => a + Math.floor(rnd() * (b - a + 1));

let uid = 5000;
function player(name, age, positions, ca, pa, wage, expires, extra = {}) {
  const ratings = {};
  POS.forEach(p => { ratings[p] = 1; });
  positions.forEach((p, i) => { ratings[p] = i === 0 ? 20 : 16; });
  const lvl = Math.round(ca / 10);
  const grp = keys => Object.fromEntries(keys.map(k => [k, Math.max(1, Math.min(20, lvl + r(-4, 4)))]));
  const gk = positions[0] === 'GK';
  return {
    uid: uid++, name, age, dateOfBirth: null, nationality: 'Testland', female: false, club: 'Eskişehirspor Kulübü',
    onLoanFrom: null, team: 'first team', teamType: 0, ca, pa,
    naturalPositions: [positions[0]], accomplishedPositions: positions.slice(1), positionRatings: ratings,
    technical: grp(KEYS.technical), mental: grp(KEYS.mental), physical: grp(KEYS.physical),
    goalkeeping: gk ? grp(KEYS.goalkeeping) : Object.fromEntries(KEYS.goalkeeping.map(k => [k, r(1, 4)])),
    hidden: { consistency: r(6, 16), dirtiness: r(3, 12), importantMatches: r(6, 16), injuryProneness: r(3, 14), versatility: r(5, 15) },
    personality: { adaptability: r(5, 18), ambition: r(5, 18), loyalty: r(5, 18), pressure: r(6, 18), professionalism: r(6, 18), sportsmanship: r(6, 18), temperament: r(6, 18), controversy: r(1, 10) },
    preferredFoot: 'right', heightCm: 180,
    contract: { wageWeekly: wage, expires, squadNumber: null, transferListed: false, loanListed: false, squadStatusCode: 4, squadStatus: 'fringe (code 4)', squadStatusGroup: 'fringe' },
    valueGbp: ca * 15000, askingPriceGbp: null, reputationCurrent: 2000, morale: r(8, 20), moraleLevel: 'x', notes: [],
    ...extra,
  };
}

function fixture() {
  seed = 42; uid = 5000;
  const squad = [
    player('Atakan Ordu', 23, ['GK'], 122, 129, 1269, '2029-06-30'),
    player('Bora Göymen', 30, ['GK'], 101, 104, 900, '2027-06-30', { morale: 6, moraleLevel: 'Fairly Poor' }),
    player('Emirhan Topçu', 28, ['DC'], 132, 140, 2141, '2030-06-30'),
    player('Fabio Andrea Ruggeri', 24, ['DC', 'DL'], 114, 145, 6545, '2031-06-30'),
    player('Darko Gyabi', 25, ['DC', 'MC'], 118, 142, 2141, '2030-06-30'),
    player('Old Stopper', 33, ['DC'], 108, 110, 5200, '2027-07-31', { hidden: { consistency: 7, dirtiness: 5, importantMatches: 12, injuryProneness: 15, versatility: 8 } }),
    player('Manu Romero', 19, ['DL', 'WBL'], 114, 131, 2393, '2030-06-30'),
    player('Right Back One', 26, ['DR', 'WBR'], 110, 115, 1800, '2028-06-30'),
    player('Dani Requena', 25, ['MC', 'DM'], 124, 153, 3696, '2030-06-30'),
    player('Holding Mid', 29, ['DM', 'MC'], 116, 118, 2500, '2027-05-31'),
    player('Box To Box', 27, ['MC'], 112, 118, 2000, '2028-06-30'),
    player('Aldivan', 20, ['MC', 'AMC'], 117, 170, 769, '2030-06-30', { personality: { adaptability: 12, ambition: 18, loyalty: 10, pressure: 12, professionalism: 18, sportsmanship: 12, temperament: 12, controversy: 2 } }),
    player('Playmaker Ten', 26, ['AMC', 'MC'], 115, 120, 3100, '2029-06-30'),
    player('Can Armando Güner', 21, ['AMR', 'MR'], 113, 132, 1654, '2030-06-30'),
    player('Left Winger', 24, ['AML', 'ML'], 111, 125, 1700, '2029-06-30'),
    player('Main Striker', 27, ['ST'], 125, 128, 7000, '2027-04-30'),
    player('Sub Striker', 31, ['ST'], 105, 106, 6800, '2028-06-30'),
    player('Wide Mid', 28, ['MR', 'ML'], 104, 108, 1500, '2028-06-30'),
    player('Utility Def', 27, ['DR', 'DC'], 102, 106, 1300, '2028-06-30'),
    player('Third Keeper', 35, ['GK'], 80, 82, 400, '2027-06-30'),
    player('Bench Mid', 30, ['MC'], 99, 101, 4800, '2028-06-30'),
    player('Wonderkid Striker', 17, ['ST'], 85, 165, 300, '2029-06-30', { team: 'youth', teamType: 10, personality: { adaptability: 10, ambition: 14, loyalty: 10, pressure: 10, professionalism: 6, sportsmanship: 10, temperament: 10, controversy: 4 } }),
    player('Youth Back', 18, ['DL'], 70, 120, 200, '2028-06-30', { team: 'youth', teamType: 10 }),
    player('Youth Mid', 18, ['MC'], 72, 110, 200, '2028-06-30', { team: 'youth', teamType: 10 }),
    player('Loanee Out', 22, ['ST'], 98, 140, 900, '2029-06-30', { team: null, teamType: null, notes: ['Under contract with you but not in any of your team lists: probably out on loan.'] }),
  ];
  for (let i = 0; i < 11; i++) squad.push(player(`Reserve ${i + 1}`, r(18, 23), [POS[[3, 7, 12, 2, 4][i % 5]]], r(75, 98), r(95, 130), r(200, 700), '2028-06-30', { team: 'reserves/B team', teamType: 3 }));

  const shortlist = [
    player('Target Striker', 24, ['ST'], 138, 150, 9000, '2027-05-31', { club: 'Rival FC', valueGbp: 3500000 }),
    player('Cheap Fullback', 29, ['DR', 'WBR'], 112, 113, 1500, '2028-06-30', { club: 'Small FC', valueGbp: 20000 }),
  ];
  shortlist[0].personality.professionalism = 17;

  const bill = squad.filter(p => !p.onLoanFrom).reduce((t, p) => t + p.contract.wageWeekly, 0);
  return {
    meta: { tool: 'TrueDoF', toolVersion: '0.1.2', host: 'plugin', generatedAt: '2026-11-23T02:23:56', gameDate: '2027-03-14',
      gameVersion: '27.1', layout: 'FM27', versionVerified: true, currency: 'GBP', manager: 'Mustafa Dinç', playersInDatabase: 52559 },
    club: { name: 'Eskişehirspor Kulübü', shortName: 'Eskişehirspor', league: 'Trendyol 1. Lig', reputation: 4200,
      balance: 2561896, transferBudget: 40086, wageBudgetWeekly: 60989, wageSpendWeekly: 58000, financesMapped: true,
      wageBillWeekly: bill, wageBillAnnual: bill * 52, contractedPlayers: squad.length, teams: [] },
    squad,
    leagueTable: { mapped: false, competition: 'Trendyol 1. Lig', rows: [] },
    shortlist,
    shortlistNotFound: [{ entry: 'Nobody Here', reason: 'no player with this name/ID' }],
    transfers: [{ playerUid: 1, player: 'Gone Guy', from: 'Eskişehirspor Kulübü', to: 'Rival FC', status: 'completed', date: '2027-01-10', involves: 'outgoing' }],
    notes: [],
  };
}

module.exports = { fixture };
