'use strict';

const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { resolvePython } = require('./python-resolve');

const ROOT = path.join(__dirname, '..');
const BRIDGE_SCRIPT = path.join(__dirname, 'kayo-cdn-bridge.py');
const BRIDGE_PLACEHOLDER = '__KAYO_BRIDGE__';

const activeBridges = new Map();

/** WSL reaches the bridge via the Windows host IP — bind 0.0.0.0 on Windows unless overridden. */
function resolveBridgeBind() {
  const explicit = String(process.env.KAYO_BRIDGE_BIND || '').trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') return '0.0.0.0';
  return '127.0.0.1';
}

function pickPort(preferred = 17890) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      const fallback = net.createServer();
      fallback.unref();
      fallback.listen(0, '127.0.0.1', () => {
        const port = fallback.address().port;
        fallback.close(() => resolve(port));
      });
      fallback.on('error', reject);
    });
    server.listen(preferred, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function cdnOriginFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function cdnOriginFromBase(baseUrl) {
  return cdnOriginFromUrl(baseUrl);
}

function bridgeUrl(originPort, realUrlOrPath) {
  const port = originPort;
  if (!realUrlOrPath) return `http://127.0.0.1:${port}/`;
  try {
    const u = new URL(realUrlOrPath);
    return `http://127.0.0.1:${port}${u.pathname}${u.search}`;
  } catch {
    const p = String(realUrlOrPath).startsWith('/') ? realUrlOrPath : `/${realUrlOrPath}`;
    return `http://127.0.0.1:${port}${p}`;
  }
}

function bridgeBaseFromUpstream(baseUrl, port) {
  if (!baseUrl) return `http://127.0.0.1:${port}/`;
  try {
    const u = new URL(baseUrl);
    const p = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
    return `http://127.0.0.1:${port}${p}`;
  } catch {
    return `http://127.0.0.1:${port}/`;
  }
}

function applyBridgeToCommand(cmd, port) {
  const base = `http://127.0.0.1:${port}`;
  return String(cmd || '').split(BRIDGE_PLACEHOLDER).join(base);
}

function stopBridgeOnPort(port) {
  const p = Number(port);
  if (!p) return;
  const entry = activeBridges.get(p);
  const child = entry?.child || entry;
  if (child?.pid) {
    try {
      process.kill(child.pid);
    } catch {
      /* already gone */
    }
    activeBridges.delete(p);
  }
  if (process.platform !== 'win32') return;
  if (String(process.env.KAYO_BRIDGE_KILL_STALE || '0').trim() !== '1') return;
  const ps = [
    'Get-CimInstance Win32_Process -Filter "Name=\'python.exe\' OR Name=\'py.exe\'" |',
    `Where-Object { $_.CommandLine -match 'kayo-cdn-bridge\\.py' -and $_.CommandLine -match '--port\\s+${p}\\b' } |`,
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join(' ');
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    windowsHide: true,
    timeout: 12000,
  });
}

/** Remote MPD URL on the bridge only — not --base-url directory paths (those often return 401). */
function bridgedMpdPathFromCmd(cmdLine, bridgePort) {
  if (!bridgePort || !cmdLine) return null;
  const port = String(bridgePort);
  const re = new RegExp(`127\\.0\\.0\\.1:${port}([^\\s"]+)`, 'g');
  const hay = String(cmdLine);
  let m;
  while ((m = re.exec(hay)) !== null) {
    const pathPart = m[1].split('?')[0];
    if (/\.mpd$/i.test(pathPart)) return m[1];
  }
  return null;
}

function manifestPathFromBridgedCmd(cmdLine, bridgePort) {
  return bridgedMpdPathFromCmd(cmdLine, bridgePort);
}

async function isBridgeListening(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return res.status === 401 || res.status === 404 || res.status === 502 || res.status === 200;
  } catch {
    return false;
  }
}

async function queryBridgeOrigin(port) {
  const tracked = activeBridges.get(Number(port));
  if (tracked?.origin) return tracked.origin;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__kayo_bridge/meta`, {
      signal: AbortSignal.timeout(2500),
    });
    if (res.status !== 200) return null;
    const json = await res.json();
    return json?.origin || null;
  } catch {
    return null;
  }
}

function pickEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** Live bridge on 17890 must not serve VOD (different CDN host) — use another port. */
async function allocateBridgePort(origin, preferred) {
  const pref = Number(preferred) || 17890;
  if (!(await isBridgeListening(pref))) {
    return pickPort(pref);
  }
  const existing = await queryBridgeOrigin(pref);
  if (existing === origin) return pref;
  return pickEphemeralPort();
}

function usesLocalClipManifest(cmdLine) {
  return /\bdownload\s+"[^"]*manifest\.mpd"/i.test(String(cmdLine || ''))
    || /\bdownload\s+'[^']*manifest\.mpd'/i.test(String(cmdLine || ''));
}

async function probeBridgeManifest(cmdLine, bridgePort) {
  if (usesLocalClipManifest(cmdLine)) {
    return { ok: true, skipped: true, reason: 'local-clip-mpd' };
  }
  const manifestPath = bridgedMpdPathFromCmd(cmdLine, bridgePort);
  if (!manifestPath) return { ok: true, skipped: true };
  const url = `http://127.0.0.1:${bridgePort}${manifestPath}`;
  let lastStatus = 0;
  for (let i = 0; i < 12; i++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      lastStatus = res.status;
      if (res.status === 200) return { ok: true, status: 200, url };
      if (res.status === 403 || res.status === 401) {
        return { ok: false, status: res.status, url };
      }
    } catch {
      /* bridge warming */
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, status: lastStatus || 'timeout', url };
}

async function startCdnBridge(cdnOrigin, { allowReuse = true } = {}) {
  const origin = cdnOriginFromUrl(cdnOrigin) || String(cdnOrigin || '').trim();
  if (!origin) {
    throw new Error('CDN origin required for bridge');
  }

  const preferred = Number(process.env.KAYO_BRIDGE_PORT) || 17890;
  const reuse = allowReuse
    && String(process.env.KAYO_BRIDGE_REUSE || '1').trim().toLowerCase() !== '0';
  if (reuse && (await isBridgeListening(preferred))) {
    const existingOrigin = await queryBridgeOrigin(preferred);
    if (existingOrigin === origin) {
      return {
        port: preferred,
        origin,
        bind: resolveBridgeBind(),
        pid: activeBridges.get(preferred)?.child?.pid || null,
        proxy: 'reused',
        reused: true,
      };
    }
  }
  if (String(process.env.KAYO_BRIDGE_KILL_STALE || '0').trim() === '1') {
    stopBridgeOnPort(preferred);
  }
  const port = allowReuse
    ? await allocateBridgePort(origin, preferred)
    : await pickEphemeralPort();
  const bind = resolveBridgeBind();
  const py = resolvePython();
  const child = spawn(py.command, [
    ...py.prefix,
    BRIDGE_SCRIPT,
    '--origin',
    origin,
    '--port',
    String(port),
    '--bind',
    bind,
  ], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: true,
  });

  const ready = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('CDN bridge startup timed out')), 15000);
    const onData = (chunk) => {
      buf += chunk.toString();
      try {
        const line = buf.trim().split('\n').find((l) => l.startsWith('{'));
        if (!line) return;
        const json = JSON.parse(line);
        clearTimeout(timer);
        if (!json.ok) reject(new Error(json.error || 'bridge failed'));
        else resolve(json);
      } catch {
        /* wait for full json line */
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`CDN bridge exited (${code})`));
      }
    });
  });

  const probeUrl = `http://127.0.0.1:${ready.port}/`;
  for (let i = 0; i < 20; i++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(probeUrl, { signal: AbortSignal.timeout(1000) });
      if (res.status === 502 || res.status === 404 || res.status === 200) break;
    } catch {
      // bridge still binding
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }

  child.unref();
  activeBridges.set(ready.port, { child, origin: ready.origin || origin });
  return {
    port: ready.port,
    origin: ready.origin,
    bind,
    pid: child.pid,
    proxy: ready.proxy || 'direct',
  };
}

function useNm3u8dlDownloader() {
  const { getDownloaderMode } = require('./downloader-mode');
  return getDownloaderMode() !== 'python';
}

module.exports = {
  BRIDGE_PLACEHOLDER,
  pickPort,
  cdnOriginFromUrl,
  cdnOriginFromBase,
  bridgeUrl,
  bridgeBaseFromUpstream,
  applyBridgeToCommand,
  resolveBridgeBind,
  stopBridgeOnPort,
  bridgedMpdPathFromCmd,
  manifestPathFromBridgedCmd,
  isBridgeListening,
  probeBridgeManifest,
  startCdnBridge,
  useNm3u8dlDownloader,
};
