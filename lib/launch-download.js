'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  BRIDGE_PLACEHOLDER,
  startCdnBridge,
  applyBridgeToCommand,
  cdnOriginFromUrl,
} = require('./kayo-cdn-bridge');

const ROOT = path.join(__dirname, '..');
const CMD_EXE = process.env.KAYO_CMD_EXE || process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
const NM3U8DL = process.env.KAYO_NM3U8DL || 'N_m3u8DL-RE';

function ensureDir(dir) {
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolveDownloadDir(saveDir) {
  if (saveDir) return saveDir;
  return process.env.KAYO_DOWNLOAD_DIR
    ? path.resolve(process.env.KAYO_DOWNLOAD_DIR)
    : ROOT;
}

/** Open download command (N_m3u8DL-RE via CDN bridge, or kayo-download.py) in cmd.exe. */
async function launchNm3u8DlCommand(command, {
  saveDir = null,
  title = null,
  cdnUpstreamBase = null,
  manifestUrl = null,
} = {}) {
  if (!command) {
    throw new Error('No download command to launch');
  }

  const outDir = resolveDownloadDir(saveDir);
  ensureDir(outDir);

  let cmdLine = String(command).trim();
  let bridge = null;
  const needsBridge = cmdLine.includes(BRIDGE_PLACEHOLDER);
  if (needsBridge) {
    const origin = cdnOriginFromUrl(cdnUpstreamBase)
      || cdnOriginFromUrl(manifestUrl);
    if (!origin) {
      throw new Error(
        'CDN bridge origin missing — let kayo_cmd auto-launch the download; do not copy the printed command',
      );
    }
    bridge = await startCdnBridge(origin);
    cmdLine = applyBridgeToCommand(cmdLine, bridge.port);
  } else if (cmdLine.includes('__KAYO_BRIDGE__')) {
    throw new Error('Command still contains __KAYO_BRIDGE__ — use auto-launch from kayo_cmd, do not paste manually');
  }

  if (NM3U8DL !== 'N_m3u8DL-RE' && cmdLine.startsWith('N_m3u8DL-RE')) {
    cmdLine = `${NM3U8DL}${cmdLine.slice('N_m3u8DL-RE'.length)}`;
  }

  const batchName = `_kayo_download_${Date.now()}.bat`;
  const batchPath = path.join(outDir, batchName);
  // cmd .bat treats %N as argument expansion — double % so query strings like %3A stay intact.
  const batchCmd = cmdLine.replace(/%/g, '%%');
  const batchBody = [
    '@echo off',
    'cd /d "%~dp0"',
    `title Kayo download${title ? ` — ${title}` : ''}`,
    batchCmd,
    '',
  ].join('\r\n');
  fs.writeFileSync(batchPath, batchBody, 'utf8');

  const launch = `start "" "${CMD_EXE}" /k "${batchPath}"`;
  spawn(launch, { shell: true, detached: true, stdio: 'ignore', cwd: ROOT }).unref();

  return {
    cmdExe: CMD_EXE,
    saveDir: outDir,
    batchPath,
    command: cmdLine,
    bridgePort: bridge?.port || null,
    bridgeOrigin: bridge?.origin || null,
  };
}

module.exports = { launchNm3u8DlCommand, ensureDir };
