#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { resolvePython, pythonCommandArgs } = require('../lib/python-resolve');

const ROOT = path.join(__dirname, '..');
const REQUIREMENTS = path.join(ROOT, 'requirements.txt');
const CHECK_ONLY = process.argv.includes('--check-only');

function hasPyplayready() {
  const py = resolvePython();
  const { command, args } = pythonCommandArgs(['-m', 'pip', 'show', 'pyplayready'], py);
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true }).status === 0;
}

function runPip(installArgs) {
  const py = resolvePython();
  const { command, args } = pythonCommandArgs(['-m', 'pip', ...installArgs], py);
  return spawnSync(command, args, { stdio: 'inherit', windowsHide: true, cwd: ROOT });
}

function main() {
  let py;
  try {
    py = resolvePython();
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }

  console.log(`Python ${py.version} (${py.raw})`);

  if (CHECK_ONLY && hasPyplayready()) {
    process.exit(0);
  }

  console.log('Installing Python DRM libs...');
  const result = runPip(['install', '-r', REQUIREMENTS]);
  process.exit(result.status ?? 1);
}

main();
