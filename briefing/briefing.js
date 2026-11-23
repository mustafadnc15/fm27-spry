'use strict';
const { KEY_ATTRS, styleGroup, dumpGetter, bestPosition } = require('./ratings');
const { tacticLines } = require('./tactic');
const { buildModel, rateSlot, bestXI: tacticXI, describeModel, memoryLines } = require('./tacticRating');
// TrueDoF briefing builder.
// Turns dump-latest.json into a compact text briefing (< ~3,000 tokens) for the AI Director.
// All football maths happens HERE, in plain code, so the AI receives facts it can't miscount.
// Zero dependencies: only Node.js built-ins.

// ---------------------------------------------------------------- positions & formations

// Position groups used for depth. "want" = how many decent options a squad should have.
const GROUPS = [
  { key: 'GK', label: 'GK', pos: ['GK'], want: 2 },
  { key: 'CB', label: 'CB', pos: ['DC'], want: 4 },
  { key: 'LB', label: 'LB/LWB', pos: ['DL', 'WBL'], want: 2 },
  { key: 'RB', label: 'RB/RWB', pos: ['DR', 'WBR'], want: 2 },
  { key: 'DM', label: 'DM', pos: ['DM'], want: 2 },
  { key: 'CM', label: 'CM', pos: ['MC'], want: 3 },
  { key: 'AM', label: 'AMC', pos: ['AMC'], want: 2 },
  { key: 'W', label: 'Wingers', pos: ['ML', 'MR', 'AML', 'AMR'], want: 3 },
  { key: 'ST', label: 'ST', pos: ['ST'], want: 3 },
];

// Each slot lists accepted positions; the first is the "proper" one, others cost 5%.
const FORMATIONS = {
  '4-2-3-1': [['GK'], ['DL', 'WBL'], ['DC'], ['DC'], ['DR', 'WBR'], ['DM', 'MC'], ['MC', 'DM'], ['AML', 'ML'], ['AMC'], ['AMR', 'MR'], ['ST']],
  '4-3-3': [['GK'], ['DL', 'WBL'], ['DC'], ['DC'], ['DR', 'WBR'], ['DM', 'MC'], ['MC'], ['MC'], ['AML', 'ML'], ['AMR', 'MR'], ['ST']],
  '4-4-2': [['GK'], ['DL', 'WBL'], ['DC'], ['DC'], ['DR', 'WBR'], ['ML', 'AML'], ['MC'], ['MC'], ['MR', 'AMR'], ['ST'], ['ST']],
  '3-5-2': [['GK'], ['DC'], ['DC'], ['DC'], ['WBL', 'DL', 'ML'], ['WBR', 'DR', 'MR'], ['DM', 'MC'], ['MC'], ['MC', 'AMC'], ['ST'], ['ST']],
};

const ACCOMPLISHED = 15; // FM: 15-19 accomplished, 20 natural

// How well a player fits a set of positions: 1.0 natural, down to 0 (can't play there).
function fit(p, positions) {
  let best = 0;
  positions.forEach((pos, i) => {
    const r = (p.positionRatings || {})[pos] || 0;
    let f = r >= 20 ? 1 : r >= 18 ? 0.97 : r >= ACCOMPLISHED ? 0.9 : 0;
    if (i > 0) f *= 0.95;
    best = Math.max(best, f);
  });
  return best;
}

// Fallback fit when nobody is accomplished: "can do a job" (rating 10-14).
function fallbackFit(p, positions) {
  return Math.max(...positions.map(pos => {
    const r = (p.positionRatings || {})[pos] || 0;
    return r >= 10 ? 0.75 : 0;
  }));
}

function bestXI(players) {
  let best = null;
  for (const [name, slots] of Object.entries(FORMATIONS)) {
    // Greedy matching: take the best (slot, player) score first, then the next free pair, …
    const pairs = [];
    slots.forEach((s, si) => players.forEach(p => {
      const f = fit(p, s);
      if (f > 0) pairs.push({ si, p, score: p.ca * f, outOfPosition: false });
    }));
    pairs.sort((a, b) => b.score - a.score);
    const taken = new Set(), filled = new Array(slots.length).fill(null);
    for (const pr of pairs) {
      if (filled[pr.si] || taken.has(pr.p.uid)) continue;
      filled[pr.si] = pr; taken.add(pr.p.uid);
    }
    // Empty slots: someone who can at least do a job there.
    slots.forEach((s, si) => {
      if (filled[si]) return;
      const cand = players.filter(p => !taken.has(p.uid))
        .map(p => ({ si, p, score: p.ca * fallbackFit(p, s), outOfPosition: true }))
        .filter(c => c.score > 0).sort((a, b) => b.score - a.score)[0];
      if (cand) { filled[si] = cand; taken.add(cand.p.uid); }
    });
    const total = filled.reduce((t, x) => t + (x ? x.score : 0), 0);
    const xi = { formation: name, total, slots: slots.map((s, i) => ({ slot: s[0], ...(filled[i] || {}) })) };
    if (!best || total > best.total) best = xi;
  }
  return best;
}

// ---------------------------------------------------------------- formatting helpers

function money(n) {
  if (n === null || n === undefined) return '?';
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}£${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`;
  if (a >= 1e4) return `${sign}£${Math.round(a / 1e3)}K`;
  if (a >= 1e3) return `${sign}£${(a / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return `${sign}£${Math.round(a)}`;
}

const SHORT = {
  longShots: 'LSh', longThrows: 'LTh', commandOfArea: 'Cmd', communication: 'Cmm', oneOnOnes: 'OnO',
  firstTouch: 'Fir', freeKicks: 'Fre', offTheBall: 'OtB', penaltyTaking: 'Pen', workRate: 'Wor',
  jumpingReach: 'Jum', naturalFitness: 'NFi', aerialReach: 'Aer', rushingOut: 'Rus',
};
const short = k => SHORT[k] || (k[0].toUpperCase() + k.slice(1, 3));

function isGK(p) { return (p.naturalPositions || []).includes('GK'); }

// Top N attributes among the ones that matter at his best position (see ratings.js).
function topAttrs(p, n = 3) {
  const get = dumpGetter(p);
  const r = p.attrRanges || {};
  return KEY_ATTRS[styleGroup(bestPosition(p))].map(k => [k, get(k)]).filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => r[k] && r[k][0] !== r[k][1] ? `${short(k)}${r[k][0]}-${r[k][1]}` : `${short(k)}${v}`).join(' ');
}

function pos(p) { return (p.naturalPositions || []).join('/') || '?'; }

// CA / PA as shown: exact number, or "115-135 good" when realism blurred it.
function CA(p) { return p.caText ? p.caText : p.caRange ? `${p.caRange[0]}-${p.caRange[1]}${p.caWord ? ` ${p.caWord}` : ''}` : String(p.ca); }
function PA(p) { return p.paRange ? `${p.paRange[0]}-${p.paRange[1]}` : String(p.pa); }
// "CA138" normally, "rating 13.8" in attributes-only mode; potential part is empty when PA is hidden.
function AB(p) { return p.caText ? `rating ${p.caText}` : `CA${CA(p)}`; }
function POT(p) { return p.paHidden ? '' : ` PA${PA(p)}`; }

function monthsBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso), b = new Date(toIso);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + (b.getDate() - a.getDate()) / 30;
}

function median(xs) {
  const s = xs.filter(x => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

const pers = (p, k) => (p.personality || {})[k];
const hid = (p, k) => (p.hidden || {})[k];

// Personality / hidden-attribute warnings, in plain words.
function flags(p) {
  const f = [];
  if (pers(p, 'professionalism') <= 8) f.push(`low professionalism ${pers(p, 'professionalism')}`);
  if (pers(p, 'professionalism') >= 17) f.push(`model pro ${pers(p, 'professionalism')}`);
  if ((p.mental || {}).determination >= 17) f.push(`determination ${p.mental.determination}`);
  if (pers(p, 'ambition') >= 17) f.push(`very ambitious ${pers(p, 'ambition')}`);
  if (pers(p, 'loyalty') <= 5) f.push(`low loyalty ${pers(p, 'loyalty')}`);
  if (pers(p, 'pressure') <= 7) f.push(`bad under pressure ${pers(p, 'pressure')}`);
  if (pers(p, 'temperament') <= 6) f.push(`hot-headed (temperament ${pers(p, 'temperament')})`);
  if (pers(p, 'controversy') >= 15) f.push(`controversial ${pers(p, 'controversy')}`);
  if (hid(p, 'consistency') <= 8) f.push(`inconsistent ${hid(p, 'consistency')}`);
  if (hid(p, 'consistency') >= 16) f.push(`consistent ${hid(p, 'consistency')}`);
  if (hid(p, 'importantMatches') <= 8) f.push(`poor in big games ${hid(p, 'importantMatches')}`);
  if (hid(p, 'importantMatches') >= 16) f.push(`big-game player ${hid(p, 'importantMatches')}`);
  if (hid(p, 'injuryProneness') >= 14) f.push(`injury-prone ${hid(p, 'injuryProneness')}`);
  if (hid(p, 'injuryProneness') <= 4) f.push(`rarely injured ${hid(p, 'injuryProneness')}`);
  if (hid(p, 'dirtiness') >= 15) f.push(`dirty ${hid(p, 'dirtiness')}`);
  return f;
}

function ageStage(age) {
  if (age == null) return '';
  if (age <= 21) return 'developing';
  if (age <= 23) return 'still improving';
  if (age <= 29) return 'prime';
  if (age <= 31) return 'late prime';
  return 'declining';
}

// ---------------------------------------------------------------- the briefing

/**
 * Build the briefing text.
 * @param {object} dump   parsed dump-latest.json
 * @param {object} [opts] { maxTokens = 3000 }
 * For realism mode, pass the dump through realism.perceive() first: players then carry
 * caRange / paRange / attrRanges and the briefing prints ranges instead of exact values.
 */
/**
 * The league table as short lines: every team (yours marked), then where you stand.
 * Games left assumes everyone plays everyone twice (most leagues); the text says so.
 */
function leagueTableLines(lt) {
  const rows = lt.rows, n = rows.length;
  const us = rows.find(r => r.isUs);
  const out = [`## LEAGUE TABLE: ${lt.competition || 'your league'} (P W D L goals GD Pts)`];
  const gd = v => (v > 0 ? `+${v}` : String(v));
  for (const r of rows)
    out.push(`${r.isUs ? '>>' : '  '}${String(r.position).padStart(2)}. ${r.club} ${r.played} ${r.won} ${r.drawn} ${r.lost} ` +
      `${r.goalsFor}-${r.goalsAgainst} ${gd(r.goalDifference)} ${r.points}`);
  if (!us) return out;
  const rec = x => x ? `${x.won}-${x.drawn}-${x.lost} (${x.goalsFor}-${x.goalsAgainst}, ${x.points} pts)` : '?';
  const above = rows[us.position - 2], below = rows[us.position];
  const gaps = [];
  if (us.position > 1) gaps.push(`${rows[0].points - us.points} pts behind the leader`);
  if (above && us.position > 2) gaps.push(`${above.points - us.points} behind ${above.club} (${above.position}.)`);
  if (below) gaps.push(`${us.points - below.points} ahead of ${below.club} (${below.position}.)`);
  const left = 2 * (n - 1) - us.played;
  out.push(`You: ${us.position}. of ${n}, ${us.points} pts${gaps.length ? `, ${gaps.join(', ')}` : ''}. ` +
    `Home ${rec(us.home)}, away ${rec(us.away)}.` +
    (left > 0 ? ` About ${left} league games left (if every team meets every other twice; check the league's format).` : ''));
  return out;
}

function buildBriefing(dump, opts = {}) {
  // opts.tactic: the manager's tactic (briefing/tactic.js). Its section gets its own token allowance,
  // so describing the tactic never squeezes the squad list.
  const tacticObj = opts.model ? opts.model.tactic : opts.tactic;
  const tacticBlock = tacticObj ? tacticLines(tacticObj) : [];
  const memBlock = opts.model ? memoryLines(opts.model) : [];
  const maxTokens = (opts.maxTokens || 3000) + estimateTokens([...tacticBlock, ...memBlock].join('\n'));
  const meta = dump.meta || {}, club = dump.club || {};
  const realism = meta.realism || null;   // set by realism.perceive(): numbers are estimates
  const attrsOnly = meta.visibility === 'attributes';   // set by realism.fmView(): no CA/PA, position ratings instead
  const diff = d => attrsOnly || useTactic ? (d / 10).toFixed(1) : String(Math.round(d));
  const today = meta.gameDate || (meta.generatedAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);

  const all = (dump.squad || []).map(p => ({ ...p, ca: p.ca || 0, pa: p.pa || 0 }));
  const outOnLoan = p => !!p.onLoanAt || (p.notes || []).some(n => /out on loan/i.test(n));
  const available = all.filter(p => !outOnLoan(p));
  const senior = available.filter(p => p.teamType === 0 || p.teamType == null);
  const pool = senior.length >= 11 ? senior : available;

  // With a tactic, the XI fills the tactic's slots by tactic rating (tacticRating.js); without one, it
  // tries four common formations by CA (or by position rating in the attributes-only view).
  const model = opts.model || (opts.tactic ? buildModel(opts.tactic) : null);
  const useTactic = !!(model && model.slots.length);
  const candidate = p => ({ id: p.uid, get: dumpGetter(p), prOf: k => (p.positionRatings || {})[k] || 0, ref: p });
  let xi;
  if (useTactic) {
    const r = tacticXI(model, pool.map(candidate));
    xi = {
      formation: model.tactic.name || 'your tactic',
      slots: r.slots.map(s => ({ slot: s.slot.label, def: s.slot, p: s.c && s.c.ref, outOfPosition: !!s.c && s.fit < 0.9, score: s.c ? s.score * 10 : 0, rate: s })),
    };
  } else {
    xi = bestXI(pool);
    xi.slots.forEach(s => { if (s.p) s.score = s.p.ca; });
  }
  // A slot's value on one scale: tactic rating x10, or CA (position rating x10 in the attributes view).
  const slotValue = (p, s) => {
    if (useTactic) return rateSlot(model, s.def, dumpGetter(p), k => (p.positionRatings || {})[k] || 0).score * 10;
    return fit(p, FORMATIONS[xi.formation][xi.slots.indexOf(s)]) * p.ca;
  };
  const xiPlayers = xi.slots.filter(s => s.p).map(s => s.p);
  const xiIds = new Set(xiPlayers.map(p => p.uid));
  const filledSlots = xi.slots.filter(s => s.p);
  const xiAvg = filledSlots.length ? Math.round(filledSlots.reduce((t, s) => t + s.score, 0) / filledSlots.length) : 0;

  const out = [];
  const line = s => out.push(s);

  // ---- header
  line(`=== TRUEDOF BRIEFING: ${club.name || '?'} (${club.league || 'league ?'}) ===`);
  if (attrsOnly)
    line('VIEW: like the manager in FM with attribute masking off. Exact attributes and personality; NO CA, PA or hidden attributes. ' +
      '"rating" = position rating 1-20 from the key attributes of his best position (computed by TrueDoF).');
  if (realism)
    line(`REALISM ON: the Director's judging ability is ${realism.judging}/20. CA, PA and attributes are scouting ESTIMATES shown as ranges ` +
      `(the true value is inside the range). Hidden attributes: ${realism.hiddenKnown}. Personality: ${realism.personalityKnown}.`);
  line(`Date ${today} | manager ${meta.manager || '?'} | club reputation ${club.reputation ?? '?'}/10000 | money in GBP | data: ${meta.versionVerified === false ? 'UNVERIFIED FM version, numbers may be off' : 'true in-game values'}`);

  // ---- tactic
  line('');
  line('## YOUR TACTIC');
  if (tacticBlock.length) tacticBlock.forEach(line);
  else line('No tactic set (the manager can describe it in tactic.txt in the TrueDoF folder).');
  memBlock.forEach(line);

  // ---- finances
  line('');
  line('## FINANCES');
  const budget = club.wageBudgetWeekly, spend = club.wageSpendWeekly;
  let wageLine = `Wage budget ${money(budget)}/w, FM wage spend ${money(spend)}/w`;
  if (budget && spend) wageLine += ` (${Math.round(100 * spend / budget)}% used, headroom ${money(budget - spend)}/w)`;
  line(`Balance ${money(club.balance)} | transfer budget ${money(club.transferBudget)} | ${wageLine}`);
  line(`Player contracts total ${money(club.wageBillWeekly)}/w (${money(club.wageBillAnnual)}/yr), ${club.contractedPlayers ?? all.length} contracted players`);

  // ---- league
  const lt = dump.leagueTable || {};
  if (lt.mapped && lt.rows && lt.rows.length) {
    line('');
    leagueTableLines(lt).forEach(l => line(l));
  } else {
    line(`League table: not available (${lt.note || 'not read'}).`);
  }

  // ---- best XI
  line('');
  if (useTactic) {
    line(`## BEST XI FOR YOUR TACTIC: ${xi.formation} (avg tactic rating ${(xiAvg / 10).toFixed(1)})`);
    line(`Tactic rating 1-20 = ${describeModel(model)}; times position familiarity (natural 1.0, accomplished 0.9, ` +
      `competent 0.75) averaged over the slot's two positions.${model.engine ? ' "eng" = measured worth in goals per season vs an all-10 player in that slot (compare within a slot).' : ''}`);
    if (model.problems.length) line(`(rating notes: ${model.problems.join('; ')})`);
    const benchFor = s => pool.filter(p => !xiIds.has(p.uid)).map(p => ({ p, v: slotValue(p, s) })).sort((a, b) => b.v - a.v)[0];
    for (const s of xi.slots) {
      const head = `${String(s.def.index).padStart(2)}. ${s.slot} ${s.def.roles}:`;
      if (!s.p) { line(`${head} NOBODY`); continue; }
      const p = s.p, r = s.rate, g = dumpGetter(p);
      const fam = r.fit < 0.9 ? ` (familiarity ${[...new Set([s.def.ip.position, s.def.oop.position])].map(x => `${x} ${(p.positionRatings || {})[x] || 0}`).join(', ')})` : '';
      const next = benchFor(s);
      line(`${head} ${p.name} ${p.age ?? '?'}y tactic ${r.score.toFixed(1)}${r.goals != null ? ` eng ${r.goals >= 0 ? '+' : ''}${r.goals.toFixed(1)}` : ''} ` +
        `| Pac${g('pace')} Acc${g('acceleration')} Sta${g('stamina')} Jum${g('jumpingReach')} | ${AB(p)}${POT(p)}${fam}` +
        `${next ? ` | next: ${next.p.name} ${(next.v / 10).toFixed(1)}` : ''}`);
    }
  } else {
    line(`## BEST XI BY ${attrsOnly ? 'POSITION RATING' : 'CA'}: ${xi.formation} (avg ${attrsOnly ? 'rating ' + (xiAvg / 10).toFixed(1) : 'CA ' + (realism ? '~' : '') + xiAvg})`);
    for (const s of xi.slots) {
      if (!s.p) { line(`${s.slot}: NOBODY`); continue; }
      const p = s.p;
      line(`${s.slot.padEnd(3)} ${p.name} ${p.age ?? '?'}y ${AB(p)}${POT(p)} ${topAttrs(p)}${s.outOfPosition ? ' (OUT OF POSITION)' : ''}`);
    }
  }

  // ---- depth
  line('');
  line('## DEPTH (accomplished+ options, best first; available senior players)');
  const depth = {};
  // With a tactic: only the position groups the tactic uses (with the ball), wanting at least one more
  // option than it has slots there. A strikerless tactic doesn't need strikers.
  const groups = !useTactic ? GROUPS : GROUPS.map(g => {
    const n = model.slots.filter(s => g.pos.includes(s.ip.position)).length;
    return n ? { ...g, want: Math.max(g.want, n + 1) } : null;
  }).filter(Boolean);
  for (const g of groups) {
    const opts2 = pool.filter(p => g.pos.some(x => ((p.positionRatings || {})[x] || 0) >= ACCOMPLISHED)).sort((a, b) => b.ca - a.ca);
    depth[g.key] = opts2;
    const names = opts2.slice(0, 4).map(p => `${p.name} ${CA(p)}`).join(', ') || 'none';
    const thin = opts2.length < g.want ? ` THIN (${opts2.length}/${g.want})` : '';
    line(`${g.label}: ${names}${opts2.length > 4 ? ` +${opts2.length - 4}` : ''}${thin}`);
  }

  // ---- weak spots
  line('');
  line('## WEAK SPOTS');
  const weak = [];
  for (const s of xi.slots) {
    if (!s.p) { weak.push(`${s.slot}: no player at all`); continue; }
    if (s.outOfPosition) weak.push(`${s.slot}: ${s.p.name} plays out of position`);
    if (s.score <= xiAvg - 10) weak.push(`${s.slot}: ${s.p.name} ${useTactic ? `tactic ${(s.score / 10).toFixed(1)}` : AB(s.p)} is ${diff(xiAvg - s.score)} below XI average`);
    if (useTactic && s.def.ip.position !== 'GK') {
      // The manager's own minimums: priority attributes below the guide's range, minimum requirements below their floor.
      const g = dumpGetter(s.p);
      const short = model.rules.filter(r => r.kind !== 'special' && r.kind !== 'good' && g(r.attr) > 0 && g(r.attr) < r.lo)
        .map(r => `${r.attr} ${g(r.attr)} (wants ${r.lo}+)`);
      if (short.length) weak.push(`${s.slot}: ${s.p.name} below the tactic's requirements: ${short.join(', ')}`);
    }
    if ((s.p.age || 0) >= 32) weak.push(`${s.slot}: ${s.p.name} is ${s.p.age}, decline coming`);
    const f = flags(s.p).filter(x => /inconsistent|big games|injury-prone|professionalism|hot-headed/.test(x));
    if (f.length) weak.push(`${s.slot}: ${s.p.name}: ${f.join(', ')}`);
  }
  for (const g of groups) {
    const o = depth[g.key];
    if (o.length < g.want) weak.push(`${g.label}: only ${o.length} of ${g.want} wanted options`);
    else if (o.length >= 2 && o[0].ca - o[1].ca >= 20) weak.push(`${g.label}: big drop behind ${o[0].name} (${CA(o[0])} → ${CA(o[1])})`);
  }
  // Promised playing time vs reality (squad status from the contract)
  for (const p of pool) {
    const grp = p.contract && p.contract.squadStatusGroup;
    if ((grp === 'key player' || grp === 'regular starter') && !xiIds.has(p.uid))
      weak.push(`${p.name} has squad status "${p.contract.squadStatus}" but is not in the best XI (playing-time promise at risk)`);
  }
  (weak.length ? weak : ['none obvious']).forEach(w => line(`- ${w}`));

  // ---- contracts
  line('');
  line('## CONTRACTS EXPIRING WITHIN 12 MONTHS');
  const expiring = all.map(p => ({ p, m: monthsBetween(today, p.contract && p.contract.expires) }))
    .filter(x => x.m != null && x.m <= 12).sort((a, b) => a.m - b.m);
  const expiryTag = m => m < 0 ? ' [end date already passed?]' : m <= 6 ? ' [≤6 months: can agree a pre-contract with a foreign club]' : '';
  if (!expiring.length) line('none');
  expiring.forEach(({ p, m }) => line(`${p.name} ${p.age ?? '?'}y ${pos(p)} ${AB(p)}${POT(p)} ${money(p.contract.wageWeekly)}/w ends ${p.contract.expires}` +
    `${xiIds.has(p.uid) ? ' [XI]' : ''}${expiryTag(m)}`));

  // ---- wages
  line('');
  line('## WAGE STRUCTURE');
  const wages = all.filter(p => p.contract && p.contract.wageWeekly != null && !p.onLoanFrom);
  const medWage = median(wages.map(p => p.contract.wageWeekly));
  const top = [...wages].sort((a, b) => b.contract.wageWeekly - a.contract.wageWeekly);
  line(`Median player wage ${money(medWage)}/w. Top earners: ` +
    top.slice(0, 5).map(p => `${p.name} ${money(p.contract.wageWeekly)} (${AB(p)}${xiIds.has(p.uid) ? ', XI' : ''})`).join('; '));
  const p75 = top.length ? top[Math.floor(top.length * 0.25)].contract.wageWeekly : null;
  const poorValue = top.filter(p => p75 != null && p.contract.wageWeekly >= p75 && !xiIds.has(p.uid) && (p.age || 0) > 21).slice(0, 5);
  if (poorValue.length) line('High earners outside the XI: ' + poorValue.map(p => `${p.name} ${money(p.contract.wageWeekly)}/w ${AB(p)}`).join('; '));

  // ---- morale
  const unhappy = pool.filter(p => p.morale != null && p.morale <= 9).sort((a, b) => a.morale - b.morale).slice(0, 6);
  const moraleAvg = all.filter(p => p.morale != null);
  if (moraleAvg.length) {
    line('');
    line(`## MORALE: squad average ${(moraleAvg.reduce((t, p) => t + p.morale, 0) / moraleAvg.length).toFixed(1)}/20` +
      (unhappy.length ? '; low (senior players): ' + unhappy.map(p => `${p.name} ${p.morale} (${p.moraleLevel || '?'})`).join(', ') : '; no senior player below Okay'));
  }

  // ---- youth
  line('');
  line(attrsOnly ? '## PROMISING YOUTH (age ≤ 21)' : '## HIGH-POTENTIAL YOUTH (age ≤ 21)');
  const youth = attrsOnly
    ? all.filter(p => (p.age || 99) <= 21 && p.ca >= xiAvg - 25).sort((a, b) => (b.ca + (21 - b.age) * 5) - (a.ca + (21 - a.age) * 5)).slice(0, 8)
    : all.filter(p => (p.age || 99) <= 21 && p.pa >= xiAvg - 5 && (p.pa >= xiAvg + 5 || p.pa - p.ca >= 25))
      .sort((a, b) => b.pa - a.pa).slice(0, 8);
  if (attrsOnly) line('(Potential is not visible in this view: these are the young players whose attributes are already closest to first-team level.)');
  if (!youth.length) line('none above first-team level');
  youth.forEach(p => {
    const f = flags(p).filter(x => /professionalism|determination|ambitious|pro /.test(x));
    line(`${p.name} ${p.age}y ${pos(p)} ${AB(p)}${p.paHidden ? '' : ` → PA${PA(p)}`} (${p.team || 'loaned out'})${f.length ? ' | ' + f.join(', ') : ''}`);
  });

  // ---- shortlist
  line('');
  line('## SHORTLIST: VERDICT INPUTS (sign / scout first / stretch / no)');
  const sl = dump.shortlist || [];
  if (!sl.length && !(dump.shortlistNotFound || []).length)
    line(`Shortlist is empty${dump.shortlistStatus ? ` (${dump.shortlistStatus})` : ' (add names to shortlist.txt and press F8 in FM)'}.`);
  sl.forEach(p => {
    // Where would he play, and who is there now?
    let bestSlot = null;
    xi.slots.forEach(s => {
      const v = slotValue(p, s);
      if (v > 0 && (!bestSlot || v - (s.p ? s.score : 0) > bestSlot.gain)) bestSlot = { s, v, gain: v - (s.p ? s.score : 0) };
    });
    const grp = groups.find(g => g.pos.some(x => (p.naturalPositions || []).includes(x)));
    const rank = grp ? depth[grp.key].filter(q => q.ca > p.ca).length + 1 : null;

    const price = p.askingPriceGbp ?? p.valueGbp;
    let afford = '?';
    if (price != null && club.transferBudget != null) {
      const r = price / Math.max(1, club.transferBudget);
      afford = r <= 0.7 ? 'affordable' : r <= 1.3 ? 'stretch' : 'over budget';
      afford += ` (${money(price)} vs budget ${money(club.transferBudget)})`;
    }
    const monthsLeft = monthsBetween(today, p.contract && p.contract.expires);
    const wage = p.contract && p.contract.wageWeekly;
    const wageVsTop = wage != null && top.length ? `${Math.round(100 * wage / top[0].contract.wageWeekly)}% of our top earner` : '';

    const owner = p.onLoanAt ? `${p.club || '?'}, on loan at ${p.onLoanAt}${p.loanEnds ? ` until ${p.loanEnds}` : ''}` : (p.club || '?');
    line(`* ${p.name} ${p.age ?? '?'}y ${pos(p)} (${owner}) ${AB(p)}${POT(p)} ${ageStage(p.age)} | ${topAttrs(p)}`);
    const ours = s => useTactic ? `tactic ${(s.score / 10).toFixed(1)}` : AB(s.p);
    const upgrade = bestSlot
      ? (bestSlot.s.p ? `${useTactic ? `best slot ${bestSlot.s.slot} (tactic ${(bestSlot.v / 10).toFixed(1)}) ` : ''}vs our ${bestSlot.s.slot} ${bestSlot.s.p.name} ${ours(bestSlot.s)}: ` +
                        `${bestSlot.gain >= 5 ? 'UPGRADE' : bestSlot.gain >= -5 ? 'similar level' : 'NOT an upgrade'} (${bestSlot.gain >= 0 ? '+' : ''}${diff(bestSlot.gain)})`
                      : `fills an empty ${bestSlot.s.slot} slot`)
      : useTactic ? 'fits no slot of our tactic (not familiar with any of its positions)' : 'no position in our XI shape';
    line(`  fit: ${upgrade}${rank ? `; would rank #${rank} in our ${grp.label}` : ''}`);
    line(`  money: ${afford}; wage ${money(wage)}/w${wageVsTop ? ` (${wageVsTop})` : ''}; contract ends ${(p.contract && p.contract.expires) || '?'}` +
      `${monthsLeft != null && monthsLeft <= 6 ? ' (could come on a pre-contract/free)' : monthsLeft != null && monthsLeft <= 12 ? ' (final year: cheaper)' : ''}` +
      `${p.contract && p.contract.transferListed ? '; transfer-listed or transfer arranged (check his profile)' : ''}${p.contract && p.contract.loanListed ? '; loan-listed' : ''}` +
      `${p.contract && p.contract.squadStatus ? `; status at his club: ${p.contract.squadStatus}` : ''}`);
    const arranged = (dump.transfers || []).filter(t => t.playerUid === p.uid && (t.status === 'arranged' || t.status === 'agreed'));
    if (arranged.length) line(`  ALREADY ARRANGED: moving to ${arranged.map(t => `${t.to}${t.date ? ` on ${t.date}` : ''}`).join(', ')}`);
    const f = flags(p);
    line(`  character: ${f.length ? f.join(', ') : 'no red or green flags'}`);
  });
  (dump.shortlistNotFound || []).forEach(m => line(`(not found: "${m.entry}": ${m.reason})`));

  // ---- transfers
  const tr = dump.transfers || [];
  if (tr.length) {
    line('');
    line('## TRANSFER ACTIVITY (latest)');
    tr.slice(0, 8).forEach(t => line(`${t.date || '?'} ${t.player}: ${t.from} → ${t.to} (${t.status}, ${t.involves})`));
  }

  // ---- squad list (trimmed to fit the token budget)
  const header = out.join('\n');
  const rows = [...all].sort((a, b) => (a.teamType ?? 50) - (b.teamType ?? 50) || b.ca - a.ca).map(p =>
    `${p.name} ${p.age ?? '?'}y ${pos(p)} ${AB(p)}${POT(p)} ${money(p.contract && p.contract.wageWeekly)}/w ` +
    `to ${((p.contract && p.contract.expires) || '?').slice(0, 7)} mor${p.morale ?? '?'}` +
    `${p.onLoanFrom ? ' [loan in]' : ''}${p.onLoanAt ? ` [loaned to ${p.onLoanAt}]` : outOnLoan(p) ? ' [loaned out]' : ''}${p.teamType >= 10 ? ' [youth]' : ''}`);
  let squadBlock = '';
  for (let n = rows.length; n >= 0; n--) {
    const shown = rows.slice(0, n);
    squadBlock = `\n\n## FULL SQUAD (${all.length} players${n < rows.length ? `, top ${n} shown` : ''})\n` + shown.join('\n');
    if (estimateTokens(header + squadBlock) <= maxTokens) break;
  }
  return header + squadBlock + '\n';
}

/** Rough token count: ~4 characters per token for English text with numbers. */
function estimateTokens(text) { return Math.ceil(text.length / 4); }

module.exports = { buildBriefing, leagueTableLines, bestXI, estimateTokens, money, flags, topAttrs, FORMATIONS, GROUPS };
