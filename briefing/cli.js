#!/usr/bin/env node
'use strict';
// Usage:
//   node briefing/cli.js                      reads %LOCALAPPDATA%\TrueDoF\dump-latest.json, writes briefing.txt next to it
//   node briefing/cli.js path\to\dump.json    use another dump
//   node briefing/cli.js --print              also print the briefing in the terminal

const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildBriefing, estimateTokens } = require('./briefing');

function dataDir() {
  // Same folder the plugin writes to (.NET's LocalApplicationData).
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'TrueDoF');
  return path.join(os.homedir(), '.local', 'share', 'TrueDoF');
}

function main() {
  const args = process.argv.slice(2);
  const print = args.includes('--print');
  const file = args.find(a => !a.startsWith('--')) || path.join(dataDir(), 'dump-latest.json');

  if (!fs.existsSync(file)) {
    console.error(`No dump found at ${file}\nLoad your save in FM27 and press F8 first.`);
    process.exit(1);
  }
  let dump;
  try {
    dump = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    console.error(`Could not read ${file}: ${e.message}`);
    process.exit(1);
  }

  const text = buildBriefing(dump);
  const outFile = path.join(path.dirname(file), 'briefing.txt');
  fs.writeFileSync(outFile, text, 'utf8');
  if (print) console.log(text);
  console.log(`Briefing written to ${outFile} (~${estimateTokens(text)} tokens, ${text.length} characters).`);
}

main();
