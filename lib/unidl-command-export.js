'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolvePython } = require('./python-resolve');
const {
  winPathToWsl,
  convertUnidlCommandForWslScript,
  wslBridgePreflightShellLines,
  wslManifestPreflightShellLines,
  wslLivePipeMuxTmpShellLines,
  wslUnidlTmpCleanupShellLines,
  wslLiveRecordingHintsShellLines,
  wslUnidlPreambleShellLines,
} = require('./unidl-wsl');
const { resolveBridgeBind, manifestPathFromBridgedCmd } = require('./kayo-cdn-bridge');

function resolveUnidlCommandsDir() {
  const custom = String(process.env.KAYO_UNIDL_COMMANDS_DIR || '').trim();
  if (custom) return path.resolve(custom);
  return path.join(__dirname, '..', 'unidl-commands');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${String(Date.now()).slice(-6)}`;
}

function safeFileStem(name) {
  return String(name || 'kayo')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '.')
    .slice(0, 120) || 'kayo';
}

function writeBridgeKeeperBat({ port, origin, outDir, kayoRoot }) {
  if (!port || !origin) return null;
  const root = kayoRoot || path.join(__dirname, '..');
  let py;
  try {
    py = resolvePython();
  } catch {
    py = { command: 'python', prefix: [] };
  }
  const bridgePy = path.join(root, 'lib', 'kayo-cdn-bridge.py');
  const batPath = path.join(outDir, `_kayo_bridge_port_${port}.bat`);
  const bind = resolveBridgeBind();
  const pyLine = [
    py.command,
    ...py.prefix,
    `"${bridgePy}"`,
    '--origin',
    `"${origin}"`,
    '--port',
    String(port),
    '--bind',
    bind,
  ].join(' ');
  const body = [
    '@echo off',
    'title Kayo CDN bridge (keep this window open while recording in WSL)',
    `echo Bridge listen ${bind}:${port} ^(localhost + WSL host IP^) -^> ${origin}`,
    'echo Close OTHER bridge windows on this port before starting (stale bridge = manifest 403).',
    'echo Upstream proxy: KAYO_PROXY_TUNNEL unless KAYO_BRIDGE_DIRECT=1 in kayo_cmd .env',
    'echo Leave this window open while UniDL runs in Ubuntu/WSL.',
    pyLine,
    '',
  ].join('\r\n');
  fs.writeFileSync(batPath, body, 'utf8');
  return batPath;
}

/**
 * Save HBO-style command under %USERPROFILE%\.unidl\commands\kayo for Ubuntu `kayo` picker.
 */
function saveKayoUnidlCommand({
  cmdLine,
  saveName,
  saveDir,
  keys = [],
  bridgePort,
  bridgeOrigin,
  title,
  wslScriptPath,
}) {
  const dir = resolveUnidlCommandsDir();
  fs.mkdirSync(dir, { recursive: true });
  const stem = `${safeFileStem(saveName || title)}_${stamp()}`;
  const txtPath = path.join(dir, `${stem}.txt`);
  const shPath = path.join(dir, `${stem}.sh`);

  const keyComments = (keys || [])
    .map((k) => `#   ${k.kid}:${k.key}`)
    .join('\n');

  const bridgeNote = bridgePort
    ? [
      '#',
      `# Windows: start CDN bridge first (leave window open):`,
      `#   ${path.join(dir, `_kayo_bridge_port_${bridgePort}.bat`)}`,
      `# WSL reaches bridge at http://$(grep nameserver /etc/resolv.conf | awk '{print $2}'):${bridgePort}/...`,
      '#',
    ].join('\n')
    : '';

  const wslCmd = convertUnidlCommandForWslScript(cmdLine, bridgePort);
  const manifestPath = manifestPathFromBridgedCmd(cmdLine, bridgePort);
  const wslOutDir = saveDir ? winPathToWsl(path.resolve(saveDir)) : null;
  const logDir = String(process.env.KAYO_UNIDL_LOG_DIR || '').trim();
  const safeLogStem = String(saveName || title || 'kayo').replace(/[^\w\-]/g, '_');
  const logPathWsl = logDir ? winPathToWsl(path.join(logDir, `${safeLogStem}.log`)) : null;
  const txtBody = [
    wslCmd,
    '',
    bridgeNote,
    '# keys:',
    keyComments || '#   (none)',
    '',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(txtPath, txtBody, 'utf8');

  const venvRaw = String(process.env.KAYO_UNIDL_WSL_VENV || '').trim();
  const venv = venvRaw && !/YOUR_USER/i.test(venvRaw) ? venvRaw.replace(/\\/g, '/') : '';
  const venvBlock = venv
    ? [
      `VENV=${JSON.stringify(venv)}`,
      'if [[ -f "$VENV/bin/activate" ]]; then . "$VENV/bin/activate"; fi',
    ]
    : [];

  const shBody = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"',
    ...venvBlock,
    'WIN_HOST="$(grep -m1 nameserver /etc/resolv.conf | awk \'{print $2}\')"',
    'if [[ -z "$WIN_HOST" ]]; then echo "Could not detect Windows host IP"; exit 1; fi',
    `echo "Kayo live — bridge on Windows $WIN_HOST${bridgePort ? `:${bridgePort}` : ''}"`,
    ...wslUnidlPreambleShellLines(),
    ...wslLivePipeMuxTmpShellLines(cmdLine),
    ...wslLiveRecordingHintsShellLines({
      saveDirWsl: wslOutDir,
      saveName: saveName || title,
      logPathWsl,
    }),
    ...wslBridgePreflightShellLines(bridgePort),
    ...wslManifestPreflightShellLines(manifestPath),
    `echo ${JSON.stringify(`Running: ${wslCmd}`)}`,
    wslCmd,
    ...wslUnidlTmpCleanupShellLines(),
    '',
  ].join('\n');
  fs.writeFileSync(shPath, shBody, { encoding: 'utf8', mode: 0o755 });

  const bridgeBat = writeBridgeKeeperBat({
    port: bridgePort,
    origin: bridgeOrigin,
    outDir: dir,
  });

  return {
    commandsDir: dir,
    txtPath,
    shPath,
    wslScriptPath: winPathToWsl(shPath),
    bridgeBat,
  };
}

module.exports = {
  resolveUnidlCommandsDir,
  saveKayoUnidlCommand,
  writeBridgeKeeperBat,
};
