'use strict';
// The Director's player database: searches players-db.json (written by the FM plugin on F8).
// Every function returns plain text, written to be read by the Director (short, one line per player).

const fs = require('fs');
const path = require('path');
const { perceivedAbility, perceivedAttr, abilityWord } = require('../briefing/realism');

// ---------------------------------------------------------------- positions

const POS_KEYS = ['GK', 'SW', 'DL', 'DC', 'DR', 'DM', 'ML', 'MC', 'MR', 'AML', 'AMC', 'AMR', 'ST', 'WBL', 'WBR'];
const ALIASES = {
  GK: ['GK'], CB: ['DC'], DC: ['DC'], D: ['DC'], SW: ['SW'],
  LB: ['DL', 'WBL'], DL: ['DL'], RB: ['DR', 'WBR'], DR: ['DR'], FB: ['DL', 'DR', 'WBL', 'WBR'], FULLBACK: ['DL', 'DR', 'WBL', 'WBR'],
  LWB: ['WBL'], WBL: ['WBL'], RWB: ['WBR'], WBR: ['WBR'], WB: ['WBL', 'WBR'],
  DM: ['DM'], DMC: ['DM'], CDM: ['DM'], CM: ['MC'], MC: ['MC'], M: ['MC'],
  LM: ['ML'], ML: ['ML'], RM: ['MR'], MR: ['MR'],
  AM: ['AMC'], AMC: ['AMC'], CAM: ['AMC'], LW: ['AML', 'ML'], AML: ['AML'], RW: ['AMR', 'MR'], AMR: ['AMR'],
  W: ['AML', 'AMR', 'ML', 'MR'], WINGER: ['AML', 'AMR', 'ML', 'MR'],
  ST: ['ST'], CF: ['ST'], FW: ['ST'], STRIKER: ['ST'],
};

function expandPositions(list) {
  const out = new Set();
  for (const raw of Array.isArray(list) ? list : (list ? [list] : [])) {
    const k = String(raw).toUpperCase().replace(/[^A-Z]/g, '');
    (ALIASES[k] || []).forEach(p => out.add(p));
  }
  return [...out];
}

const { KEY_ATTRS, styleGroup, ratingAt } = require('../briefing/ratings');
const { buildModel, rateSlot, resolveSlot, slotAttributes } = require('../briefing/tacticRating');

const NO_TACTIC = buildModel(null);   // roles only: used for "find me an IF" when no tactic is set

/** Resolve input.tactic_slot → { model, slot } or { error }. */
function tacticSlot(input, ctx) {
  if (!input.tactic_slot) return {};
  const model = ctx.tactic && (ctx.tactic.slots.length || ctx.tactic.engine || ctx.tactic.rules.length) ? ctx.tactic : NO_TACTIC;
  const slot = resolveSlot(model, input.tactic_slot);
  if (slot) return { model, slot };
  const list = model.slots.map(s => `${s.index} ${s.label} (${s.roles})`).join('; ');
  return { error: `"${input.tactic_slot}" is not a slot of the tactic or a role TrueDoF knows.${list ? ` Slots: ${list}.` : ' No tactic is set (tactic.txt).'} You can also pass a role name or abbreviation such as "Inside Forward" or "IF".` };
}

function slotPositions(slot) { return slot.anyOf || [...new Set([slot.ip.position, slot.oop.position])]; }

// ---------------------------------------------------------------- helpers

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/đ/g, 'd').replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function money(n) {
  if (n === null || n === undefined) return '?';
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}£${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`;
  if (a >= 1e4) return `${sign}£${Math.round(a / 1e3)}K`;
  if (a >= 1e3) return `${sign}£${(a / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return `${sign}£${Math.round(a)}`;
}

function monthsBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso), b = new Date(toIso);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + (b.getDate() - a.getDate()) / 30;
}

const num = (v, lo, hi) => { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : Math.max(lo, Math.min(hi, n)); };
const bool = v => v === true || v === 'true';
const str = (v, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// ---------------------------------------------------------------- the database

class PlayerDatabase {
  constructor(file) { this.file = file; this.mtime = 0; this.rows = null; this.meta = null; }

  /** (Re)load players-db.json when it changed. Returns false if it isn't there. */
  load() {
    let st;
    try { st = fs.statSync(this.file); } catch { this.rows = null; return false; }
    if (this.rows && st.mtimeMs === this.mtime) return true;
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, ''));
    this.meta = data.meta;
    this.attrIndex = Object.fromEntries(data.meta.attrKeys.map((k, i) => [k, i]));
    this.hiddenKeys = data.meta.hiddenKeys;
    this.persKeys = data.meta.personalityKeys;
    this.rows = data.players;
    this.byId = new Map(this.rows.map(r => [r.id, r]));
    this.mtime = st.mtimeMs;
    return true;
  }

  // ---- how the Director sees a player (true values, or estimates in realism mode)

  /**
   * The Director's view of a player, by mode:
   *  everything  - true CA/PA and attributes
   *  attributes  - exact attributes, no CA/PA: ability = position rating 1-20 at `pos` (ca holds rating x 10)
   *  scouted     - realism estimates (ranges) from his judging ability
   */
  /**
   * view() plus the player's rating for a tactic slot (v.tactic = { score, rating, fit, goals }).
   * In the attributes-only view the tactic rating replaces the position rating as his "ability".
   */
  slotView(r, ctx, model, slot) {
    const v = this.view(r, ctx, slotPositions(slot)[0]);
    const t = rateSlot(model, slot, v.attr, p => r.pr[POS_KEYS.indexOf(p)] || 0);
    v.tactic = t;
    const goals = t.goals != null ? `, eng ${t.goals >= 0 ? '+' : ''}${t.goals.toFixed(1)} goals/season` : '';
    if (ctx.visibility === 'attributes') { v.ca = Math.round(t.score * 10); v.caText = `tactic rating ${t.score.toFixed(1)} as ${slot.label}${goals}`; }
    else v.tacticText = `tactic rating ${t.score.toFixed(1)} as ${slot.label}${goals}`;
    return v;
  }

  view(r, ctx, pos) {
    const exact = k => r.at[this.attrIndex[k]] || 0;
    if (ctx.visibility === 'attributes') {
      const at = pos || this.bestPosition(r);
      const rating = ratingAt(exact, at);
      return { ca: Math.round(rating * 10), pa: null, caText: `rating ${rating.toFixed(1)} as ${at}`, paText: null, attr: exact, attrText: k => String(exact(k)) };
    }
    if (ctx.visibility !== 'scouted') return { ca: r.ca, pa: r.pa, caText: `CA ${r.ca}`, paText: `PA ${r.pa}`, attr: exact, attrText: k => String(exact(k)) };
    const own = r.c === ctx.ownClub;
    const ab = perceivedAbility(r.id, r.ca, r.pa, ctx.judging, own);
    const cache = {};
    const pa = k => cache[k] || (cache[k] = perceivedAttr(r.id, k, exact(k), ctx.judging, own));
    return {
      ca: ab.ca, pa: ab.pa,
      caText: `CA ${ab.caRange[0]}-${ab.caRange[1]} ${abilityWord(ab.ca)}`, paText: `PA ${ab.paRange[0]}-${ab.paRange[1]}`,
      attr: k => pa(k).value,
      attrText: k => { const a = pa(k); return a.range[0] === a.range[1] ? String(a.value) : `${a.range[0]}-${a.range[1]}`; },
    };
  }

  /** Can the Director see hidden attributes / personality in this mode? */
  seesHidden(ctx, own) { return ctx.visibility === 'everything' || (ctx.visibility === 'scouted' && ctx.judging >= (own ? 10 : 14)); }
  seesPersonality(ctx, own) { return ctx.visibility !== 'scouted' || ctx.judging >= (own ? 5 : 8); }

  fee(r) { return !r.c ? 0 : (r.ask ?? r.v ?? null); }

  plays(r, positions) { return positions.some(p => (r.pr[POS_KEYS.indexOf(p)] || 0) >= 15); }

  bestPosition(r) {
    let best = 0, at = 'ST';
    POS_KEYS.forEach((p, i) => { if ((r.pr[i] || 0) > best) { best = r.pr[i]; at = p; } });
    return at;
  }

  topAttrs(r, v, n = 3) {
    const keys = KEY_ATTRS[styleGroup(this.bestPosition(r))];   // the attributes that matter at his position
    return keys.map(k => [k, v.attr(k)]).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${v.attrText(k)}`).join(', ');
  }

  line(r, ctx, extra = '', v = this.view(r, ctx)) {
    const fee = this.fee(r);
    const m = monthsBetween(ctx.today, r.x);
    const bits = [
      `${r.n} (${r.a ?? '?'}, ${r.pos}${r.acc ? ', also ' + r.acc : ''})`,
      `${r.c || 'FREE AGENT'}${r.la ? ` (on loan at ${r.la})` : ''}${r.lg ? ` [${r.lg}]` : ''}`,
      v.paText ? `${v.caText}, ${v.paText}` : v.caText,
      r.c ? `value ${money(r.v)}${r.ask != null ? `, asking ${money(r.ask)}` : ''}` : 'no fee (free agent)',
      `wage ${money(r.w)}/w${r.x ? `, contract to ${r.x}` : ''}${m != null && m <= 6 && r.c ? ' (≤6 months left: pre-contract possible)' : ''}`,
    ];
    if (r.tl) bits.push('transfer-listed or transfer arranged');
    if (r.ll) bits.push('loan-listed');
    if (r.ss) bits.push(`status: ${r.ss}`);
    if (v.tacticText) bits.push(v.tacticText);
    if (v.tactic) bits.push(`pace ${v.attrText('pace')}, acceleration ${v.attrText('acceleration')}, stamina ${v.attrText('stamina')}, jumping reach ${v.attrText('jumpingReach')}`);
    else bits.push(`best: ${this.topAttrs(r, v)}`);
    if (fee != null && ctx.transferBudget != null && r.c) bits.push(fee <= ctx.transferBudget ? 'fee within budget' : `fee ${Math.round(fee / Math.max(1, ctx.transferBudget))}x budget`);
    return `${bits.join(' | ')}${extra} | id ${r.id}`;
  }

  // ---- our own squad at some positions (for "starter" / "backup" searches)

  ourOptions(positions, ctx, ts = {}) {
    return this.rows.filter(r => r.c === ctx.ownClub && !r.la && this.plays(r, positions))
      .map(r => ({ r, v: ts.slot ? this.slotView(r, ctx, ts.model, ts.slot) : this.view(r, ctx, positions[0]) }))
      .map(o => ({ ...o, ca: o.v.tactic ? o.v.tactic.score * 10 : o.v.ca })).sort((a, b) => b.ca - a.ca);
  }

  // ---------------------------------------------------------------- tools

  search(input, ctx) {
    const ts = tacticSlot(input, ctx);
    if (ts.error) return ts.error;
    let positions = expandPositions(input.positions);
    if (!positions.length && ts.slot) positions = slotPositions(ts.slot);
    let tMin = null, tMax = null;   // starter/backup window on the tactic rating (x10) when a tactic slot is given
    const role = ['starter', 'backup'].includes(input.role) ? input.role : null;
    let minCa = num(input.min_ca, 1, 200), maxCa = num(input.max_ca, 1, 200);
    const minPa = ctx.visibility === 'attributes' ? null : num(input.min_pa, 1, 200), minAge = num(input.min_age, 14, 45), maxAge = num(input.max_age, 14, 45);
    let maxFee = num(input.max_fee, 0, 2e9), maxWage = num(input.max_wage, 0, 1e8);
    const expiring = num(input.contract_expiring_within_months, 0, 60);
    const limit = num(input.limit, 1, 25) || 10;
    const league = str(input.league) && norm(input.league), nation = str(input.nationality) && norm(input.nationality);
    const excludeOwn = input.exclude_own_club !== false;
    const notes = [];
    const attrsOnly = ctx.visibility === 'attributes';
    if (attrsOnly) {
      if (minCa != null || maxCa != null || input.min_pa != null) notes.push('CA/PA filters ignored: CA and PA are not visible in this mode (use min_rating instead).');
      minCa = num(input.min_rating, 1, 20) != null ? num(input.min_rating, 1, 20) * 10 : null;
      maxCa = num(input.max_rating, 1, 20) != null ? num(input.max_rating, 1, 20) * 10 : null;
    }

    if (role && positions.length) {
      const ours = this.ourOptions(positions, ctx, ts);
      const starter = ours[0], backup = ours[1];
      if (starter) {
        notes.push(`Our current options there: ${ours.slice(0, 3).map(o => `${o.r.n} ${o.v.tacticText || o.v.caText}`).join(', ')}.`);
        let lo, hi = null;
        if (role === 'starter') lo = starter.ca - 3;
        else { lo = (backup ? backup.ca : starter.ca - 15) - 10; hi = starter.ca + 2; }
        if (ts.slot) { tMin = lo; tMax = hi; }
        else { minCa = Math.max(minCa ?? 0, lo); if (hi != null) maxCa = Math.min(maxCa ?? 200, hi); }
      } else notes.push('We have nobody accomplished at that position, so any decent player is an upgrade.');
    }
    if (ts.slot) notes.push(`Rated for ${ts.slot.label === ts.slot.roles ? ts.slot.label : `${ts.slot.label}: ${ts.slot.roles}`} with the tactic's attribute needs.`);
    if (bool(input.affordable_only)) {
      if (ctx.transferBudget != null) maxFee = Math.min(maxFee ?? Infinity, ctx.transferBudget);
      const wageCap = Math.max(ctx.wageHeadroom ?? 0, ctx.topWage ?? 0);
      if (wageCap > 0) maxWage = Math.min(maxWage ?? Infinity, wageCap);
      notes.push(`Affordable = fee up to ${money(ctx.transferBudget)} (free agents and players with ≤6 months left also count) and wage up to ${money(wageCap)}/w.`);
    }

    const found = [];
    for (const r of this.rows) {
      if (excludeOwn && r.c === ctx.ownClub) continue;
      if (positions.length && !this.plays(r, positions)) continue;
      if (minAge != null && (r.a ?? 99) < minAge) continue;
      if (maxAge != null && (r.a ?? 0) > maxAge) continue;
      if (league && !norm(r.lg).includes(league)) continue;
      if (nation && !norm(r.nat).includes(nation)) continue;
      if (bool(input.transfer_listed_only) && !r.tl) continue;
      if (bool(input.loan_listed_only) && !r.ll) continue;
      if (bool(input.free_agents_only) && r.c) continue;
      const m = monthsBetween(ctx.today, r.x);
      if (expiring != null && !(r.c && m != null && m <= expiring)) continue;
      if (maxFee != null) {
        const fee = this.fee(r);
        const cheapRoute = !r.c || (m != null && m <= 6);
        if (!cheapRoute && (fee == null || fee > maxFee)) continue;
      }
      if (maxWage != null && r.w != null && r.w > maxWage) continue;
      const v = ts.slot ? this.slotView(r, ctx, ts.model, ts.slot) : this.view(r, ctx, positions[0]);
      if (minCa != null && v.ca < minCa) continue;
      if (maxCa != null && v.ca > maxCa) continue;
      if (minPa != null && v.pa < minPa) continue;
      if (tMin != null && v.tactic.score * 10 < tMin) continue;
      if (tMax != null && v.tactic.score * 10 > tMax) continue;
      found.push({ r, v });
    }

    let sort = input.sort_by;
    if (ts.slot && (!sort || sort === 'ca')) sort = 'tactic';
    if (attrsOnly && (sort === 'pa' || sort === 'potential')) { notes.push('Potential is not visible in this mode, so sorted by rating instead.'); sort = 'ca'; }
    const key = sort === 'tactic' ? x => x.v.tactic.score : sort === 'pa' ? x => x.v.pa : sort === 'potential' ? x => x.v.pa - x.v.ca
      : sort === 'value' ? x => -(this.fee(x.r) ?? 1e12) : sort === 'age' ? x => -(x.r.a ?? 99) : x => x.v.ca;
    found.sort((a, b) => key(b) - key(a));

    const sortName = sort === 'tactic' ? 'tactic rating' : (sort || 'ca') === 'ca' && attrsOnly ? 'position rating' : sort || 'ca';
    const head = [`Found ${found.length} player(s)${found.length > limit ? `, showing the top ${limit}` : ''}, sorted by ${sortName}.` +
      `${tMin != null || tMax != null ? ` Tactic rating window: ${((tMin ?? 10) / 10).toFixed(1)}-${((tMax ?? 200) / 10).toFixed(1)}.` : ''}` +
      `${positions.length ? ` Positions: ${positions.join('/')}.` : ''}${minCa != null || maxCa != null ? (attrsOnly ? ` Rating window: ${((minCa ?? 10) / 10).toFixed(1)}-${((maxCa ?? 200) / 10).toFixed(1)}.` : ` CA window: ${minCa ?? 1}-${maxCa ?? 200}${ctx.visibility === 'scouted' ? ' (on our scouts\' estimates)' : ''}.`) : ''}`];
    return [...head, ...notes, ...found.slice(0, limit).map((x, i) => `${i + 1}. ${this.line(x.r, ctx, '', x.v)}`)].join('\n');
  }

  findPlayer(query) {
    const id = Number(query);
    if (Number.isInteger(id) && this.byId.has(id)) return { match: this.byId.get(id), others: [] };
    const q = norm(query);
    if (!q) return { match: null, others: [] };
    let hits = this.rows.filter(r => norm(r.n) === q);
    if (!hits.length) hits = this.rows.filter(r => norm(r.n).split(' ').includes(q) || norm(r.n).includes(q));
    hits.sort((a, b) => b.ca - a.ca);
    return { match: hits[0] || null, others: hits.slice(1, 6) };
  }

  similar(input, ctx) {
    const { match: target, others } = this.findPlayer(input.player);
    if (!target) return `No player called "${input.player}" in the database. Check the spelling, or he may play in a league that isn't loaded in this save.`;
    const ts = tacticSlot(input, ctx);
    if (ts.error) return ts.error;
    const positions = expandPositions(input.positions).length ? expandPositions(input.positions)
      : ts.slot ? slotPositions(ts.slot) : [this.bestPosition(target)];
    // With a tactic slot: compare on what that slot needs (its roles and the tactic's attribute guide),
    // and judge level by the tactic rating.
    const keys = ts.slot ? slotAttributes(ts.model, ts.slot) : KEY_ATTRS[styleGroup(positions[0])];
    const see = r => (ts.slot ? this.slotView(r, ctx, ts.model, ts.slot) : this.view(r, ctx, positions[0]));
    const lvl = v => (v.tactic ? v.tactic.score * 10 : v.ca);
    const tv = see(target);
    const vec = v => { const xs = keys.map(k => v.attr(k)); const mean = xs.reduce((a, b) => a + b, 0) / xs.length; return xs.map(x => x - mean); };
    const t = vec(tv), tNorm = Math.hypot(...t) || 1;
    const maxFee = bool(input.affordable_only) && ctx.transferBudget != null ? ctx.transferBudget : num(input.max_fee, 0, 2e9);
    const maxAge = num(input.max_age, 14, 45), minAge = num(input.min_age, 14, 45);
    const limit = num(input.limit, 1, 20) || 8;

    const scored = [];
    for (const r of this.rows) {
      if (r.id === target.id || !this.plays(r, positions)) continue;
      if (input.exclude_own_club !== false && r.c === ctx.ownClub) continue;
      if (maxAge != null && (r.a ?? 0) > maxAge) continue;
      if (minAge != null && (r.a ?? 99) < minAge) continue;
      if (maxFee != null) {
        const m = monthsBetween(ctx.today, r.x), fee = this.fee(r);
        if (!(!r.c || (m != null && m <= 6)) && (fee == null || fee > maxFee)) continue;
      }
      const v = see(r);
      const x = vec(v), xNorm = Math.hypot(...x) || 1;
      const shape = (t.reduce((s, ti, i) => s + ti * x[i], 0) / (tNorm * xNorm) + 1) / 2;
      const level = Math.max(0, 1 - Math.abs(lvl(v) - lvl(tv)) / 40);
      scored.push({ r, v, score: 0.7 * shape + 0.3 * level });
    }
    scored.sort((a, b) => b.score - a.score);
    const head = `Players most like ${target.n} (${target.c || 'free agent'}, ${tv.tacticText || tv.caText}) at ${ts.slot ? ts.slot.label : positions.join('/')}, compared on ${keys.join(', ')}:` +
      (others.length ? `\n(Other players with that name: ${others.map(o => `${o.n} of ${o.c || 'no club'}, id ${o.id}`).join('; ')}. Use an id to pick one.)` : '');
    return [head, ...scored.slice(0, limit).map((x, i) => `${i + 1}. ${this.line(x.r, ctx, ` | similarity ${Math.round(x.score * 100)}%`, x.v)}`)].join('\n');
  }

  profile(input, ctx) {
    const { match: r, others } = this.findPlayer(input.player);
    if (!r) return `No player called "${input.player}" in the database.`;
    const v = this.view(r, ctx);
    const own = r.c === ctx.ownClub;
    const groups = {};
    this.meta.attrKeys.forEach((k, i) => { (groups[this.meta.attrGroups[i]] ||= []).push(`${k} ${v.attrText(k)}`); });
    const gk = this.bestPosition(r) === 'GK';
    const out = [this.line(r, ctx)];
    if (ctx.visibility === 'attributes') {
      const spots = POS_KEYS.filter((p, i) => r.pr[i] >= 15);
      out.push(`Position ratings (TrueDoF, from attributes): ${spots.map(p => `${p} ${ratingAt(k => r.at[this.attrIndex[k]] || 0, p).toFixed(1)}`).join(', ')}`);
    }
    if (ctx.tactic && ctx.tactic.slots.length) {
      const fits = ctx.tactic.slots.map(s => ({ s, t: rateSlot(ctx.tactic, s, v.attr, p => r.pr[POS_KEYS.indexOf(p)] || 0) }))
        .filter(x => x.t.fit > 0).sort((a, b) => b.t.score - a.t.score).slice(0, 3);
      out.push(`Best slots in our tactic: ${fits.map(x => `${x.s.index}. ${x.s.label} ${x.s.roles} tactic ${x.t.score.toFixed(1)}${x.t.goals != null ? ` (eng ${x.t.goals >= 0 ? '+' : ''}${x.t.goals.toFixed(1)})` : ''}`).join('; ') || 'none (no familiar position)'}`);
    }
    out.push(`Positions (1-20): ${POS_KEYS.map((p, i) => [p, r.pr[i]]).filter(x => x[1] >= 10).map(x => `${x[0]} ${x[1]}`).join(', ')}`);
    for (const g of ['technical', 'mental', 'physical', ...(gk ? ['goalkeeping'] : [])]) out.push(`${g}: ${groups[g].join(', ')}`);
    if (this.seesHidden(ctx, own)) out.push(`hidden: ${this.hiddenKeys.map((k, i) => `${k} ${r.hd[i]}`).join(', ')}`);
    else out.push(ctx.visibility === 'attributes' ? 'hidden attributes: not visible (same as in the game)' : 'hidden attributes: unknown (our judging ability is too low to read them)');
    if (this.seesPersonality(ctx, own)) out.push(`personality: ${this.persKeys.map((k, i) => `${k} ${r.ps[i]}`).join(', ')}`);
    else out.push('personality: unknown');
    out.push(`Other facts: nationality ${r.nat || '?'}, height ${r.h || '?'} cm, foot ${r.ft || '?'}, reputation ${r.rep ?? '?'}${r.mo ? `, morale ${r.mo}/20` : ''}`);
    if (others.length) out.push(`(Other players with that name: ${others.map(o => `${o.n} of ${o.c || 'no club'} (id ${o.id})`).join('; ')})`);
    return out.join('\n');
  }

  addToShortlist(input, ctx) {
    const { match: r } = this.findPlayer(input.player);
    if (!r) return `No player called "${input.player}" in the database, so nothing was added.`;
    const file = path.join(ctx.dataDir, 'shortlist.txt');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
    if (new RegExp(`^\\s*uid:\\s*${r.id}\\b`, 'm').test(text)) return `${r.n} is already on the shortlist.`;
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}uid:${r.id}   # ${r.n} (${r.c || 'free agent'})\n`);
    return `Added ${r.n} (${r.c || 'free agent'}) to shortlist.txt. His full report appears in the briefing after the next F8 / Refresh from FM.`;
  }
}

module.exports = { PlayerDatabase, expandPositions, norm };
