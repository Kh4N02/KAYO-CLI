'use strict';

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { resolvePython } = require('./python-resolve');

const ROOT = path.join(__dirname, '..');
const BRIDGE_SCRIPT = path.join(__dirname, 'kayo-cdn-bridge.py');
const BRIDGE_PLACEHOLDER = '__KAYO_BRIDGE__';

const activeBridges = new Map();

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

async function startCdnBridge(cdnOrigin) {
  const origin = cdnOriginFromUrl(cdnOrigin) || String(cdnOrigin || '').trim();
  if (!origin) {
    throw new Error('CDN origin required for bridge');
  }

  const preferred = Number(process.env.KAYO_BRIDGE_PORT) || 17890;
  const port = await pickPort(preferred);
  const py = resolvePython();
  const child = spawn(py.command, [...py.prefix, BRIDGE_SCRIPT, '--origin', origin, '--port', String(port)], {
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
  activeBridges.set(port, child);
  return { port: ready.port, origin: ready.origin, pid: child.pid };
}

function useNm3u8dlDownloader() {
  const mode = String(process.env.KAYO_DOWNLOADER || 'nm3u8dl').trim().toLowerCase();
  return mode !== 'python';
}

module.exports = {
  BRIDGE_PLACEHOLDER,
  pickPort,
  cdnOriginFromUrl,
  cdnOriginFromBase,
  bridgeUrl,
  bridgeBaseFromUpstream,
  applyBridgeToCommand,
  startCdnBridge,
  useNm3u8dlDownloader,
};
