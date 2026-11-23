'use strict';
// FM26/FM27 player roles and the attributes FM highlights for each (key = shown strongest, pref = preferable).
//
// Where these lists come from (the "basis" of each role):
//   p4fm  published FM26 role guide on passion4fm.com (see SOURCES below)
//   web   partly published: the key attributes are from a published source, the rest is filled in like fm24
//   fm24  the same-named FM24 role's highlighted attributes (FM26 kept the role; its highlights may have shifted)
//   est   new in FM26 with no published list: TrueDoF's estimate from what the role does
// Nobody has published FM27's full table. When you know better (FM highlights a role's attributes in the
// player profile), put a line in %LOCALAPPDATA%\TrueDoF\roles.txt and it overrides the table:
//   Second Striker = key: Finishing, Off the Ball, Acceleration | pref: Dribbling, Composure
//
// Abbreviations are the game's own where FMLibreEditor's notes (docs/recon/fm27-tactics-and-value.md) name
// them; the rest are TrueDoF's.

const fs = require('fs');
const path = require('path');
const { normaliseAttribute } = require('./tactic');

const SOURCES = {
  p4fm: 'passion4fm.com FM26 role guides (football-manager-26-overpowered-player-roles, football-manager-channel-midfielder-player-role-guide, player-role-guide-overlapping-centre-back-role, fm26-tactics-creation-beginners-guide)',
  web: 'FM26 coverage stating the key attributes shared by Poacher, Channel Forward and Centre Forward',
  fm24: 'FM24 highlighted attributes of the same-named role',
  est: 'TrueDoF estimate (new FM26 role, no published list)',
  file: 'your roles.txt',
};

const LINES = {
  GK: ['GK'], CB: ['DC'], FB: ['DL', 'DR'], WB: ['WBL', 'WBR', 'DL', 'DR'], DM: ['DM'], CM: ['MC'],
  AM: ['AMC'], W: ['AML', 'AMR', 'ML', 'MR'], ST: ['ST'],
};

// [abbr, name, phase ('ip' | 'oop' | 'both'), line, basis, key attributes, preferable attributes, other names]
const TABLE = [
  ['GK', 'Goalkeeper', 'both', 'GK', 'fm24', 'aerialReach commandOfArea communication handling kicking reflexes concentration positioning agility', 'oneOnOnes throwing anticipation decisions'],
  ['SK', 'Sweeper Keeper', 'both', 'GK', 'fm24', 'commandOfArea kicking oneOnOnes reflexes anticipation composure concentration positioning agility', 'aerialReach communication firstTouch handling passing rushingOut throwing vision acceleration'],
  ['BGK', 'Ball-Playing Goalkeeper', 'ip', 'GK', 'est', 'kicking passing firstTouch composure reflexes handling positioning', 'vision decisions throwing concentration agility'],
  ['NGK', 'No-Nonsense Goalkeeper', 'ip', 'GK', 'est', 'aerialReach commandOfArea handling kicking reflexes positioning', 'concentration bravery communication'],
  ['LHK', 'Line-Holding Keeper', 'oop', 'GK', 'est', 'reflexes handling positioning concentration agility', 'aerialReach oneOnOnes communication anticipation'],

  ['CB', 'Centre-Back', 'both', 'CB', 'fm24', 'heading marking tackling positioning jumpingReach strength', 'aggression anticipation bravery composure concentration decisions pace'],
  ['BCB', 'Ball-Playing Centre-Back', 'ip', 'CB', 'fm24', 'heading marking passing tackling composure positioning jumpingReach strength', 'firstTouch technique aggression anticipation bravery concentration decisions vision pace', 'Ball-Playing Defender'],
  ['NCB', 'No-Nonsense Centre-Back', 'ip', 'CB', 'fm24', 'heading marking tackling positioning jumpingReach strength', 'aggression bravery'],
  ['ACB', 'Advanced Centre-Back', 'ip', 'CB', 'est', 'passing firstTouch dribbling composure decisions vision', 'technique tackling marking positioning anticipation'],
  ['OCB', 'Overlapping Centre-Back', 'ip', 'CB', 'p4fm', 'crossing heading marking tackling anticipation workRate stamina pace strength', 'technique dribbling offTheBall aggression positioning decisions bravery composure concentration acceleration agility'],
  ['WCB', 'Wide Centre-Back', 'both', 'CB', 'fm24', 'heading marking tackling positioning jumpingReach strength', 'dribbling passing technique aggression anticipation bravery composure concentration decisions workRate pace stamina'],
  ['SCB', 'Stopping Centre-Back', 'oop', 'CB', 'est', 'tackling marking aggression bravery anticipation strength', 'positioning concentration jumpingReach heading decisions'],
  ['CCB', 'Covering Centre-Back', 'oop', 'CB', 'est', 'marking tackling anticipation concentration positioning pace', 'acceleration decisions composure heading jumpingReach'],

  ['FB', 'Full-Back', 'both', 'FB', 'fm24', 'marking tackling anticipation concentration positioning teamwork', 'crossing dribbling passing technique decisions workRate acceleration pace stamina'],
  ['IFB', 'Inverted Full-Back', 'ip', 'FB', 'fm24', 'heading marking tackling positioning strength', 'dribbling firstTouch passing technique aggression anticipation bravery composure concentration decisions pace', 'Inside Full-Back'],
  ['PFB', 'Pressing Full-Back', 'oop', 'FB', 'est', 'tackling marking workRate aggression acceleration stamina', 'anticipation positioning teamwork pace'],
  ['HFB', 'Holding Full-Back', 'oop', 'FB', 'est', 'marking tackling positioning concentration anticipation', 'teamwork decisions strength'],

  ['WB', 'Wing-Back', 'both', 'WB', 'fm24', 'crossing dribbling tackling offTheBall teamwork workRate acceleration stamina', 'firstTouch marking passing technique anticipation concentration decisions positioning agility balance pace'],
  ['IWB', 'Inverted Wing-Back', 'ip', 'WB', 'fm24', 'passing tackling anticipation decisions teamwork', 'firstTouch marking technique composure concentration positioning vision workRate acceleration agility stamina', 'Inside Wing-Back'],
  ['AWB', 'Advanced Wing-Back', 'ip', 'WB', 'p4fm', 'technique crossing passing firstTouch stamina acceleration pace naturalFitness offTheBall decisions vision anticipation teamwork', 'marking tackling positioning'],
  ['PWB', 'Playmaking Wing-Back', 'ip', 'WB', 'est', 'passing firstTouch technique vision decisions crossing', 'dribbling composure teamwork stamina acceleration'],
  ['HWB', 'Holding Wing-Back', 'oop', 'WB', 'est', 'marking tackling positioning concentration anticipation', 'teamwork stamina workRate'],

  ['DM', 'Defensive Midfielder', 'both', 'DM', 'fm24', 'tackling anticipation concentration positioning teamwork', 'marking passing aggression composure decisions workRate stamina strength'],
  ['HB', 'Half-Back', 'ip', 'DM', 'fm24', 'marking tackling anticipation composure concentration decisions positioning teamwork', 'firstTouch passing aggression bravery jumpingReach strength'],
  ['DLP', 'Deep-Lying Playmaker', 'ip', 'DM', 'fm24', 'firstTouch passing technique composure decisions teamwork vision', 'anticipation positioning balance'],
  ['DDM', 'Dropping Defensive Midfielder', 'oop', 'DM', 'est', 'marking tackling positioning concentration anticipation', 'heading jumpingReach strength teamwork', 'Dropping DM'],
  ['PDM', 'Pressing Defensive Midfielder', 'oop', 'DM', 'est', 'tackling aggression workRate stamina anticipation', 'teamwork acceleration positioning bravery', 'Pressing DM'],
  ['SDM', 'Screening Defensive Midfielder', 'oop', 'DM', 'est', 'positioning concentration decisions anticipation', 'marking tackling teamwork', 'Screening DM'],

  ['CM', 'Central Midfielder', 'both', 'CM', 'fm24', 'firstTouch passing tackling decisions teamwork', 'technique anticipation composure concentration positioning vision workRate stamina'],
  ['BBM', 'Box-to-Box Midfielder', 'ip', 'CM', 'fm24', 'passing tackling offTheBall teamwork workRate stamina', 'dribbling finishing firstTouch longShots technique aggression anticipation composure decisions positioning acceleration balance pace strength'],
  ['BBP', 'Box-to-Box Playmaker', 'ip', 'CM', 'est', 'passing firstTouch vision decisions workRate stamina', 'technique offTheBall teamwork tackling composure longShots'],
  ['CHM', 'Channel Midfielder', 'ip', 'CM', 'p4fm', 'teamwork offTheBall acceleration workRate stamina anticipation decisions composure', 'finishing longShots dribbling crossing passing vision firstTouch technique'],
  ['WCM', 'Wide Central Midfielder', 'ip', 'CM', 'est', 'passing crossing workRate stamina teamwork decisions', 'dribbling firstTouch technique offTheBall acceleration'],
  ['MP', 'Midfield Playmaker', 'ip', 'CM', 'est', 'firstTouch passing technique composure decisions vision', 'teamwork offTheBall anticipation flair'],
  ['PCM', 'Pressing Central Midfielder', 'oop', 'CM', 'est', 'workRate stamina tackling aggression', 'anticipation teamwork acceleration decisions', 'Pressing CM'],
  ['SCM', 'Screening Central Midfielder', 'oop', 'CM', 'p4fm', 'positioning concentration decisions', 'marking tackling', 'Screening CM'],

  ['AM', 'Attacking Midfielder', 'both', 'AM', 'fm24', 'firstTouch longShots passing technique anticipation decisions flair offTheBall', 'dribbling composure vision agility'],
  ['AP', 'Advanced Playmaker', 'ip', 'AM', 'fm24', 'firstTouch passing technique composure decisions offTheBall teamwork vision', 'dribbling anticipation flair agility'],
  ['FR', 'Free Role', 'ip', 'AM', 'est', 'firstTouch passing technique composure decisions flair offTheBall vision', 'dribbling anticipation agility balance'],
  ['OAM', 'Outlet Attacking Midfielder', 'oop', 'AM', 'est', 'offTheBall acceleration pace anticipation', 'firstTouch composure workRate', 'Central Outlet Attacking Midfielder|Splitting Outlet Attacking Midfielder|Central Outlet AM|Splitting Outlet AM'],
  ['TAM', 'Tracking Attacking Midfielder', 'oop', 'AM', 'est', 'workRate stamina teamwork positioning', 'tackling anticipation decisions concentration', 'Tracking AM'],

  ['W', 'Winger', 'both', 'W', 'fm24', 'crossing dribbling technique offTheBall acceleration agility', 'firstTouch passing workRate balance pace stamina'],
  ['IF', 'Inside Forward', 'ip', 'W', 'fm24', 'dribbling finishing firstTouch technique offTheBall acceleration agility', 'longShots passing anticipation composure flair vision balance pace'],
  ['IW', 'Inverted Winger', 'ip', 'W', 'fm24', 'crossing dribbling passing technique acceleration agility', 'firstTouch longShots composure decisions offTheBall vision balance pace stamina workRate', 'Inside Winger|Half-Space Winger'],
  ['PW', 'Playmaking Winger', 'ip', 'W', 'fm24', 'firstTouch passing technique composure decisions teamwork vision', 'dribbling anticipation flair offTheBall agility', 'Wide Playmaker'],
  ['WFD', 'Wide Forward', 'ip', 'W', 'est', 'finishing offTheBall acceleration pace dribbling', 'firstTouch composure heading strength anticipation'],
  ['TW', 'Tracking Winger', 'oop', 'W', 'est', 'workRate stamina teamwork tackling positioning', 'anticipation marking acceleration concentration'],
  ['IOW', 'Inverting Outlet Winger', 'oop', 'W', 'est', 'offTheBall acceleration pace anticipation', 'dribbling firstTouch composure'],
  ['WOW', 'Wide Outlet Winger', 'oop', 'W', 'est', 'offTheBall acceleration pace anticipation', 'dribbling firstTouch crossing'],

  ['CFD', 'Centre Forward', 'both', 'ST', 'web', 'offTheBall acceleration composure finishing', 'dribbling firstTouch heading technique anticipation decisions strength pace'],
  ['P', 'Poacher', 'ip', 'ST', 'web', 'offTheBall acceleration composure finishing', 'anticipation firstTouch heading technique decisions'],
  ['CF', 'Channel Forward', 'ip', 'ST', 'web', 'offTheBall acceleration composure finishing', 'pace dribbling workRate stamina anticipation'],
  ['DLF', 'Deep-Lying Forward', 'ip', 'ST', 'fm24', 'firstTouch passing technique composure decisions offTheBall teamwork', 'finishing anticipation flair vision balance strength'],
  ['TF', 'Target Forward', 'ip', 'ST', 'fm24', 'bravery heading jumpingReach strength composure offTheBall', 'finishing firstTouch aggression anticipation balance teamwork', 'Target Man'],
  ['F9', 'False Nine', 'ip', 'ST', 'fm24', 'dribbling firstTouch passing technique composure decisions offTheBall vision acceleration agility', 'finishing anticipation flair teamwork balance'],
  ['SS', 'Second Striker', 'ip', 'ST', 'fm24', 'dribbling finishing firstTouch anticipation composure offTheBall acceleration', 'passing technique concentration decisions workRate agility balance pace stamina', 'Shadow Striker'],
  ['HSF', 'Half-Space Forward', 'ip', 'ST', 'est', 'finishing offTheBall dribbling firstTouch composure acceleration', 'passing technique anticipation agility'],
  ['TCF', 'Tracking Centre Forward', 'oop', 'ST', 'est', 'workRate stamina teamwork aggression', 'anticipation acceleration tackling decisions', 'Tracking CF'],
  ['OCF', 'Outlet Centre Forward', 'oop', 'ST', 'est', 'offTheBall acceleration pace anticipation', 'strength composure firstTouch', 'Central Outlet Centre Forward|Splitting Outlet Centre Forward|Central Outlet CF|Splitting Outlet CF'],
];

const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ROLES = TABLE.map(([abbr, name, phase, line, basis, key, pref, aka]) => ({
  abbr, name, phase, line, positions: LINES[line], basis,
  key: key.split(' '), pref: pref.split(' '), names: [name, ...(aka ? aka.split('|') : [])],
}));
// Note: FM24's Shadow Striker basis for the Second Striker, FM24's Ball-Playing Defender for the BCB, etc.

/**
 * Find a role by name or abbreviation ("Full Back", "full-back", "FB", "Second Striker").
 * phase 'ip' / 'oop' prefers roles of that phase (the same abbreviation can mean two roles, e.g. W).
 * overrides: from readRoleOverrides(); they replace the attributes of a matching role.
 */
function findRole(text, phase, overrides) {
  const q = squash(text);
  if (!q) return null;
  const matches = ROLES.filter(r => squash(r.abbr) === q || r.names.some(n => squash(n) === q));
  const role = matches.find(r => r.phase === phase || r.phase === 'both') || matches[0] || null;
  const o = overrides && (overrides[q] || (role && (overrides[squash(role.name)] || overrides[squash(role.abbr)])));
  if (o) return { ...(role || { abbr: null, name: text, phase: phase || 'both', line: null, positions: [], names: [text] }), key: o.key, pref: o.pref, basis: 'file' };
  return role;
}

/** roles.txt: "Role Name = key: a, b, c | pref: d, e". Returns { overrides, problems }. Never throws. */
function parseRoleOverrides(text) {
  const overrides = {}, problems = [];
  String(text || '').replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = line.match(/^(.+?)=(.*)$/);
    if (!m) { problems.push(`roles.txt line ${i + 1}: expected "Role = key: … | pref: …"`); return; }
    const parts = { key: [], pref: [] };
    for (const seg of m[2].split('|')) {
      const s = seg.match(/^\s*(key|pref|preferable)\s*:(.*)$/i);
      if (!s) { problems.push(`roles.txt line ${i + 1}: "${seg.trim()}" should start with key: or pref:`); continue; }
      const bucket = s[1].toLowerCase() === 'key' ? 'key' : 'pref';
      for (const a of s[2].split(',').map(x => x.trim()).filter(Boolean)) {
        const attr = normaliseAttribute(a);
        if (attr) parts[bucket].push(attr); else problems.push(`roles.txt line ${i + 1}: "${a}" is not an attribute`);
      }
    }
    if (parts.key.length) overrides[squash(m[1])] = parts;
    else problems.push(`roles.txt line ${i + 1}: no key attributes`);
  });
  return { overrides, problems };
}

function readRoleOverrides(dataDir) {
  try {
    const file = path.join(dataDir, 'roles.txt');
    if (!fs.existsSync(file)) return { overrides: {}, problems: [] };
    return parseRoleOverrides(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { overrides: {}, problems: [`could not read roles.txt: ${e.message}`] };
  }
}

module.exports = { ROLES, SOURCES, LINES, findRole, parseRoleOverrides, readRoleOverrides };
