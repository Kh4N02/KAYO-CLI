'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const DEFAULT_WSL_EXE = 'C:\\Program Files\\WSL\\wsl.exe';

function wslExePath() {
  const custom = String(process.env.KAYO_WSL_EXE || process.env.WSL_EXE || '').trim();
  if (custom && fs.existsSync(custom)) return custom;
  if (fs.existsSync(DEFAULT_WSL_EXE)) return DEFAULT_WSL_EXE;
  const hit = spawnSync('where', ['wsl'], { encoding: 'utf8', windowsHide: true });
  if (hit.status === 0) {
    const line = String(hit.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (line) return line;
  }
  return 'wsl.exe';
}

/** Live --live-pipe-mux needs POSIX FIFOs; run UniDL inside WSL from Windows kayo_cmd. */
function shouldRunUnidlViaWsl({ isLiveRecord = false } = {}) {
  if (process.platform !== 'win32') return false;
  if (!isLiveRecord) return false;

  const mode = String(process.env.KAYO_UNIDL_WSL || 'auto').trim().toLowerCase();
  if (mode === '0' || mode === 'false' || mode === 'off') return false;
  if (mode === '1' || mode === 'true' || mode === 'on') return true;
  // auto: use WSL when available
  const probe = spawnSync(wslExePath(), ['-e', 'true'], { windowsHide: true, timeout: 15000 });
  return probe.status === 0;
}

function winPathToWsl(windowsPath) {
  if (!windowsPath) return windowsPath;
  const raw = String(windowsPath).trim();
  if (raw.startsWith('/mnt/')) return raw.replace(/\\/g, '/');
  const normalized = raw.replace(/\//g, '\\');
  const match = /^([a-zA-Z]):\\(.*)$/.exec(normalized);
  if (!match) return raw.replace(/\\/g, '/');
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

function wslDistro() {
  return String(process.env.KAYO_UNIDL_WSL_DISTRO || process.env.WSL_DISTRO || 'Ubuntu').trim() || 'Ubuntu';
}

/** Rewrite Windows paths; bridge 127.0.0.1 → ${WIN_HOST} for WSL2 → Windows CDN bridge. */
/** Bash lines: verify Windows CDN bridge before UniDL (avoids silent manifest timeout). */
function wslBridgePreflightShellLines(bridgePort) {
  if (!bridgePort) return [];
  const p = String(bridgePort);
  return [
    `BRIDGE_PORT=${p}`,
    'BRIDGE_TEST="http://${WIN_HOST}:${BRIDGE_PORT}/"',
    'echo "Checking CDN bridge at $BRIDGE_TEST ..."',
    'BRIDGE_CODE="$(curl -s --connect-timeout 4 --max-time 15 -o /dev/null -w \'%{http_code}\' "$BRIDGE_TEST" 2>/dev/null || echo 000)"',
    'if [[ "$BRIDGE_CODE" == "000" ]]; then',
    '  echo ""',
    '  echo "ERROR: Cannot reach the Kayo CDN bridge on Windows ($BRIDGE_TEST)."',
    `  echo "  • Run _kayo_bridge_port_${p}.bat on Windows and leave that window open."`,
    '  echo "  • Bridge must bind 0.0.0.0 (default on Windows in kayo_cmd .env: KAYO_BRIDGE_BIND)."',
    `  echo "  • If needed, allow inbound TCP ${p} from WSL in Windows Firewall."`,
    '  exit 1',
    'fi',
    'echo "Bridge reachable (HTTP $BRIDGE_CODE) — starting UniDL (pick tracks when prompted, e.g. 1,9)."',
  ];
}

function wslUnidlPreambleShellLines() {
  return [
    'if ! command -v unidl >/dev/null 2>&1; then',
    '  echo "unidl not found in PATH. Install in WSL (pip) or set KAYO_UNIDL_WSL_VENV in kayo_cmd .env."',
    '  exit 1',
    'fi',
  ];
}

function isWslDrvFsPath(unixPath) {
  return /^\/mnt\/[a-z]\//i.test(String(unixPath || '').trim());
}

function usesLivePipeMux(cmdLine) {
  return /--live-pipe-mux\b/.test(String(cmdLine || ''));
}

/** NTFS (/mnt/c, /mnt/d, …) cannot create FIFOs — pipe-mux needs a native Linux tmp dir. */
function wslLivePipeMuxTmpShellLines(cmdLine) {
  if (!usesLivePipeMux(cmdLine)) return [];

  const custom = String(process.env.KAYO_UNIDL_WSL_TMP_DIR || '').trim().replace(/\\/g, '/');
  const useCustom = custom && !isWslDrvFsPath(custom);

  if (useCustom) {
    return [
      `KAYO_WSL_TMP=${JSON.stringify(custom)}`,
      'mkdir -p "$KAYO_WSL_TMP"',
      'echo "Live pipe-mux temp (FIFOs): $KAYO_WSL_TMP"',
    ];
  }

  return [
    'KAYO_WSL_TMP="${HOME}/.cache/kayo-unidl/tmp"',
    'mkdir -p "$KAYO_WSL_TMP"',
    'echo "Live pipe-mux temp (FIFOs): $KAYO_WSL_TMP  (WSL cannot use /mnt/d for FIFOs)"',
  ];
}

/** Where the growing .mkv lives (D: via /mnt/d) — HBO-style save-dir, separate from FIFO tmp. */
function wslLiveRecordingHintsShellLines({ saveDirWsl, saveName, logPathWsl } = {}) {
  if (!saveDirWsl || !saveName) return [];
  const lines = [
    `KAYO_OUT_DIR=${JSON.stringify(saveDirWsl)}`,
    `KAYO_OUT_NAME=${JSON.stringify(saveName)}`,
    'mkdir -p "$KAYO_OUT_DIR"',
    'echo ""',
    'echo "Output (D: drive via WSL): $KAYO_OUT_DIR/"',
    'echo "  File grows while recording: ${KAYO_OUT_NAME}*.mkv"',
    'echo "  Windows: open the same path under D:\\\\...\\\\kayo_cmd\\\\downloads\\\\..."',
  ];
  if (logPathWsl) {
    lines.push(`echo "Progress log: tail -f ${logPathWsl}"`);
  }
  lines.push(
    'echo "  Check size: ls -lh \"$KAYO_OUT_DIR\"/*.mkv 2>/dev/null || ls -lh \"$KAYO_OUT_DIR\""',
    'echo "  FIFO temp only: $KAYO_WSL_TMP (not your recording folder)"',
    'echo "  Play near the end of the file for live TV — full duration in the UI can include not-yet-muxed DVR window."',
    'echo ""',
  );
  return lines;
}

function rewriteTmpDirForWslLivePipeMux(cmdLine) {
  if (!usesLivePipeMux(cmdLine)) return cmdLine;

  let out = String(cmdLine || '');
  out = out.replace(/--tmp-dir\s+"([^"]*)"/g, (match, dir) => {
    if (isWslDrvFsPath(dir)) return '--tmp-dir "$KAYO_WSL_TMP"';
    return match;
  });
  out = out.replace(/--tmp-dir\s+(\/mnt\/[^\s]+)/g, (match, dir) => {
    if (isWslDrvFsPath(dir)) return '--tmp-dir "$KAYO_WSL_TMP"';
    return match;
  });
  return out;
}

function convertUnidlCommandForWslScript(cmdLine, bridgePort) {
  let out = String(cmdLine || '');
  out = out.replace(/"([A-Za-z]:\\[^"]+)"/g, (_m, p) => `"${winPathToWsl(p)}"`);
  if (bridgePort) {
    const port = String(bridgePort);
    out = out.split(`127.0.0.1:${port}`).join(`\${WIN_HOST}:${port}`);
  }
  out = rewriteTmpDirForWslLivePipeMux(out);
  return out;
}

function writeWslUnidlScript({
  cmdLine,
  saveDir,
  saveName,
  title,
  bridgePort,
}) {
  const wslSaveDir = winPathToWsl(saveDir);
  const logDir = String(process.env.KAYO_UNIDL_LOG_DIR || '').trim();
  const logPathWsl = logDir && saveName
    ? winPathToWsl(path.join(logDir, `${saveName.replace(/[^\w\-]/g, '_')}.log`))
    : null;
  const inner = convertUnidlCommandForWslScript(cmdLine, bridgePort);
  const scriptName = `_kayo_unidl_wsl_${Date.now()}.sh`;
  const winScriptPath = path.join(saveDir, scriptName);
  const wslScriptPath = winPathToWsl(winScriptPath);

  const venvRaw = String(process.env.KAYO_UNIDL_WSL_VENV || '').trim();
  const venv = venvRaw && !/YOUR_USER/i.test(venvRaw) ? venvRaw.replace(/\\/g, '/') : '';
  const venvBlock = venv
    ? [
      `VENV=${JSON.stringify(venv)}`,
      'if [[ -f "$VENV/bin/activate" ]]; then . "$VENV/bin/activate"; else echo "Note: KAYO_UNIDL_WSL_VENV not found ($VENV) — using PATH"; fi',
    ]
    : [];
  const body = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"',
    ...venvBlock,
    `cd ${JSON.stringify(wslSaveDir)}`,
    'WIN_HOST="$(grep -m1 nameserver /etc/resolv.conf | awk \'{print $2}\')"',
    'if [[ -z "$WIN_HOST" ]]; then echo "Could not detect Windows host IP from /etc/resolv.conf"; exit 1; fi',
    `echo "Kayo UniDL (WSL) — bridge via Windows host $WIN_HOST${bridgePort ? `:${bridgePort}` : ''}"`,
    ...wslUnidlPreambleShellLines(),
    ...wslLivePipeMuxTmpShellLines(cmdLine),
    ...wslLiveRecordingHintsShellLines({
      saveDirWsl: wslSaveDir,
      saveName: saveName || title,
      logPathWsl,
    }),
    ...wslBridgePreflightShellLines(bridgePort),
    `echo ${JSON.stringify(`Running: ${inner}`)}`,
    inner,
    '',
  ].filter(Boolean).join('\n');

  fs.writeFileSync(winScriptPath, body, { encoding: 'utf8', mode: 0o755 });

  return { winScriptPath, wslScriptPath, scriptBody: body };
}

function launchWslUnidlScript({ wslScriptPath, winScriptPath, title }) {
  const wsl = wslExePath();
  const distro = wslDistro();
  const CMD_EXE = process.env.KAYO_CMD_EXE || process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  const titleSafe = (title || 'Kayo UniDL WSL').replace(/"/g, '');
  const batchPath = path.join(path.dirname(winScriptPath), `_kayo_wsl_launch_${Date.now()}.bat`);
  const batFinal = [
    '@echo off',
    `title Kayo UniDL WSL — ${titleSafe}`,
    'echo CDN bridge on Windows; UniDL uses WSL host IP to reach it.',
    'echo Pick tracks when prompted (e.g. 1,9).',
    `"${wsl}" -d ${distro} bash "${wslScriptPath}"`,
    '',
  ].join('\r\n');
  fs.writeFileSync(batchPath, batFinal, 'utf8');

  const launch = `start "" "${CMD_EXE}" /k "${batchPath}"`;
  spawn(launch, { shell: true, detached: true, stdio: 'ignore' }).unref();

  return { batchPath, wslScriptPath, winScriptPath, wslExe: wsl, distro };
}

function wslLaunchMode() {
  const mode = String(process.env.KAYO_UNIDL_WSL_LAUNCH || 'both').trim().toLowerCase();
  if (['save', 'save-only', 'manual'].includes(mode)) return 'save';
  if (['wsl', 'auto', 'launch'].includes(mode)) return 'wsl';
  return 'both';
}

module.exports = {
  shouldRunUnidlViaWsl,
  winPathToWsl,
  convertUnidlCommandForWslScript,
  wslBridgePreflightShellLines,
  wslLivePipeMuxTmpShellLines,
  wslLiveRecordingHintsShellLines,
  wslUnidlPreambleShellLines,
  writeWslUnidlScript,
  launchWslUnidlScript,
  wslExePath,
  wslLaunchMode,
};
