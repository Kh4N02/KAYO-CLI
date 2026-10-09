#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { loadEnv } = require('../lib/kayo-api');
const { agentForSpec, requestBufferOnce, proxyCandidates } = require('../lib/proxy-request');

const TARGETS = [
  { name: 'Kayo home', url: 'https://www.kayosports.com.au/' },
  { name: 'Playback API (HEAD)', url: 'https://api.playback.indazn.com/v5/Playback' },
  { name: 'Auth API (HEAD)', url: 'https://authentication-prod.ar.indazn.com/v5/SignIn' },
];

function log(m) {
  process.stdout.write(`${m}\n`);
}

(async () => {
  loadEnv();
  log('Kayo connectivity\n');
  log('Note: HEAD on Playback/Auth often shows 400/403 even when GET+JWT works. Real test is below.\n');

  for (const spec of ['127.0.0.1:7897', ...proxyCandidates().filter((p) => p && !p.includes('127.0.0.1'))]) {
    if (!spec) continue;
    const label = spec.split(':').slice(0, 2).join(':');
    log(`Quick probe (Node) via ${label}:`);
    const agent = agentForSpec(spec, 20000);
    if (!agent) {
      log('  invalid proxy spec\n');
      continue;
    }
    for (const t of TARGETS) {
      try {
        const r = await requestBufferOnce(t.url, {
          method: 'HEAD',
          agent,
          timeout: 20000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' },
        });
        log(`  ${t.name}: HTTP ${r.statusCode}`);
      } catch (e) {
        log(`  ${t.name}: ${e.status ? `HTTP ${e.status}` : e.message}`);
      }
    }
    log('');
  }

  log('--- SignIn + 1080p vs 4K Playback (curl_cffi / Chrome TLS) ---\n');
  const py = path.join(__dirname, 'kayo-auth-playback-diag.py');
  const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [py], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: process.env,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0 && r.status != null) {
    log(`\nDiag exit ${r.status}`);
  }

  log('\nCDN tip: KAYO_VOD_CDN=ac-vod or fs-vod (TROUBLESHOOTING-403.md)');
})().catch((e) => {
  log(`FAIL: ${e.message}`);
  process.exit(1);
});
