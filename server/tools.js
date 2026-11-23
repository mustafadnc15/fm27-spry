'use strict';
// The Director's tools: what Claude may ask this app to do while answering.
// All of them only READ players-db.json, except add_to_shortlist, which appends a line to
// your shortlist.txt (never anything in the game).

const POSITION_HELP = 'FM position codes or common names, e.g. ["ST"], ["DC"], ["DL","WBL"], ["AMC"], ["LW"], ["CB"], ["GK"].';

const TOOLS = [
  {
    name: 'search_players',
    description:
      'Search the whole player database (every player in the leagues loaded in this save) with filters. ' +
      'Use it whenever the manager wants to find players beyond his shortlist: "find me a left back", "who can we afford up front", ' +
      '"young centre-backs with high potential". role="starter" finds players at or above the level of our current first choice at those ' +
      'positions; role="backup" finds squad players at or a bit below our starter. affordable_only applies our transfer budget and wage room. ' +
      'Results list the most relevant players, one line each, with id numbers you can pass to the other tools.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        positions: { type: 'array', items: { type: 'string' }, description: POSITION_HELP },
        role: { type: 'string', enum: ['starter', 'backup'], description: 'Set the ability window relative to our own players at these positions.' },
        min_ca: { type: 'integer', description: 'Minimum current ability (1-200).' },
        max_ca: { type: 'integer', description: 'Maximum current ability (1-200).' },
        min_pa: { type: 'integer', description: 'Minimum potential ability (1-200).' },
        min_age: { type: 'integer' },
        max_age: { type: 'integer' },
        max_fee: { type: 'integer', description: 'Most we would pay, in pounds (asking price, else value).' },
        max_wage: { type: 'integer', description: 'Highest weekly wage, in pounds.' },
        affordable_only: { type: 'boolean', description: 'Only players we can afford (fee within transfer budget, wage within our wage room); free agents and players with 6 months or less left count as affordable.' },
        contract_expiring_within_months: { type: 'integer', description: 'Only players whose contract ends within this many months.' },
        transfer_listed_only: { type: 'boolean' },
        loan_listed_only: { type: 'boolean' },
        free_agents_only: { type: 'boolean' },
        league: { type: 'string', description: 'Part of a league name, e.g. "Süper Lig".' },
        nationality: { type: 'string', description: 'Part of a nationality, e.g. "Turkey".' },
        exclude_own_club: { type: 'boolean', description: 'Default true.' },
        sort_by: { type: 'string', enum: ['ca', 'pa', 'potential', 'value', 'age'], description: 'ca (default), pa, potential (PA minus CA), value (cheapest first), age (youngest first).' },
        limit: { type: 'integer', description: 'How many to return (default 10, max 25).' },
      },
    },
  },
  {
    name: 'find_similar_players',
    description:
      'Find alternatives to a given player: players with a similar attribute profile for his position (mostly the shape of his ' +
      'attributes, partly his level). Use for "who is like X but cheaper", "alternatives to our striker", "replacement for X".',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['player'],
      properties: {
        player: { type: 'string', description: 'Player name, or his id number from an earlier result.' },
        positions: { type: 'array', items: { type: 'string' }, description: 'Compare at these positions instead of his best one. ' + POSITION_HELP },
        affordable_only: { type: 'boolean' },
        max_fee: { type: 'integer' },
        min_age: { type: 'integer' },
        max_age: { type: 'integer' },
        exclude_own_club: { type: 'boolean', description: 'Default true.' },
        limit: { type: 'integer', description: 'Default 8, max 20.' },
      },
    },
  },
  {
    name: 'get_player_profile',
    description: 'Full profile of any player in the database: all attributes, positions, hidden attributes, personality, contract and value.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['player'],
      properties: { player: { type: 'string', description: 'Player name, or his id number from an earlier result.' } },
    },
  },
  {
    name: 'add_to_shortlist',
    description: 'Add a player to the manager\'s shortlist file (shortlist.txt) so he appears in the briefing after the next refresh. Only use this when the manager asks or agrees.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['player'],
      properties: { player: { type: 'string', description: 'Player name, or preferably his id number from an earlier result.' } },
    },
  },
];

const NAMES = new Set(TOOLS.map(t => t.name));

/** Check a tool call's input before running it (it comes from the model, so treat it as untrusted). */
function validate(name, input) {
  if (!NAMES.has(name)) return `Unknown tool ${name}.`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Input must be an object.';
  const schema = TOOLS.find(t => t.name === name).input_schema;
  for (const k of schema.required || []) if (input[k] === undefined || input[k] === '') return `Missing "${k}".`;
  for (const [k, v] of Object.entries(input)) {
    const p = schema.properties[k];
    if (!p) return `Unknown field "${k}".`;
    if (p.type === 'integer' && !(typeof v === 'number' && Number.isFinite(v))) return `"${k}" must be a number.`;
    if (p.type === 'boolean' && typeof v !== 'boolean') return `"${k}" must be true or false.`;
    if (p.type === 'string' && typeof v !== 'string') return `"${k}" must be text.`;
    if (p.type === 'array' && !(Array.isArray(v) && v.every(x => typeof x === 'string'))) return `"${k}" must be a list of text.`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}.`;
  }
  return null;
}

/** Run one tool call. Returns { text, isError }. */
function runTool(db, name, input, ctx) {
  const problem = validate(name, input);
  if (problem) return { text: `Invalid input for ${name}: ${problem}`, isError: true };
  try {
    if (!db.load()) return { text: 'The player database is not available yet. Ask the manager to press F8 in FM (with the updated TrueDoF plugin) or use "Refresh from FM".', isError: true };
    if (name === 'search_players') return { text: db.search(input, ctx), isError: false };
    if (name === 'find_similar_players') return { text: db.similar(input, ctx), isError: false };
    if (name === 'get_player_profile') return { text: db.profile(input, ctx), isError: false };
    if (name === 'add_to_shortlist') return { text: db.addToShortlist(input, ctx), isError: false };
  } catch (e) {
    return { text: `Tool failed: ${e.message}`, isError: true };
  }
  return { text: `Unknown tool ${name}.`, isError: true };
}

/** A short line for the chat window, e.g. "Searching the database: ST, starter, affordable". */
function describe(name, input) {
  const i = input || {};
  if (name === 'search_players') {
    const bits = [(i.positions || []).join('/'), i.role, i.affordable_only ? 'affordable' : null,
      i.max_age ? `age ≤ ${i.max_age}` : null, i.min_pa ? `PA ≥ ${i.min_pa}` : null, i.free_agents_only ? 'free agents' : null].filter(Boolean);
    return `Searching the player database${bits.length ? ': ' + bits.join(', ') : ''}`;
  }
  if (name === 'find_similar_players') return `Looking for players similar to ${i.player || '?'}`;
  if (name === 'get_player_profile') return `Reading ${i.player || '?'}'s profile`;
  if (name === 'add_to_shortlist') return `Adding ${i.player || '?'} to your shortlist`;
  return name;
}

module.exports = { TOOLS, runTool, validate, describe };
