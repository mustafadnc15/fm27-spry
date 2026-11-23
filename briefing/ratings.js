'use strict';
// Position ratings: judging a player from his attributes, the way you do in FM with attribute
// masking off (where CA and PA are never shown). For each position group we list the
// attributes that matter most; the first six count double. Result: 1.0-20.0.

const KEY_ATTRS = {
  GK: ['reflexes', 'handling', 'oneOnOnes', 'commandOfArea', 'aerialReach', 'positioning', 'communication', 'kicking', 'concentration', 'decisions', 'agility'],
  DC: ['marking', 'tackling', 'heading', 'positioning', 'jumpingReach', 'anticipation', 'strength', 'concentration', 'bravery', 'composure', 'pace'],
  FB: ['tackling', 'marking', 'pace', 'crossing', 'positioning', 'stamina', 'acceleration', 'workRate', 'dribbling', 'passing', 'teamwork'],
  DM: ['tackling', 'positioning', 'anticipation', 'passing', 'decisions', 'teamwork', 'workRate', 'composure', 'concentration', 'strength', 'stamina'],
  MC: ['passing', 'firstTouch', 'decisions', 'vision', 'technique', 'teamwork', 'workRate', 'stamina', 'composure', 'anticipation', 'offTheBall'],
  W: ['dribbling', 'pace', 'acceleration', 'crossing', 'technique', 'firstTouch', 'flair', 'offTheBall', 'agility', 'passing', 'finishing'],
  AMC: ['passing', 'vision', 'technique', 'firstTouch', 'decisions', 'flair', 'dribbling', 'composure', 'offTheBall', 'longShots', 'agility'],
  ST: ['finishing', 'composure', 'offTheBall', 'firstTouch', 'anticipation', 'pace', 'acceleration', 'heading', 'dribbling', 'strength', 'technique'],
};

const POS_KEYS = ['GK', 'SW', 'DL', 'DC', 'DR', 'DM', 'ML', 'MC', 'MR', 'AML', 'AMC', 'AMR', 'ST', 'WBL', 'WBR'];

function styleGroup(pos) {
  if (pos === 'GK') return 'GK';
  if (pos === 'DC' || pos === 'SW') return 'DC';
  if (['DL', 'DR', 'WBL', 'WBR'].includes(pos)) return 'FB';
  if (pos === 'DM') return 'DM';
  if (pos === 'MC') return 'MC';
  if (['ML', 'MR', 'AML', 'AMR'].includes(pos)) return 'W';
  if (pos === 'AMC') return 'AMC';
  return 'ST';
}

/** Rating 1.0-20.0 at a position, given a function that returns an attribute's value (1-20). */
function ratingAt(getAttr, pos) {
  const keys = KEY_ATTRS[styleGroup(pos)];
  let total = 0, weights = 0;
  keys.forEach((k, i) => { const w = i < 6 ? 2 : 1; total += (getAttr(k) || 0) * w; weights += w; });
  return Math.round((total / weights) * 10) / 10;
}

/** Attribute getter for a briefing/dump player object. */
function dumpGetter(p) {
  return k => (p.technical || {})[k] ?? (p.mental || {})[k] ?? (p.physical || {})[k] ?? (p.goalkeeping || {})[k] ?? 0;
}

/** A dump player's best position (highest position rating byte; ties: first natural). */
function bestPosition(p) {
  if (p.naturalPositions && p.naturalPositions.length) return p.naturalPositions[0];
  let best = 0, at = 'ST';
  for (const [k, v] of Object.entries(p.positionRatings || {})) if (v > best) { best = v; at = k; }
  return at;
}

module.exports = { KEY_ATTRS, POS_KEYS, styleGroup, ratingAt, dumpGetter, bestPosition };
