'use strict';
// Realism mode: the Director only sees what a scout with his "judging ability" (1-20) would see.
//
// How it works, in plain words:
//  * CA, PA and attributes become RANGES. The worse his judgement, the wider the range.
//  * The true value is always somewhere inside the range (it's an honest estimate, not a lie).
//  * The estimate for each player is fixed: asking again does NOT re-roll it, so you can't
//    "fish" for the true number by repeating the question.
//  * He knows your own players better than other clubs' players (half the uncertainty).
//  * Hidden attributes and personality are only visible with decent judging ability.
//  * Contracts, wages, ages, morale and finances are facts and are never blurred.

const ATTR_GROUPS = ['technical', 'mental', 'physical', 'goalkeeping'];

// Deterministic pseudo-random number in [-1, 1] for (player, what, judging).
function noise(uid, salt) {
  let h = (2166136261 ^ (uid >>> 0)) >>> 0;
  for (const c of String(salt)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** FM-style words for an ability level (CA scale 1-200). */
function abilityWord(ca) {
  if (ca >= 170) return 'world class';
  if (ca >= 150) return 'excellent';
  if (ca >= 135) return 'very good';
  if (ca >= 120) return 'good';
  if (ca >= 105) return 'decent';
  if (ca >= 90) return 'average';
  return 'weak';
}

/** A range of total width 2w around `value`, shifted a little (but never past the true value). */
function range(value, w, n, lo, hi, step) {
  const centre = value + n * 0.6 * w;
  const round = x => Math.round(x / step) * step;
  let a = clamp(round(centre - w), lo, hi), b = clamp(round(centre + w), lo, hi);
  if (a > value) a = Math.floor(value / step) * step;   // rounding must never exclude the truth
  if (b < value) b = Math.ceil(value / step) * step;
  return [clamp(a, lo, hi), clamp(b, lo, hi)];
}

function blurPlayer(src, J, own) {
  const p = JSON.parse(JSON.stringify(src));
  const k = own ? 0.5 : 1;
  const caW = (2 + (20 - J) * 2.4) * k;          // J20: ±2 (±1 own) … J1: ±48 (±24 own)
  const attrW = Math.round(((20 - J) / 4.5) * k); // J20: exact … J1: ±4 (±2 own)

  p.caRange = range(p.ca, caW, noise(p.uid, 'ca' + J), 1, 200, 5);
  p.ca = Math.round((p.caRange[0] + p.caRange[1]) / 2);
  p.caWord = abilityWord(p.ca);
  const paRange = range(p.pa, caW * 1.4, noise(p.uid, 'pa' + J), 1, 200, 5);
  p.paRange = [Math.max(paRange[0], p.caRange[0]), Math.max(paRange[1], p.caRange[1])];
  p.pa = Math.round((p.paRange[0] + p.paRange[1]) / 2);

  p.attrRanges = {};
  for (const g of ATTR_GROUPS) {
    for (const [key, v] of Object.entries(p[g] || {})) {
      if (attrW === 0) continue;
      const r = range(v, attrW, noise(p.uid, key + J), 1, 20, 1);
      p.attrRanges[key] = r;
      p[g][key] = Math.round((r[0] + r[1]) / 2);
    }
  }

  // Hidden attributes need good judgement (and are easier to read for your own players).
  if (J < (own ? 10 : 14)) delete p.hidden;
  else if (attrW > 0) for (const key of Object.keys(p.hidden || {})) p.hidden[key] = Math.round((range(p.hidden[key], attrW, noise(p.uid, key + J), 1, 20, 1)).reduce((a, b) => a + b) / 2);
  if (J < (own ? 5 : 8)) delete p.personality;
  else if (attrW > 0) for (const key of Object.keys(p.personality || {})) p.personality[key] = Math.round((range(p.personality[key], attrW, noise(p.uid, 'pers' + key + J), 1, 20, 1)).reduce((a, b) => a + b) / 2);

  // Raw position ratings stay (FM shows positions openly); everything else is unchanged facts.
  return p;
}

/**
 * Return a copy of the dump as the Director would perceive it.
 * @param {object} dump   dump-latest.json
 * @param {number} judging 1 (hopeless) … 20 (perfect eye)
 */
function perceive(dump, judging) {
  const J = clamp(Math.round(Number(judging) || 10), 1, 20);
  const out = { ...dump, meta: { ...(dump.meta || {}) } };
  out.squad = (dump.squad || []).map(p => blurPlayer(p, J, true));
  out.shortlist = (dump.shortlist || []).map(p => blurPlayer(p, J, false));
  out.meta.realism = {
    judging: J,
    hiddenKnown: J >= 14 ? 'visible (estimated)' : J >= 10 ? 'visible for your own players only' : 'unknown',
    personalityKnown: J >= 8 ? 'visible (estimated)' : J >= 5 ? 'visible for your own players only' : 'unknown',
  };
  return out;
}

module.exports = { perceive, abilityWord, noise };
