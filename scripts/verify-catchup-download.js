#!/usr/bin/env node
'use strict';

/**
 * Smoke-test catchup keys + N_m3u8DL (default: India v West Indies G3, first 100 segments).
 * Usage: node scripts/verify-catchup-download.js [assetId] [--segments N]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadEnv, authenticate } = require('../lib/kayo-api');
const { ensureCmdDevices } = require('../lib/ensure-cmd-devices');
const { resolvePlaybackProxied } = require('../lib/playback');
const { launchNm3u8DlCommand } = require('../lib/launch-download');

const DEFAULT_ASSET = '95py4lt0lyvpfx8ao2im6vedj';
const OUT = path.join(__dirname, '..', '_verify_catchup');

function parseArgs(argv) {
  let assetId = DEFAULT_ASSET;
  let segments = 100;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--segments' && argv[i + 1]) {
      segments = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--segments=')) {
      segments = Number(arg.slice('--segments='.length));
    } else if (!arg.startsWith('-')) {
      assetId = arg;
    }
  }
  return { assetId, segments };
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function findMp4(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      const nested = findMp4(full);
      if (nested) return nested;
    } else if (name.endsWith('.mp4') && !name.endsWith('.MUX.mp4')) {
      return full;
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of fs.readdirSync(OUT)) {
    fs.rmSync(path.join(OUT, name), { recursive: true, force: true });
  }

  loadEnv();
  const copied = ensureCmdDevices();
  if (copied.length) log(`Copied into cmds/: ${copied.join(', ')}`);

  const { assetId, segments } = parseArgs(process.argv.slice(2));

  log('Authenticating...');
  const token = await authenticate((m) => log(`  ${m}`));

  log(`Playback ${assetId} (catchup)...`);

  const result = await resolvePlaybackProxied({
    assetId,
    authToken: token,
    catchupReplay: true,
    onStatus: (m) => log(`  ${m}`),
  });

  const pick = result.streams.find((s) => s.recommended && s.cmd && s.keys?.length)
    || result.streams.find((s) => s.cmd && s.keys?.length);
  if (!pick) throw new Error('No stream with download command and keys');

  log(`Title: ${result.title}`);
  log(`CDN: ${pick.cdnName} · drm: ${pick.drm} · keys: ${pick.keys.length}`);
  for (const line of result.logs || []) {
    if (/Widevine:|PlayReady:|Total:|key\(s\)|failed/i.test(line)) log(`  ${line}`);
  }

  const stamp = Date.now();
  const saveName = `verify-${stamp}`;
  const rangeFlag = segments > 0 ? `--custom-range -${segments - 1}` : '';
  let cmd = `${pick.cmd} -sv best -sa lang=en:for=best -ds all ${rangeFlag}`;
  cmd = cmd.replace(/--save-name\s+"[^"]*"/, `--save-name "${saveName}"`);
  cmd = cmd.replace(/--save-dir\s+"[^"]*"/g, '');
  cmd = cmd.replace(/--tmp-dir\s+"[^"]*"/g, '');
  cmd += ` --save-dir "${OUT}" --tmp-dir "${OUT}"`;

  log(`Launching download (${segments} segments, 1080p + 384k AC-3)...`);
  const launched = await launchNm3u8DlCommand(cmd, {
    saveDir: OUT,
    title: result.title,
    cdnUpstreamBase: pick.cdnUpstreamBase,
    manifestUrl: pick.manifestUrl,
    batchOnly: true,
  });
  if (launched.bridgePort) {
    log(`CDN bridge 127.0.0.1:${launched.bridgePort} → ${launched.bridgeOrigin}`);
  }

  const run = spawnSync('cmd.exe', ['/c', launched.batchPath], {
    cwd: OUT,
    stdio: 'inherit',
    windowsHide: false,
  });

  if (run.status !== 0) {
    throw new Error(`N_m3u8DL exited ${run.status ?? 1}`);
  }

  const mp4Path = findMp4(OUT);
  if (!mp4Path) throw new Error('No output .mp4 in _verify_catchup');
  const stat = fs.statSync(mp4Path);
  log(`OK: ${mp4Path} (${(stat.size / 1024 / 1024).toFixed(1)} MiB)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
