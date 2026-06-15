'use strict';

const https = require('https');
const { URL } = require('url');
const { parseCustomProxy, proxyFormatHint } = require('./proxy-parse');

let HttpsProxyAgent;
try {
  HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
} catch {
  HttpsProxyAgent = null;
}

const REFRESH_URL = 'https://ott-authz-bff-prod.ar.indazn.com/v5/RefreshAccessToken';
const SIGNIN_URL = 'https://authentication-prod.ar.indazn.com/v5/SignIn';
/** Match Kayo web RefreshAccessToken (Network tab on kayosports.com.au) */
const REFRESH_UA = 'Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
const REFRESH_TIMEOUT_MS = 15000;
const PROXY_REFRESH_TIMEOUT_MS = 12000;
const PROXY_EXIT_CHECK_URL = 'https://ipv4.webshare.io/';
/** Webshare datacenter exits leak on p.webshare.io rotate — DAZN returns CloudFront 403. */
const DATACENTER_EXIT_PREFIXES = ['91.217.72.'];
const PROXY_EXIT_PROBE_ATTEMPTS = 20;
/** Webshare -AU-rotate can land on a CloudFront-blocked IP; retry picks a new exit. */
const PROXY_AUTH_RETRY_ATTEMPTS = 15;
const PROXY_AUTH_RETRY_DELAY_MS = 900;

function isProxyBlockedError(err) {
  return /403|CloudFront|blocked/i.test(String(err?.message || err || ''));
}

function enrichProxyConnectError(err, proxySpec) {
  const msg = String(err?.message || err || '');
  if (!/ETIMEDOUT|ECONNREFUSED|AggregateError/i.test(msg)) return err;
  const spec = String(proxySpec || '');
  const host = spec.split(':')[0] || '';
  const port = spec.split(':')[1] || '';
  if (port === '6887' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return new Error(
      'Proxy unreachable — datacenter IP:6887 is not for Kayo auth. In proxy/.env use only: p.webshare.io:80:USER-AU-rotate:PASS',
    );
  }
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDatacenterExitIp(ip) {
  const s = String(ip || '').trim();
  return DATACENTER_EXIT_PREFIXES.some((pfx) => s.startsWith(pfx));
}

function fetchProxyExitIp(proxySpec) {
  const proxyUrl = parseCustomProxy(proxySpec);
  if (!proxyUrl || !HttpsProxyAgent) {
    return Promise.reject(new Error('Proxy required for exit IP check'));
  }
  const agent = new HttpsProxyAgent(proxyUrl, { timeout: 8000 });
  const u = new URL(PROXY_EXIT_CHECK_URL);
  return new Promise((resolve, reject) => {
    const req = https.get(u, { agent, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Exit IP check HTTP ${res.statusCode}`));
          return;
        }
        resolve(body.trim());
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Exit IP check timeout')));
    req.setTimeout(8000);
  });
}

/** Skip Webshare datacenter exits before DAZN auth (rotate often returns 91.217.72.x). */
async function waitForResidentialExit(proxySpec, onDatacenterSkip) {
  for (let probe = 0; probe < PROXY_EXIT_PROBE_ATTEMPTS; probe++) {
    let ip = '';
    try {
      ip = await fetchProxyExitIp(proxySpec);
    } catch {
      await sleep(500);
      continue;
    }
    if (!isDatacenterExitIp(ip)) return ip;
    if (onDatacenterSkip) onDatacenterSkip(ip, probe + 1);
    await sleep(600);
  }
  return null;
}

async function withProxyRotateRetries(fn, proxySpec, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < PROXY_AUTH_RETRY_ATTEMPTS; attempt++) {
    if (proxySpec) {
      const ip = await waitForResidentialExit(proxySpec, opts.onDatacenterSkip);
      if (!ip && attempt < PROXY_AUTH_RETRY_ATTEMPTS - 1) {
        await sleep(PROXY_AUTH_RETRY_DELAY_MS);
        continue;
      }
      if (opts.onResidentialExit && ip) opts.onResidentialExit(ip);
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isProxyBlockedError(err) || attempt >= PROXY_AUTH_RETRY_ATTEMPTS - 1) throw err;
      await sleep(PROXY_AUTH_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

function buildRefreshHeaders(token, sessionId) {
  const t = normalizeToken(token);
  const daznId = daznIdFromToken(t);
  const headers = {
    'User-Agent': REFRESH_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8,it-IT;q=0.7,it;q=0.6',
    Authorization: `Bearer ${t}`,
    'Content-Type': 'application/json',
    Origin: 'https://kayosports.com.au',
    Referer: 'https://kayosports.com.au/',
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'x-brand': 'kayo',
  };
  if (daznId) headers['x-daznid'] = daznId;
  if (sessionId) headers['x-session-id'] = sessionId;
  return headers;
}

function normalizeToken(raw) {
  return String(raw || '').trim().replace(/^Bearer\s+/i, '');
}

function isJwtLike(raw) {
  const t = normalizeToken(raw);
  return !!(t && t.startsWith('eyJ') && t.split('.').length === 3 && t.length > 200);
}

function parseTokenPayload(token) {
  try {
    const part = normalizeToken(token).split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function deviceIdFromToken(token) {
  return parseTokenPayload(token)?.deviceId || null;
}

/** Kayo RefreshAccessToken body uses short DeviceId (e.g. 00592385b6), not full JWT deviceId. */
function resolveRefreshDeviceId(token, override) {
  if (override) return String(override).trim();
  const full = deviceIdFromToken(token);
  if (!full) return null;
  const pipe = full.indexOf('|');
  const base = pipe >= 0 ? full.slice(0, pipe) : full;
  const short = base.split('-').pop();
  return short && short.length >= 8 ? short : full;
}

function daznIdFromToken(token) {
  const p = parseTokenPayload(token);
  return p?.user || (p?.viewerId ? String(p.viewerId).split('-kayo')[0] : null);
}

function tokenExpiryMs(token) {
  const p = parseTokenPayload(token);
  return p?.exp ? Number(p.exp) * 1000 : null;
}

function tokenNeedsRefresh(token, force = false) {
  if (force) return true;
  const exp = tokenExpiryMs(token);
  if (!exp) return true;
  return exp - Date.now() < 10 * 60 * 1000;
}

function authTokenFromRefreshResponse(json) {
  const box = json.AuthToken || json.authToken;
  if (box && typeof box === 'object') {
    const inner = box.Token || box.token || box.Value;
    if (inner) return normalizeToken(inner);
  }
  if (typeof box === 'string') return normalizeToken(box);
  const flat = json.accessToken || json.AccessToken;
  return flat ? normalizeToken(flat) : null;
}

function refreshErrorFromResponse(statusCode, rawBody) {
  const body = String(rawBody || '').trim();
  if (statusCode === 407) {
    return `Proxy authentication failed (407). ${proxyFormatHint(process.env.KAYO_PROXY)}`;
  }
  if (body.startsWith('<')) {
    if (statusCode === 403) {
      return 'DAZN auth blocked this connection (CloudFront 403). Datacenter proxies often fail here — paste a fresh JWT from Kayo DevTools while on AU VPN in Chrome.';
    }
    return `Refresh HTTP ${statusCode} (HTML blocked page)`;
  }
  let json = {};
  try {
    json = JSON.parse(body || '{}');
  } catch {
    return `Refresh HTTP ${statusCode}`;
  }
  return json.Message || json.message || json.error || `Refresh HTTP ${statusCode}`;
}

function refreshAccessToken(currentToken, proxySpec, sessionId, deviceIdOverride) {
  const token = normalizeToken(currentToken);
  const deviceId = resolveRefreshDeviceId(token, deviceIdOverride);
  if (!token) return Promise.reject(new Error('No token to refresh'));
  if (!deviceId) return Promise.reject(new Error('Token missing deviceId — paste a Kayo JWT once (with deviceId)'));

  const proxyUrl = parseCustomProxy(proxySpec);
  if (proxyUrl && !HttpsProxyAgent) {
    return Promise.reject(new Error('Proxy support missing — run: npm install https-proxy-agent'));
  }

  const body = JSON.stringify({ DeviceId: deviceId });
  const u = new URL(REFRESH_URL);
  const sid = sessionId || require('crypto').randomUUID();
  const headers = buildRefreshHeaders(token, sid);

  const timeoutMs = proxyUrl ? PROXY_REFRESH_TIMEOUT_MS : REFRESH_TIMEOUT_MS;
  const agent = proxyUrl && HttpsProxyAgent
    ? new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs })
    : undefined;

  const doRequest = () => new Promise((resolve, reject) => {
    const req = https.request(u, { method: 'POST', headers, agent, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = {};
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(refreshErrorFromResponse(res.statusCode, data)));
          return;
        }
        try {
          json = JSON.parse(data || '{}');
        } catch {
          reject(new Error('Refresh response was not JSON'));
          return;
        }
        const next = authTokenFromRefreshResponse(json);
        if (!next) {
          reject(new Error('Refresh response had no AuthToken.Token'));
          return;
        }
        resolve(next);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Refresh timeout')));
    req.on('error', (e) => reject(enrichProxyConnectError(e, proxySpec)));
    req.setTimeout(timeoutMs);
    req.write(body);
    req.end();
  });

  const once = () => Promise.race([
    doRequest(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Refresh timeout')), timeoutMs + 2000);
    }),
  ]);

  return proxyUrl
    ? withProxyRotateRetries(once, proxySpec)
    : once();
}

async function refreshAccessTokenWithFallback(currentToken, proxySpec, sessionId, deviceIdOverride) {
  const proxy = String(proxySpec || '').trim();
  if (!proxy) {
    return Promise.reject(new Error('Proxy required — set host:port:user:pass in Download proxy field'));
  }
  return refreshAccessToken(currentToken, proxy, sessionId, deviceIdOverride);
}

function buildKayoDeviceIdForSignIn(override) {
  const o = String(override || '').trim();
  if (!o) return `${require('crypto').randomUUID()}|kayo`;
  if (o.includes('|')) return o;
  if (/^[0-9a-f-]{36}$/i.test(o)) return `${o}|kayo`;
  return `${require('crypto').randomUUID()}-${o}|kayo`;
}

function postJsonViaProxy(url, headers, body, proxySpec) {
  const proxyUrl = parseCustomProxy(proxySpec);
  if (!proxyUrl) return Promise.reject(new Error('Proxy required'));
  if (!HttpsProxyAgent) {
    return Promise.reject(new Error('Proxy support missing — run: npm install https-proxy-agent'));
  }
  const timeoutMs = PROXY_REFRESH_TIMEOUT_MS;
  const agent = new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs });
  const u = new URL(url);

  return new Promise((resolve, reject) => {
    const req = https.request(u, { method: 'POST', headers, agent, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(refreshErrorFromResponse(res.statusCode, data)));
          return;
        }
        let json = {};
        try {
          json = JSON.parse(data || '{}');
        } catch {
          reject(new Error('Auth response was not JSON'));
          return;
        }
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Auth timeout')));
    req.on('error', (e) => reject(enrichProxyConnectError(e, proxySpec)));
    req.setTimeout(timeoutMs);
    req.write(body);
    req.end();
  });
}

/** Login with Kayo/DAZN email+password through proxy — returns JWT (no DevTools needed). */
async function signInKayo({ email, password, proxySpec, deviceId, onDatacenterSkip, onResidentialExit }) {
  const opts = { onDatacenterSkip, onResidentialExit };
  const em = String(email || '').trim();
  const pw = String(password || '');
  if (!em || !pw) return Promise.reject(new Error('KAYO_EMAIL and KAYO_PASSWORD required in proxy/.env'));

  const dev = buildKayoDeviceIdForSignIn(deviceId);
  const body = JSON.stringify({
    Email: em,
    Password: pw,
    DeviceId: dev,
    Platform: 'web',
    ProfilingSessionId: require('crypto').randomUUID(),
  });
  const headers = {
    'User-Agent': REFRESH_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'Content-Type': 'application/json',
    Origin: 'https://kayosports.com.au',
    Referer: 'https://kayosports.com.au/',
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'x-brand': 'kayo',
  };

  const json = await withProxyRotateRetries(
    () => postJsonViaProxy(SIGNIN_URL, headers, body, proxySpec),
    proxySpec,
    { onDatacenterSkip: opts?.onDatacenterSkip, onResidentialExit: opts?.onResidentialExit },
  );
  const token = authTokenFromRefreshResponse(json);
  if (!token) {
    const result = json.Result || json.result || 'unknown';
    return Promise.reject(new Error(`SignIn had no token (Result: ${result})`));
  }
  return { token, deviceId: dev, result: json.Result || json.result };
}

/**
 * Get a valid JWT: SignIn (email/pass) if no token, else RefreshAccessToken.
 */
async function obtainKayoToken({
  proxySpec, sessionId, deviceId, seedToken, email, password, onDatacenterSkip, onResidentialExit,
}) {
  const opts = { onDatacenterSkip, onResidentialExit };
  const proxy = String(proxySpec || '').trim();
  if (!proxy) return Promise.reject(new Error('Proxy required (KAYO_PROXY in proxy/.env)'));

  const seedFromArg = isJwtLike(seedToken) ? normalizeToken(seedToken) : '';
  const seedFromEnv = isJwtLike(process.env.KAYO_TOKEN) ? normalizeToken(process.env.KAYO_TOKEN) : '';
  const seed = seedFromArg || seedFromEnv;
  const sid = sessionId || require('crypto').randomUUID();
  const dev = deviceId || process.env.KAYO_DEVICE_ID;

  // Same as npm run proxy:refresh — RefreshAccessToken when any JWT exists
  if (seed) {
    const next = await refreshAccessToken(seed, proxy, sid, dev);
    return { token: next, refreshed: true, method: 'refresh' };
  }

  const em = email || process.env.KAYO_EMAIL;
  const pw = password || process.env.KAYO_PASSWORD;
  if (em && pw) {
    try {
      const signed = await signInKayo({
        email: em,
        password: pw,
        proxySpec: proxy,
        deviceId: dev,
        onDatacenterSkip: opts?.onDatacenterSkip,
        onResidentialExit: opts?.onResidentialExit,
      });
      return { token: signed.token, refreshed: true, method: 'signin', deviceId: signed.deviceId };
    } catch (signErr) {
      const msg = signErr.message || String(signErr);
      if (isProxyBlockedError(signErr)) {
        throw new Error(
          'SignIn blocked (403) after retries — Webshare rotate often leaks datacenter IP 91.217.72.x (run npm run proxy:test until Body is NOT that IP), or paste JWT once → npm run proxy:refresh',
        );
      }
      throw signErr;
    }
  }

  return Promise.reject(new Error(
    'Set KAYO_EMAIL+KAYO_PASSWORD or KAYO_TOKEN in proxy/.env (see npm run proxy:refresh)',
  ));
}

module.exports = {
  normalizeToken,
  isJwtLike,
  deviceIdFromToken,
  resolveRefreshDeviceId,
  parseTokenPayload,
  tokenNeedsRefresh,
  tokenExpiryMs,
  authTokenFromRefreshResponse,
  buildRefreshHeaders,
  refreshAccessToken,
  refreshAccessTokenWithFallback,
  signInKayo,
  obtainKayoToken,
  fetchProxyExitIp,
  isDatacenterExitIp,
  REFRESH_URL,
  SIGNIN_URL,
};
