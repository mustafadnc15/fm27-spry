'use strict';
// Rating players for the slots of YOUR tactic (1.0-20.0), instead of for generic positions.
//
// A slot rating mixes two things:
//
//  1. Role fit (40%): the attributes FM highlights for the slot's two roles (with and without the ball),
//     key attributes x2, preferable x1, both roles counting half. See roles.js.
//  2. Tactic fit (60%): the manager's own attribute guide (wanted-player-attributes.txt) plus the
//     tactic's priority attributes. The guide's "Pace: 12-20++" lines become curves, e.g.
//       minimum requirement (6-12): each point below 6 costs double, each point above 12 counts 0.3
//       special (12-20*):           points below 12 count 0.3, points above 12 count 1.5
//       priority (+ / ++):          straight line, heavy weight
//     Tactic fit gets the bigger share because that guide is about what actually wins matches in the
//     match engine; FM's highlighted role attributes are a looser guide. Goalkeepers are rated on
//     their role only (the guide is about outfield players).
//
// The slot rating is then multiplied by position familiarity (natural 1.0, accomplished 0.9, ...),
// averaged over the two positions the slot uses (e.g. DM with the ball, DC without).

const fs = require('fs');
const path = require('path');
const { ATTRIBUTES, normaliseAttribute, normalisePosition, slotLabel, roleLabel, readTactic } = require('./tactic');
const { findRole, readRoleOverrides } = require('./roles');
const { ratingAt } = require('./ratings');

const DEFAULT_ROLE_WEIGHT = 0.4;              // role attributes' share with only a guide / priorities
const DEFAULT_ROLE_WEIGHT_WITH_ENGINE = 0.25; // ... and with measured engine weights (role-to-attribute.txt)
const WEIGHTS = { top: 5, priority: 4, minimum: 2, good: 1, special: 2 };
const DEFENDER_POSITIONS = ['DC', 'DL', 'DR', 'WBL', 'WBR', 'SW'];

// ---------------------------------------------------------------- the attribute guide

// "jumpingReach" → ["jumping reach"], plus a few everyday spellings.
const SPOKEN = Object.fromEntries(ATTRIBUTES.map(a => [a, [a.replace(/([A-Z])/g, ' $1').toLowerCase()]]));
SPOKEN.jumpingReach.push('jump reach');
SPOKEN.offTheBall.push('off ball');

function attributesIn(text) {
  const t = ` ${String(text).toLowerCase().replace(/[^a-z]+/g, ' ')} `;
  return ATTRIBUTES.filter(a => SPOKEN[a].some(w => t.includes(` ${w} `)));
}

const CATEGORY = [[/^priorit/i, 'priority'], [/^minimum/i, 'minimum'], [/^special/i, 'special'], [/^good/i, 'good']];

/**
 * Turn the manager's guide into rules: [{ attr, lo, hi, kind, weight }].
 * Understands lines like "Minimum requirements: … Work Rate, Anticipation …" (the attribute's category)
 * and "Pace: 12-20++" (its range; ++ top priority, + priority, * special). Anything else is ignored.
 */
function parseGuide(text) {
  const category = {}, ranges = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const range = line.match(/^([A-Za-z][A-Za-z ]*?)\s*:\s*(\d{1,2})\s*-\s*(\d{1,2})\s*(\+\+|\+|\*)?\s*$/);
    if (range) {
      const attr = normaliseAttribute(range[1]);
      if (attr) ranges[attr] = { lo: Number(range[2]), hi: Number(range[3]), mark: range[4] || '' };
      continue;
    }
    const cat = line.match(/^([A-Za-z ]+?)\s*:(.*)$/);
    if (!cat) continue;
    const kind = (CATEGORY.find(([re]) => re.test(cat[1].trim())) || [])[1];
    if (kind) for (const a of attributesIn(cat[2])) if (!category[a]) category[a] = kind;
  }
  const defaults = { priority: [12, 20], minimum: [6, 12], special: [12, 20], good: [6, 12] };
  const rules = [];
  for (const attr of new Set([...Object.keys(ranges), ...Object.keys(category)])) {
    const r = ranges[attr];
    const kind = r && r.mark === '++' ? 'top' : r && r.mark === '+' ? 'priority' : r && r.mark === '*' ? 'special' : category[attr] || 'minimum';
    const [lo, hi] = r ? [r.lo, r.hi] : defaults[kind === 'top' ? 'priority' : kind];
    rules.push({ attr, lo, hi, kind, weight: WEIGHTS[kind] });
  }
  return rules;
}

/** How much an attribute value is worth under a rule (same 1-20 scale, but bent). */
function curve(rule, v) {
  const { lo, hi, kind } = rule;
  if (kind === 'top' || kind === 'priority') return v;
  if (kind === 'special') return v < lo ? lo - (lo - v) * 0.3 : lo + (v - lo) * 1.5;
  const below = kind === 'good' ? 1.5 : 2;
  if (v < lo) return lo - (lo - v) * below;
  if (v > hi) return hi + (v - hi) * 0.3;
  return v;
}

// ---------------------------------------------------------------- measured match-engine weights

// role-to-attribute.txt: a table "Attribute  Team  ST  AM  WB  CB  DM" of goals per season for +1 in one
// attribute of one player in that position group; "*" marks a confirmed effect. Only confirmed values are
// used (the study itself says anything else should be read as "not shown"). Hidden/personality rows
// (Pressure, Important Matches, ...) are kept apart: the manager can't see them in FM.
function parseEngineWeights(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const hi = lines.findIndex(l => /^\s*attribute\s+team\b/i.test(l));
  if (hi < 0) return null;
  const cols = lines[hi].trim().split(/\s+/).slice(1).map(c => c.toUpperCase());
  const weights = Object.fromEntries(cols.map(c => [c, {}]));
  const hidden = [];
  for (const raw of lines.slice(hi + 1)) {
    const cells = raw.trim().split(/\t+|\s{2,}/);
    if (cells.length < cols.length + 1) continue;
    const vals = cells.slice(-cols.length);
    if (!vals.every(v => /^[+-]?\d*\.?\d+\*?$/.test(v.trim()))) continue;
    const name = cells.slice(0, cells.length - cols.length).join(' ').replace(/[†*]/g, '').trim();
    const attr = normaliseAttribute(name);
    if (!attr) { hidden.push(name); continue; }
    cols.forEach((c, i) => { const v = vals[i].trim(); if (v.endsWith('*')) weights[c][attr] = parseFloat(v); });
  }
  return { groups: cols.filter(c => c !== 'TEAM'), weights, hidden };
}

// Which tested position group(s) a slot's position belongs to. The study used a 3-4-2-1, so central
// midfield is a mix of its DM and AM groups and wide midfield a mix of AM and WB.
const GROUP_OF = {
  DC: ['CB'], SW: ['CB'], DL: ['WB'], DR: ['WB'], WBL: ['WB'], WBR: ['WB'],
  DM: ['DM'], MC: ['DM', 'AM'], ML: ['AM', 'WB'], MR: ['AM', 'WB'], AMC: ['AM'], AML: ['AM'], AMR: ['AM'], ST: ['ST'],
};

/** Confirmed goals-per-season weight of each attribute for a slot (averaged over its groups). */
function slotEngineWeights(engine, slot) {
  if (!engine || isGkSlot(slot)) return {};
  // A forward role played from attacking midfield (e.g. Second Striker at AMC) is half ST, half AM.
  const groupsFor = (pos, role) => (role && role.line === 'ST' && pos !== 'ST' ? ['ST', ...(GROUP_OF[pos] || [])] : (GROUP_OF[pos] || []));
  const groups = [...groupsFor(slot.ip.position, slot.ip.role), ...groupsFor(slot.oop.position, slot.oop.role)]
    .filter(g => engine.weights[g]);
  if (!groups.length) return {};
  const out = {};
  for (const g of groups) for (const [a, w] of Object.entries(engine.weights[g])) out[a] = (out[a] || 0) + w / groups.length;
  return out;
}

// ---------------------------------------------------------------- the model of the tactic

/**
 * Everything needed to rate players for a tactic. tactic may be null (then: roles only).
 * overrides: roles.txt overrides (roles.js readRoleOverrides().overrides).
 */
function buildModel(tactic, overrides = {}, engine = null) {
  const rules = tactic && tactic.wantedAttributes ? parseGuide(tactic.wantedAttributes) : [];
  for (const a of (tactic && tactic.priority) || []) {
    const r = rules.find(x => x.attr === a);
    if (r) r.weight = Math.max(r.weight, WEIGHTS.priority) + 1;   // named in both places: a little extra
    else rules.push({ attr: a, lo: 12, hi: 20, kind: 'priority', weight: WEIGHTS.priority });
  }
  const problems = [];
  const slots = ((tactic && tactic.slots) || []).map((s, i) => {
    const ip = findRole(s.inPossession.role, 'ip', overrides), oop = findRole(s.outOfPossession.role, 'oop', overrides);
    if (!ip) problems.push(`slot ${i + 1}: role "${s.inPossession.role}" not in TrueDoF's role table (rated on position instead)`);
    if (!oop) problems.push(`slot ${i + 1}: role "${s.outOfPossession.role}" not in TrueDoF's role table (rated on position instead)`);
    return {
      index: i + 1, label: slotLabel(s), roles: `${roleLabel(s.inPossession)} / ${roleLabel(s.outOfPossession)}`,
      ip: { position: s.inPossession.position, role: ip }, oop: { position: s.outOfPossession.position, role: oop },
      anyOf: null,
    };
  });
  // How much FM's role attributes count. Default: small when measured engine weights exist (the study
  // found FM's highlighted defending/role attributes have no measurable effect), larger with only a guide.
  const fallback = engine ? DEFAULT_ROLE_WEIGHT_WITH_ENGINE : DEFAULT_ROLE_WEIGHT;
  const roleWeight = tactic && tactic.roleWeight != null ? tactic.roleWeight / 100 : (rules.length || engine ? fallback : 1);
  const model = { tactic, rules, slots, problems, overrides, engine, roleWeight };
  for (const s of slots) s.engine = slotEngineWeights(engine, s);
  return model;
}

const isGkSlot = slot => slot.ip.position === 'GK';
const isDefenderSlot = slot => DEFENDER_POSITIONS.includes(slot.oop.position) || DEFENDER_POSITIONS.includes(slot.ip.position);

function roleAverage(get, role, position) {
  if (!role) return ratingAt(get, position);   // unknown role: TrueDoF's generic position rating
  let total = 0, weights = 0;
  role.key.forEach(k => { total += 2 * (get(k) || 0); weights += 2; });
  role.pref.forEach(k => { total += get(k) || 0; weights += 1; });
  return weights ? total / weights : 0;
}

const THRESHOLD_ONLY_WEIGHT = 0.03;   // guide attribute with no confirmed engine effect: only its threshold counts
const PRIORITY_MIN_WEIGHT = 0.1;      // tactic.txt priority attribute: never weighs less than this

/**
 * The tactic part of the rating, on the 1-20 scale, plus (with engine weights) an estimate of the
 * player's worth in goals per season compared with an all-10 player in this slot.
 */
function tacticFit(get, model, slot) {
  if (isGkSlot(slot)) return null;
  const rule = a => model.rules.find(r => r.attr === a);
  const eng = slot.engine || {};
  if (Object.keys(eng).length) {
    const w = { ...eng };
    for (const r of model.rules) if (!(r.attr in w)) w[r.attr] = THRESHOLD_ONLY_WEIGHT;
    for (const a of (model.tactic && model.tactic.priority) || []) w[a] = Math.max(w[a] || 0, PRIORITY_MIN_WEIGHT);
    let total = 0, weights = 0, goals = 0;
    for (const [a, wt] of Object.entries(w)) {
      const v = get(a) || 0, r = rule(a);
      total += wt * (r ? curve(r, v) : v); weights += wt;
      if (a in eng) goals += eng[a] * ((r ? curve(r, v) : v) - 10);
    }
    return { score: total / weights, goals };
  }
  if (!model.rules.length) return null;
  let total = 0, weights = 0;
  for (const r of model.rules) {
    const w = r.kind === 'special' && isDefenderSlot(slot) ? r.weight + 1 : r.weight;
    total += w * curve(r, get(r.attr) || 0); weights += w;
  }
  return { score: total / weights, goals: null };
}

// Position familiarity (FM's 1-20 per position) → multiplier.
function familiarity(r) { return r >= 20 ? 1 : r >= 18 ? 0.97 : r >= 15 ? 0.9 : r >= 10 ? 0.75 : r >= 5 ? 0.5 : 0; }

function positionFit(prOf, slot) {
  if (slot.anyOf) return Math.max(...slot.anyOf.map(p => familiarity(prOf(p) || 0)));
  return (familiarity(prOf(slot.ip.position) || 0) + familiarity(prOf(slot.oop.position) || 0)) / 2;
}

const round1 = x => Math.round(x * 10) / 10;

/**
 * Rate one player for one slot.
 * get(attr) → 1-20, prOf(position) → FM's 1-20 familiarity there.
 * Returns { rating (attributes only), fit (position multiplier), score (= rating x fit), role, tactic }.
 */
function rateSlot(model, slot, get, prOf) {
  const role = (roleAverage(get, slot.ip.role, slot.ip.position) + roleAverage(get, slot.oop.role, slot.oop.position)) / 2;
  const tac = tacticFit(get, model, slot);
  const rating = Math.max(1, Math.min(20, tac == null ? role : (1 - model.roleWeight) * tac.score + model.roleWeight * role));
  const fit = positionFit(prOf, slot);
  return {
    rating: round1(rating), fit, score: round1(rating * fit), role: round1(role),
    tactic: tac == null ? null : round1(tac.score), goals: tac && tac.goals != null ? Math.round(tac.goals * 100) / 100 : null,
  };
}

/**
 * Best XI for the tactic. candidates: [{ id, get, prOf, ref }]. Greedy (best pair first), then swaps
 * between slots and with the bench while that raises the total. Simple and close to the true optimum.
 */
function bestXI(model, candidates) {
  const n = model.slots.length;
  const cache = new Map();
  const score = (si, c) => {
    const k = `${si}|${c.id}`;
    if (!cache.has(k)) cache.set(k, rateSlot(model, model.slots[si], c.get, c.prOf));
    return cache.get(k);
  };
  const pairs = [];
  model.slots.forEach((_, si) => candidates.forEach(c => { const r = score(si, c); if (r.fit > 0) pairs.push({ si, c, s: r.score }); }));
  pairs.sort((a, b) => b.s - a.s);
  const pick = new Array(n).fill(null), used = new Set();
  for (const p of pairs) if (!pick[p.si] && !used.has(p.c.id)) { pick[p.si] = p.c; used.add(p.c.id); }

  const val = (si, c) => (c ? score(si, c).score : 0);
  for (let round = 0, better = true; better && round < 50; round++) {
    better = false;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {   // swap two starters
        if (!pick[a] || !pick[b]) continue;
        if (score(a, pick[b]).fit > 0 && score(b, pick[a]).fit > 0 &&
            val(a, pick[b]) + val(b, pick[a]) > val(a, pick[a]) + val(b, pick[b]) + 1e-9) {
          [pick[a], pick[b]] = [pick[b], pick[a]]; better = true;
        }
      }
      for (const c of candidates) {      // bring someone in from the bench
        if (used.has(c.id)) continue;
        if (val(a, c) > val(a, pick[a]) + 1e-9) { if (pick[a]) used.delete(pick[a].id); pick[a] = c; used.add(c.id); better = true; }
      }
    }
  }
  const slots = model.slots.map((slot, si) => {
    const c = pick[si];
    return c ? { slot, c, ...score(si, c) } : { slot, c: null };
  });
  return { slots, total: slots.reduce((t, s) => t + (s.score || 0), 0) };
}

/**
 * What the Director means by a "tactic_slot": a slot number ("6"), a position ("DM", "DM-DC", "AM(R)"),
 * a role in the tactic ("Second Striker") or any role at all ("IF" → an extra slot with that role, rated
 * with the tactic's attribute guide). Returns a slot or null.
 */
function resolveSlot(model, text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const n = Number(t.replace(/^slot\s*/i, ''));
  if (Number.isInteger(n) && n >= 1 && n <= model.slots.length) return model.slots[n - 1];
  const parts = t.split(/\s*(?:->|→|>|-)\s*/).map(normalisePosition);
  if (parts.length === 2 && parts[0] && parts[1]) {
    const s = model.slots.find(x => x.ip.position === parts[0] && x.oop.position === parts[1]);
    if (s) return s;
  }
  const pos = normalisePosition(t);
  if (pos) return model.slots.find(x => x.ip.position === pos) || model.slots.find(x => x.oop.position === pos) || null;
  const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const inTactic = model.slots.find(x => [x.ip.role, x.oop.role].some(r => r && (squash(r.abbr) === squash(t) || r.names.some(nm => squash(nm) === squash(t)))));
  if (inTactic) return inTactic;
  const role = findRole(t, 'ip', model.overrides) || findRole(t, 'oop', model.overrides);
  if (!role || !role.positions || !role.positions.length) return null;
  const extra = {
    index: null, label: `${role.abbr || role.name} (not in the tactic)`, roles: role.name,
    ip: { position: role.positions[0], role }, oop: { position: role.positions[0], role }, anyOf: role.positions,
  };
  extra.engine = slotEngineWeights(model.engine, extra);
  return extra;
}

/** The attributes that matter for a slot (for "similar player" comparisons). */
function slotAttributes(model, slot) {
  const set = new Set();
  for (const r of [slot.ip.role, slot.oop.role]) if (r) [...r.key, ...r.pref].forEach(a => set.add(a));
  if (!isGkSlot(slot)) model.rules.forEach(r => set.add(r.attr));
  return [...set];
}

/** One line per rule, for the briefing: how TrueDoF reads the manager's guide. */
function describeRules(model) {
  const words = { top: 'top priority', priority: 'priority', minimum: 'minimum', good: 'good to have', special: 'counts most above' };
  return model.rules.map(r => `${r.attr} ${r.kind === 'special' ? `${r.lo}+` : `${r.lo}-${r.hi}`} (${words[r.kind]})`).join(', ');
}

// Purity's FM27 study (FM-Arena, see docs/credits.md), used when the manager has no table of his own.
const BUILT_IN_WEIGHTS = path.join(__dirname, '..', 'docs', 'engine-weights-study.txt');

function readEngineWeights(dataDir, problems) {
  const own = path.join(dataDir, 'role-to-attribute.txt');
  try {
    const file = fs.existsSync(own) ? own : fs.existsSync(BUILT_IN_WEIGHTS) ? BUILT_IN_WEIGHTS : null;
    if (!file) return null;
    const e = parseEngineWeights(fs.readFileSync(file, 'utf8'));
    if (!e) problems.push(`${path.basename(file)}: no "Attribute Team ST AM WB CB DM" table found`);
    else e.source = file === own ? 'role-to-attribute.txt' : 'built-in study by Purity (FM-Arena)';
    return e;
  } catch (err) {
    problems.push(`could not read role-to-attribute.txt: ${err.message}`);
    return null;
  }
}

/**
 * Everything from the data folder in one go: tactic.txt, wanted-player-attributes.txt, roles.txt and
 * role-to-attribute.txt. Works with any of them missing. Never throws.
 */
function loadModel(dataDir) {
  const problems = [];
  let tactic = null;
  try { tactic = readTactic(dataDir); } catch (e) { problems.push(`tactic.txt: ${e.message}`); }
  const ro = readRoleOverrides(dataDir);
  const engine = readEngineWeights(dataDir, problems);
  const model = buildModel(tactic, ro.overrides, engine);
  model.problems.push(...ro.problems, ...problems);
  return model;
}

/** What drives the rating, for the briefing. */
function describeModel(model) {
  const parts = [];
  if (model.engine) parts.push(`measured match-engine value per attribute and position (${model.engine.source || 'role-to-attribute.txt'}, confirmed effects only)`);
  if (model.rules.length) parts.push(`the manager's attribute guide: ${describeRules(model)}`);
  parts.push(`FM role attributes ${Math.round(model.roleWeight * 100)}%`);
  return parts.join('; ');
}

module.exports = {
  parseGuide, curve, parseEngineWeights, slotEngineWeights, buildModel, loadModel, rateSlot, bestXI, resolveSlot,
  slotAttributes, describeRules, describeModel, familiarity,
};
