'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getDownloaderMode } = require('./downloader-mode');
const { launchNm3u8DlCommand } = require('./launch-download');
const { buildUnshackleExport, launchUnshackleImport } = require('./kayo-unshackle-export');
const { buildUnidlDownloadCommand } = require('./mpd-formatter');

const ROOT = path.join(__dirname, '..');
const CMD_EXE = process.env.KAYO_CMD_EXE || process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';

function resolveUnidlExe() {
  return String(process.env.KAYO_UNIDL_EXE || 'unidl').trim() || 'unidl';
}

function launchUnidlTui({ assetId, title }) {
  const unidl = resolveUnidlExe();
  const batchPath = path.join(ROOT, `_kayo_unidl_tui_${Date.now()}.bat`);
  const batchBody = [
    '@echo off',
    'cd /d "%~dp0"',
    'title UniDL — Kayo',
    `set KAYO_CMD_PATH=${ROOT}`,
    unidl,
    '',
  ].join('\r\n');
  fs.writeFileSync(batchPath, batchBody, 'utf8');
  spawn(`start "" "${CMD_EXE}" /k "${batchPath}"`, {
    shell: true,
    detached: true,
    stdio: 'ignore',
    cwd: ROOT,
  }).unref();
  return {
    mode: 'tui',
    batchPath,
    assetId,
    title,
    hint: `In UniDL: Kayo → Open URL / ID → ${assetId} (or search "${title || assetId}")`,
  };
}

async function launchUnidlDownload({ pick, title, saveDir }) {
  if (!pick?.manifestUrl || !pick?.keys?.length) {
    throw new Error('UniDL download needs manifest URL and keys from playback');
  }
  const outDir = saveDir ? path.resolve(saveDir) : ROOT;
  const built = buildUnidlDownloadCommand(
    pick.manifestUrl,
    pick.keys,
    title,
    {
      cdnUpstreamBase: pick.cdnUpstreamBase,
      manifestUrl: pick.manifestUrl,
      saveDir: outDir,
    },
  );
  if (!built?.cmd) throw new Error('Could not build unidl download command');

  const launched = await launchNm3u8DlCommand(built.cmd, {
    saveDir: outDir,
    title,
    cdnUpstreamBase: built.cdnUpstreamBase,
    manifestUrl: pick.manifestUrl,
  });
  return { mode: 'unidl-cli', ...launched };
}

async function launchDownload({
  cmd,
  pick,
  result,
  title,
  item,
  assetId,
  saveDir = null,
}) {
  const mode = getDownloaderMode();
  const stream = pick || result?.downloadStream;

  if (mode === 'unidl') {
    const unidlMode = String(process.env.KAYO_UNIDL || 'headless').trim().toLowerCase();
    if (unidlMode === 'tui') {
      return launchUnidlTui({ assetId, title: title || result?.title });
    }
    return launchUnidlDownload({
      pick: stream,
      title: title || result?.title,
      saveDir: saveDir || stream?.saveDir,
    });
  }

  if (mode === 'unshackle') {
    if (!stream?.manifestUrl || !stream?.keys?.length) {
      throw new Error('Unshackle export needs manifest URL and keys from playback');
    }
    const exportDoc = buildUnshackleExport({
      assetId,
      title: title || result?.title,
      manifestUrl: stream.manifestUrl,
      keys: stream.keys,
      drmSystem: stream.drm || 'playready',
    });
    return launchUnshackleImport(exportDoc, {
      title: title || result?.title,
      saveDir: saveDir || ROOT,
    });
  }

  return launchNm3u8DlCommand(cmd, {
    saveDir,
    title: title || result?.title,
    cdnUpstreamBase: stream?.cdnUpstreamBase,
    manifestUrl: stream?.manifestUrl,
  });
}

module.exports = { launchDownload, launchUnidlTui, launchUnidlDownload };
