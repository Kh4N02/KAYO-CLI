'use strict';

const { agentForSpec, proxyCandidates, isProxyTransportError, requestBufferOnce } = require('./proxy-request');

const PROXY_WAIT_ROUNDS = 3;
const PROXY_WAIT_SECONDS = 15;
const PROXY_PROBE_INTERVAL_MS = 2000;
const PROXY_PROBE_TIMEOUT_MS = 8000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function proxyHost(spec) {
  return String(spec || '').split(':')[0] || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isProxyReachable(spec) {
  if (!spec) return false;
  const agent = agentForSpec(spec, PROXY_PROBE_TIMEOUT_MS);
  if (!agent) return false;
  try {
    await requestBufferOnce('https://www.kayosports.com.au/', {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      agent,
      timeout: PROXY_PROBE_TIMEOUT_MS,
      step: 'Proxy check',
    });
    return true;
  } catch (err) {
    if (isProxyTransportError(err)) return false;
    // HTTP response (403, 405, etc.) means the proxy tunnel works.
    return Boolean(err.status);
  }
}

async function findReachableProxy(specs) {
  for (const spec of specs) {
    if (await isProxyReachable(spec)) {
      return spec;
    }
  }
  return null;
}

/**
 * Up to 3 × 15s for the user to turn on VPN/tunnel.
 * When proxy becomes reachable, return immediately and open the browser.
 */
async function waitForProxyBeforeBrowser(onStatus) {
  if (process.env.KAYO_BROWSER_NO_PROXY === '1') {
    onStatus('Browser login: system VPN (KAYO_BROWSER_NO_PROXY=1, no HTTP proxy)...');
    try {
      await requestBufferOnce('https://www.kayosports.com.au/', {
        method: 'HEAD',
        headers: { 'User-Agent': UA },
        timeout: PROXY_PROBE_TIMEOUT_MS,
        useProxy: false,
        step: 'Kayo reachability',
      });
    } catch (err) {
      if (!err.status) {
        throw new Error(
          'Kayo not reachable. Connect VPN to Australia first, then run kayo.cmd again.',
        );
      }
    }
    onStatus('Kayo reachable — opening Chrome (uses your VPN, not Clash HTTP proxy)');
    return '__system__';
  }

  const candidates = proxyCandidates().filter(Boolean);
  if (!candidates.length) {
    throw new Error('KAYO_PROXY not set in .env');
  }

  const tunnel = String(process.env.KAYO_PROXY_TUNNEL || '').trim();
  if (tunnel) {
    onStatus(`Turn on VPN/tunnel (${tunnel}) — up to ${PROXY_WAIT_ROUNDS}×${PROXY_WAIT_SECONDS}s before browser login`);
  } else {
    onStatus(`Checking proxy — up to ${PROXY_WAIT_ROUNDS}×${PROXY_WAIT_SECONDS}s before browser login`);
  }

  for (let round = 1; round <= PROXY_WAIT_ROUNDS; round++) {
    const roundStart = Date.now();
    onStatus(`Proxy wait ${round}/${PROXY_WAIT_ROUNDS} (${PROXY_WAIT_SECONDS}s) — enable VPN if needed`);

    while (Date.now() - roundStart < PROXY_WAIT_SECONDS * 1000) {
      const ready = await findReachableProxy(candidates);
      if (ready) {
        onStatus(`Proxy OK (${proxyHost(ready)}) — opening browser...`);
        return ready;
      }
      await sleep(PROXY_PROBE_INTERVAL_MS);
    }
  }

  throw new Error(
    `Proxy/VPN not reachable after ${PROXY_WAIT_ROUNDS}×${PROXY_WAIT_SECONDS}s. `
    + 'Turn on your VPN/tunnel (KAYO_PROXY_TUNNEL) and ensure KAYO_PROXY is set, then run kayo.cmd again.',
  );
}

module.exports = {
  waitForProxyBeforeBrowser,
  isProxyReachable,
  findReachableProxy,
  PROXY_WAIT_ROUNDS,
  PROXY_WAIT_SECONDS,
};
