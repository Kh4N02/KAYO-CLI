'use strict';

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { playReadyPrdPath, widevineWvdPath, localCdmAvailable } = require('./cdm-device');
const { pythonCommandArgs } = require('./python-resolve');

const SCRIPT = path.join(__dirname, 'cdm_local.py');

function pythonSpawnArgs(extraArgs) {
  return pythonCommandArgs([...extraArgs]);
}

let child;
let pending;
const queue = [];

function ensureServer() {
  if (child) return;
  const prd = playReadyPrdPath();
  const wvd = widevineWvdPath();
  if (!prd || !wvd) {
    throw new Error('Local CDM device files not found in cmds/ (need .prd + .wvd)');
  }
  const { command, args } = pythonSpawnArgs([SCRIPT, 'serve', prd, wvd]);
  child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const res = JSON.parse(line);
    if (!pending) return;
    const { resolve, reject } = pending;
    pending = null;
    if (res.ok) resolve(res);
    else reject(new Error(res.error || 'cdm_local failed'));
    drainQueue();
  });
  child.stderr.on('data', (d) => {
    if (pending) {
      pending.reject(new Error(String(d).trim()));
      pending = null;
    }
  });
  child.on('exit', () => {
    child = null;
    while (queue.length) queue.shift().reject(new Error('Local CDM exited'));
    if (pending) {
      pending.reject(new Error('Local CDM exited'));
      pending = null;
    }
  });
}

function drainQueue() {
  if (pending || !queue.length || !child) return;
  pending = queue.shift();
  child.stdin.write(`${pending.req}\n`);
}

function request(obj) {
  ensureServer();
  return new Promise((resolve, reject) => {
    queue.push({ req: JSON.stringify(obj), resolve, reject });
    drainQueue();
  });
}

function normalizeKeys(keys) {
  return (keys || []).map((k) => ({
    kid: String(k.kid).replace(/-/g, '').toLowerCase(),
    key: String(k.key).replace(/-/g, '').toLowerCase(),
  }));
}

async function playReadyRound(initData) {
  const session = crypto.randomUUID();
  const { challenge_b64: challengeB64 } = await request({
    cmd: 'pr_challenge',
    init_data: initData,
    session,
  });
  return { session, challengeB64 };
}

async function playReadyKeys(session, licenseB64) {
  const res = await request({ cmd: 'pr_keys', session, license_b64: licenseB64 });
  return normalizeKeys(res.keys);
}

async function widevineRound(pssh) {
  const session = crypto.randomUUID();
  const { challenge_b64: challengeB64 } = await request({
    cmd: 'wv_challenge',
    pssh,
    session,
  });
  return { session, challengeB64 };
}

async function widevineKeys(session, licenseB64) {
  const res = await request({ cmd: 'wv_keys', session, license_b64: licenseB64 });
  return normalizeKeys(res.keys);
}

module.exports = {
  localCdmAvailable,
  playReadyRound,
  playReadyKeys,
  widevineRound,
  widevineKeys,
};
