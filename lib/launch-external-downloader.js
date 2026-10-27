'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getDownloaderMode } = require('./downloader-mode');
const { effectiveDownloaderForStream } = require('./stream-download-cmd');
const { launchNm3u8DlCommand } = require('./launch-download');
const { buildUnshackleExport, launchUnshackleImport } = require('./kayo-unshackle-export');
const { buildUnidlDownloadCommand } = require('./mpd-formatter');
const { saveKayoUnidlCommand, resolveUnidlCommandsDir } = require('./unidl-command-export');
const {
  shouldRunUnidlViaWsl,
  writeWslUnidlScript,
  launchWslUnidlScript,
  wslLaunchMode,
} = require('./unidl-wsl');
const { manifestPathFromBridgedCmd } = require('./kayo-cdn-bridge');

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

function resolveUnidlManifestForPick(pick, outDir) {
  if (pick?.liveClip && outDir) {
    const localMpd = path.join(outDir, 'manifest.mpd');
    if (fs.existsSync(localMpd)) return localMpd;
  }
  return pick?.manifestUrl;
}

async function launchUnidlDownload({ pick, title, saveDir }) {
  if (!pick?.keys?.length) {
    throw new Error('UniDL download needs keys from playback');
  }
  const outDir = saveDir
    ? path.resolve(saveDir)
    : (pick?.saveDir ? path.resolve(pick.saveDir) : null);
  const manifestForBuild = resolveUnidlManifestForPick(pick, outDir);
  if (!manifestForBuild && !pick?.cmd) {
    throw new Error('UniDL download needs manifest URL and keys from playback');
  }
  const livePerformAsVod = Boolean(pick.catchupReplay && pick.isLiveCdn);
  const isLiveRecord = Boolean(pick.isLiveCdn && !pick.liveClip && !livePerformAsVod);
  const viaWsl = shouldRunUnidlViaWsl({ isLiveRecord });
  const livePipeMux = process.platform !== 'win32' || viaWsl;
  const launchMode = isLiveRecord && viaWsl ? wslLaunchMode() : 'wsl';

  let built;
  if (pick?.cmd && String(pick.cmd).includes('unidl')) {
    built = {
      cmd: pick.cmd,
      cdnUpstreamBase: pick.cdnUpstreamBase,
      saveDir: pick.saveDir || outDir,
      saveName: pick.saveName,
    };
  } else {
    built = buildUnidlDownloadCommand(
      manifestForBuild,
      pick.keys,
      title,
      {
        cdnUpstreamBase: pick.cdnUpstreamBase,
        manifestUrl: String(pick.manifestUrl || '').startsWith('http') ? pick.manifestUrl : undefined,
        baseUrl: pick.manifestBaseUrl,
        saveDir: outDir || undefined,
        isLive: Boolean(pick.isLiveCdn),
        liveClip: Boolean(pick.liveClip),
        livePerformAsVod,
        livePipeMux,
      },
    );
  }
  if (!built?.cmd) throw new Error('Could not build unidl download command');

  const needBridgeOnly = viaWsl && launchMode === 'save';
  const launched = await launchNm3u8DlCommand(built.cmd, {
    saveDir: built.saveDir || outDir || ROOT,
    title,
    cdnUpstreamBase: built.cdnUpstreamBase,
    manifestUrl: pick.manifestBaseUrl || pick.manifestUrl,
    batchOnly: viaWsl,
  });

  let savedCommands = null;
  if (viaWsl && (launchMode === 'save' || launchMode === 'both')) {
    savedCommands = saveKayoUnidlCommand({
      cmdLine: launched.command,
      saveName: built.saveName,
      saveDir: built.saveDir || launched.saveDir,
      keys: pick.keys,
      bridgePort: launched.bridgePort,
      bridgeOrigin: launched.bridgeOrigin,
      title,
    });
  }

  if (viaWsl && (launchMode === 'wsl' || launchMode === 'both')) {
    const scripts = writeWslUnidlScript({
      cmdLine: launched.command,
      saveDir: built.saveDir || launched.saveDir,
      saveName: built.saveName,
      title,
      bridgePort: launched.bridgePort,
      manifestPath: manifestPathFromBridgedCmd(launched.command, launched.bridgePort),
    });
    const wslLaunch = launchWslUnidlScript({
      wslScriptPath: scripts.wslScriptPath,
      winScriptPath: scripts.winScriptPath,
      title,
    });
    return {
      mode: 'unidl-wsl',
      viaWsl: true,
      launchMode,
      savedCommands,
      commandsDir: savedCommands?.commandsDir || resolveUnidlCommandsDir(),
      ...launched,
      ...wslLaunch,
      wslScript: scripts.winScriptPath,
      recordingSaveDir: built.saveDir || launched.saveDir,
      recordingSaveName: built.saveName,
      hint: 'Live pipe-mux runs in WSL (Ubuntu). CDN bridge stays on Windows — keep bridge window open.',
    };
  }

  if (needBridgeOnly && savedCommands) {
    return {
      mode: 'unidl-wsl-save',
      viaWsl: true,
      launchMode: 'save',
      savedCommands,
      commandsDir: savedCommands.commandsDir,
      bridgePort: launched.bridgePort,
      bridgeOrigin: launched.bridgeOrigin,
      command: launched.command,
      recordingSaveDir: built.saveDir || launched.saveDir,
      recordingSaveName: built.saveName,
      hint: 'Saved for Ubuntu — start bridge .bat on Windows, then run the .sh in WSL.',
    };
  }

  return {
    mode: 'unidl-cli',
    livePipeMuxSkipped: isLiveRecord && process.platform === 'win32' && !livePipeMux,
    ...launched,
  };
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
  const stream = pick || result?.downloadStream;
  const eff = effectiveDownloaderForStream(stream);
  const globalMode = getDownloaderMode();

  if (eff === 'unidl') {
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

  if (globalMode === 'unshackle' && eff === 'unshackle') {
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
