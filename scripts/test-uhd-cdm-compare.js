#!/usr/bin/env node
'use strict';

/**
 * F1 / UHD: fetch playback + compare PlayReady (.prd) vs Widevine L1 (.wvd) key paths.
 * Usage: node scripts/test-uhd-cdm-compare.js [assetId]
 */

const fs = require('fs');
const { loadEnv, authenticate, tokenForPlayback } = require('../lib/kayo-api');
const { resolvePlaybackProxied } = require('../lib/playback');
const { playReadyPrdPath, widevineWvdPath } = require('../lib/cdm-device');

const assetId = process.argv[2] || '47lg4yrp7l7j1p9432wz832v3';

function log(m) {
  process.stdout.write(`${m}\n`);
}

async function runOnce(label, envPatch) {
  for (const [k, v] of Object.entries(envPatch)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  log(`\n=== ${label} ===`);
  const result = await resolvePlaybackProxied({
    assetId,
    authToken: process.env.__TEST_TOKEN,
    isUhd: true,
    onStatus: (m) => log(`* ${m}`),
  });
  const s = result.streams?.[0];
  const drmLine = (result.logs || []).find((l) => /^PlayReady:|^Widevine:/.test(l));
  log(`cdn=${s?.cdnName} max=${s?.maxHeight} keys=${s?.keys?.length} drmLog=${drmLine || '?'}`);
  return s;
}

(async () => {
  loadEnv();
  log(`devices: PR=${playReadyPrdPath()}`);
  log(`devices: WV=${widevineWvdPath()}`);
  process.env.__TEST_TOKEN = tokenForPlayback((m) => log(`auth: ${m}`))
    || await authenticate((m) => log(`auth: ${m}`));

  let auto;
  try {
    auto = await runOnce('auto (webos-widevine → L1 first)', { KAYO_DRM_FIRST: '' });
  } catch (e) {
    log(`FAIL auto: ${e.message}`);
    process.exit(1);
  }
  if (!auto?.keys?.length) {
    log('No keys — fix Playback API 403 first (AU VPN / KAYO_BROWSER_PROXY=127.0.0.1:7897).');
    process.exit(2);
  }

  for (const [label, drm] of [['PlayReady only', 'playready'], ['Widevine L1 only', 'widevine']]) {
    try {
      await runOnce(label, { KAYO_DRM_FIRST: drm, KAYO_UHD_PROFILE: 'webos-widevine' });
    } catch (e) {
      log(`${label}: ${e.message}`);
    }
  }
})().catch((e) => {
  log(`FAIL: ${e.message}`);
  process.exit(1);
});
