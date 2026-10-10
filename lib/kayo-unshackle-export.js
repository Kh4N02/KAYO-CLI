'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { vodManifestUrlForDownload } = require('./mpd-formatter');

const ROOT = path.join(__dirname, '..');
const CMD_EXE = process.env.KAYO_CMD_EXE || process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';

function resolveUnshackleExe() {
  const explicit = String(process.env.KAYO_UNSHACKLE_EXE || '').trim();
  if (explicit) return explicit;

  const home = String(process.env.KAYO_UNSHACKLE || '').trim();
  if (home) {
    const venvExe = path.join(home, '.venv', 'Scripts', 'unshackle.exe');
    if (fs.existsSync(venvExe)) return venvExe;
    const scriptsExe = path.join(home, 'Scripts', 'unshackle.exe');
    if (fs.existsSync(scriptsExe)) return scriptsExe;
  }
  return 'unshackle';
}

function normalizeKid(kid) {
  return String(kid || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

/** Unshackle v2 export — import re-fetches the MPD; keys come from stub track entries. */
function buildUnshackleExport({
  assetId,
  title,
  manifestUrl,
  keys = [],
  drmSystem = 'playready',
}) {
  const id = String(assetId || 'kayo');
  const manifest = vodManifestUrlForDownload(manifestUrl);
  const keyMap = {};
  for (const entry of keys) {
    const kid = normalizeKid(entry.kid);
    const key = normalizeKid(entry.key);
    if (kid.length === 32 && key.length === 32) {
      keyMap[kid] = key;
    }
  }

  const stubTrack = {
    type: 'Video',
    id: '1',
    url: manifest,
    language: 'en',
    is_original_lang: true,
    descriptor: 'DASH',
    needs_repack: false,
    name: title,
    keys: keyMap,
    drm: [{ system: drmSystem === 'playready' ? 'PlayReady' : 'Widevine' }],
  };

  return {
    version: 2,
    service: String(process.env.KAYO_UNSHACKLE_SERVICE || 'kayo'),
    region: String(process.env.KAYO_UNSHACKLE_REGION || 'AU'),
    titles: {
      [id]: {
        meta: {
          id,
          name: title || id,
          type: 'movie',
          language: 'en',
        },
        manifest_url: manifest,
        manifest_type: 'DASH',
        tracks: {
          1: stubTrack,
        },
      },
    },
  };
}

function launchUnshackleImport(exportDoc, { title, saveDir = null } = {}) {
  const outDir = saveDir ? path.resolve(saveDir) : ROOT;
  fs.mkdirSync(outDir, { recursive: true });
  const exportPath = path.join(outDir, `_kayo_unshackle_${Date.now()}.json`);
  fs.writeFileSync(exportPath, JSON.stringify(exportDoc, null, 2), 'utf8');

  const unshackle = resolveUnshackleExe();
  const batchPath = path.join(outDir, `_kayo_unshackle_${Date.now()}.bat`);
  const importCmd = `"${unshackle}" import "${exportPath}"`;
  const batchBody = [
    '@echo off',
    'cd /d "%~dp0"',
    `title Kayo unshackle — ${title || 'download'}`,
    'chcp 65001 >nul',
    'set PYTHONUTF8=1',
    importCmd,
    '',
  ].join('\r\n');
  fs.writeFileSync(batchPath, batchBody, 'utf8');

  const launch = `start "" "${CMD_EXE}" /k "${batchPath}"`;
  spawn(launch, { shell: true, detached: true, stdio: 'ignore', cwd: ROOT }).unref();

  return { exportPath, batchPath, command: importCmd, unshackleExe: unshackle };
}

module.exports = { buildUnshackleExport, launchUnshackleImport, resolveUnshackleExe };
