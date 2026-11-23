'use strict';
// Your tactic, as you describe it in two plain text files in %LOCALAPPDATA%\TrueDoF\:
//
//   tactic.txt                    formation, style, priority attributes and the 11 slots
//   wanted-player-attributes.txt  free text: which attributes matter for this tactic and why
//
// tactic.txt format (lines starting with # are comments; unknown lines are reported, never fatal):
//
//   name: ZaZ - Ace of Diamonds 2.0
//   formation: 4-1-2-3-0 / 5-2-0-3-0        (in possession / out of possession)
//   style: Gegenpress
//   priority: pace, acceleration
//
//   GK-GK  = Ball-Playing Goalkeeper / Sweeper Keeper
//   DM-DC  = Defensive Midfielder / Centre-Back
//   AM(C)-AM(R) = Second Striker / Winger
//
// A slot line is "<position in possession>-<position out of possession> = <role in possession> /
// <role out of possession>". FM26/27 give every player one role with the ball and one without, often
// in a different spot on the pitch. One position or one role on its own means "the same in both".
// A duty in brackets after a role, e.g. "Winger (Attack)", is kept if you write one.
//
// Everything here is plain text parsing: no game memory involved.

const fs = require('fs');
const path = require('path');

const POSITIONS = ['GK', 'SW', 'DL', 'DC', 'DR', 'DM', 'ML', 'MC', 'MR', 'AML', 'AMC', 'AMR', 'ST', 'WBL', 'WBR'];
// Everyday names people write instead of FM's codes.
const POSITION_ALIASES = {
  CB: 'DC', LB: 'DL', RB: 'DR', LWB: 'WBL', RWB: 'WBR', CDM: 'DM', CM: 'MC', CAM: 'AMC', AM: 'AMC',
  LW: 'AML', RW: 'AMR', LM: 'ML', RM: 'MR', CF: 'ST', STC: 'ST',
};

// Attribute names as stored in the dump (technical, mental, physical, goalkeeping).
const ATTRIBUTES = [
  'corners', 'crossing', 'dribbling', 'finishing', 'firstTouch', 'freeKicks', 'heading', 'longShots', 'longThrows', 'marking',
  'passing', 'penaltyTaking', 'tackling', 'technique',
  'aggression', 'anticipation', 'bravery', 'composure', 'concentration', 'decisions', 'determination', 'flair', 'leadership',
  'offTheBall', 'positioning', 'teamwork', 'vision', 'workRate',
  'acceleration', 'agility', 'balance', 'jumpingReach', 'naturalFitness', 'pace', 'stamina', 'strength',
  'aerialReach', 'commandOfArea', 'communication', 'eccentricity', 'handling', 'kicking', 'oneOnOnes', 'punching', 'reflexes',
  'rushingOut', 'throwing',
];
const ATTRIBUTE_ALIASES = {
  jumpreach: 'jumpingReach', jumping: 'jumpingReach', acc: 'acceleration', pac: 'pace', speed: 'pace', sta: 'stamina',
  wor: 'workRate', ant: 'anticipation', str: 'strength', bal: 'balance', con: 'concentration', fitness: 'naturalFitness',
  nfi: 'naturalFitness', otb: 'offTheBall', dec: 'decisions', det: 'determination', tec: 'technique', fir: 'firstTouch',
};

const squash = s => String(s).toLowerCase().replace(/[^a-z]/g, '');

/** "AM(C)" → "AMC", "cb" → "DC". Returns null when it isn't a position. */
function normalisePosition(text) {
  const t = String(text || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (POSITIONS.includes(t)) return t;
  return POSITION_ALIASES[t] || null;
}

/** "Jump Reach" → "jumpingReach". Returns null when unknown. */
function normaliseAttribute(text) {
  const t = squash(text);
  if (!t) return null;
  const hit = ATTRIBUTES.find(a => a.toLowerCase() === t);
  return hit || ATTRIBUTE_ALIASES[t] || null;
}

/** "Winger (Attack)" → { role: 'Winger', duty: 'Attack' }. */
function splitRole(text) {
  const m = String(text || '').trim().match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return m ? { role: m[1].trim(), duty: m[2].trim() || null } : { role: String(text || '').trim(), duty: null };
}

/** A value like "(e.g. Gegenpress / Vertical tiki-taka)" is the template's hint, not a real answer. */
function isPlaceholder(v) { return !v || /^\(?\s*e\.?g\.?/i.test(v) || /^\(.*\)$/.test(v.trim()) || /^<.*>$/.test(v.trim()); }

/**
 * Parse tactic.txt. Never throws: problems are collected in `problems` so the briefing can still be built.
 * @returns {{ name, formation: {inPossession, outOfPossession}, style, priority: string[], slots: object[], problems: string[] }}
 */
function parseTactic(text) {
  const t = { name: null, formation: { inPossession: null, outOfPossession: null }, style: null, priority: [], slots: [], problems: [] };
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const where = `line ${i + 1} ("${line.slice(0, 60)}")`;

    // Header lines: "key: value"
    const header = line.match(/^(name|formation|style|priority|priorities|role ?weight)\s*:\s*(.*)$/i);
    if (header) {
      const key = header[1].toLowerCase(), val = header[2].trim();
      if (key === 'name') t.name = val || null;
      else if (key.startsWith('role')) {
        const n = Number(val.replace('%', '').trim());
        if (Number.isFinite(n) && n >= 0 && n <= 100) t.roleWeight = n;
        else t.problems.push(`${where}: role weight must be a number from 0 to 100`);
      }
      else if (key === 'style') t.style = isPlaceholder(val) ? null : val;
      else if (key === 'formation') {
        const [ip, oop] = val.split('/').map(s => s.trim());
        t.formation.inPossession = ip || null;
        t.formation.outOfPossession = oop || ip || null;
      } else {
        for (const part of val.split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
          const a = normaliseAttribute(part);
          if (a) { if (!t.priority.includes(a)) t.priority.push(a); }
          else t.problems.push(`${where}: "${part}" is not an attribute name I know`);
        }
      }
      return;
    }

    // Slot lines: "IP-OOP = role / role"
    const eq = line.indexOf('=');
    if (eq < 0) { t.problems.push(`${where}: not understood (expected "name:", "formation:", "style:", "priority:" or "POS-POS = role / role")`); return; }
    const posText = line.slice(0, eq).trim(), roleText = line.slice(eq + 1).trim();
    const posParts = posText.split('-').map(s => s.trim()).filter(Boolean);
    const ip = normalisePosition(posParts[0]), oop = normalisePosition(posParts[1] || posParts[0]);
    if (!ip || !oop || posParts.length > 2) { t.problems.push(`${where}: "${posText}" is not a position like DC, DM-DC or AM(C)-AM(R)`); return; }
    const roleParts = roleText.split('/').map(s => s.trim()).filter(Boolean);
    if (!roleParts.length) { t.problems.push(`${where}: no role after "="`); return; }
    const ipRole = splitRole(roleParts[0]), oopRole = splitRole(roleParts[1] || roleParts[0]);
    t.slots.push({
      inPossession: { position: ip, role: ipRole.role, duty: ipRole.duty },
      outOfPossession: { position: oop, role: oopRole.role, duty: oopRole.duty },
    });
  });
  if (t.slots.length && t.slots.length !== 11) t.problems.push(`${t.slots.length} position lines found; a tactic has 11`);
  if (t.slots.length && !t.slots.some(s => s.inPossession.position === 'GK')) t.problems.push('no GK line found');
  return t;
}

/**
 * Read the manager's tactic from the data folder. Returns null when there is no tactic.txt.
 * Never throws: an unreadable file becomes a tactic with a problem note.
 */
function readTactic(dataDir) {
  const file = path.join(dataDir, 'tactic.txt');
  let tactic;
  try {
    if (!fs.existsSync(file)) return null;
    tactic = parseTactic(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    tactic = parseTactic('');
    tactic.problems.push(`could not read tactic.txt: ${e.message}`);
  }
  tactic.source = 'tactic.txt';
  tactic.wantedAttributes = readWantedAttributes(dataDir, tactic);
  return tactic;
}

const MAX_WANTED_CHARS = 2500;   // keeps the briefing small; the file is a short guide, not a book

function readWantedAttributes(dataDir, tactic) {
  const file = path.join(dataDir, 'wanted-player-attributes.txt');
  try {
    if (!fs.existsSync(file)) return null;
    let text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
    if (text.length > MAX_WANTED_CHARS) {
      text = text.slice(0, MAX_WANTED_CHARS) + '…';
      tactic.problems.push(`wanted-player-attributes.txt is long; only the first ${MAX_WANTED_CHARS} characters are used`);
    }
    return text || null;
  } catch (e) {
    tactic.problems.push(`could not read wanted-player-attributes.txt: ${e.message}`);
    return null;
  }
}

/** "DM→DC" when the player moves between phases, "DC" when he doesn't. */
function slotLabel(s) {
  return s.inPossession.position === s.outOfPossession.position ? s.inPossession.position
    : `${s.inPossession.position}→${s.outOfPossession.position}`;
}

function roleLabel(r) { return r.duty ? `${r.role} (${r.duty})` : r.role; }

/** The tactic as briefing lines. */
function tacticLines(t) {
  const out = [];
  const f = t.formation;
  out.push(`Tactic "${t.name || 'unnamed'}" | shape in possession ${f.inPossession || '?'}, out of possession ${f.outOfPossession || '?'}` +
    ` | style ${t.style || 'not set'} | source ${t.source || '?'}`);
  if (t.priority.length) out.push(`Priority attributes (the manager's top requirement for every role): ${t.priority.join(', ')}`);
  out.push('Slots (position with ball→without ball: role with ball / role without ball):');
  t.slots.forEach((s, i) => out.push(`${String(i + 1).padStart(2)}. ${slotLabel(s)}: ${roleLabel(s.inPossession)} / ${roleLabel(s.outOfPossession)}`));
  if (t.wantedAttributes) {
    out.push('Manager\'s attribute guide for this tactic (his own words):');
    out.push(...t.wantedAttributes.split('\n').filter(l => l.trim()).map(l => `  ${l.trim()}`));
  }
  if (t.problems.length) out.push(`(tactic file notes: ${t.problems.join('; ')})`);
  return out;
}

module.exports = { parseTactic, readTactic, tacticLines, slotLabel, roleLabel, normalisePosition, normaliseAttribute, ATTRIBUTES, POSITIONS };
