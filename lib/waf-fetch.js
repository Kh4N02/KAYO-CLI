'use strict';

const crypto = require('crypto');
const { resolvePlaywrightProxy } = require('./proxy-request');
const { playbackDeviceParams, playbackAdParams } = require('./playback-device');
const { launchWafContext } = require('./browser-launch');

const PROBE_URL = 'https://kayosports.com.au/__kayo_cli_probe__';

function tunnelProxy() {
  return resolvePlaywrightProxy({ preferTunnel: true });
}

function tokenPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function buildPlaybackRequest(assetId, { useMT = true } = {}) {
  const params = new URLSearchParams({
    ...playbackDeviceParams(),
    AssetId: assetId,
  });
  return {
    url: `https://api.playback.indazn.com/v5/Playback?${params}`,
    body: JSON.stringify({ adParams: playbackAdParams(useMT) }),
  };
}

function buildAuthHeaders(token, sessionId, contentType, extraHeaders = {}) {
  const pl = tokenPayload(token);
  const authToken = String(token).replace(/^Bearer\s+/i, '');
  const headers = {
    Accept: '*/*',
    Authorization: `Bearer ${authToken}`,
    'X-BRAND': 'KAYO',
    Origin: 'https://kayosports.com.au',
    Referer: 'https://kayosports.com.au/',
    'Accept-Language': 'en-AU,en;q=0.9',
    'x-correlation-id': crypto.randomUUID(),
    ...extraHeaders,
  };
  if (contentType) headers['Content-Type'] = contentType;
  if (pl.deviceId) headers['x-dazn-device'] = pl.deviceId;
  if (pl.user) headers['x-daznid'] = pl.user;
  if (sessionId) headers['x-session-id'] = sessionId;
  return headers;
}

/**
 * Kayo's home page patches window.fetch and aborts full Playback URLs from page JS
 * (TypeError: Failed to fetch / net::ERR_FAILED). Playwright route.fetch uses Chrome's
 * network stack and bypasses that interceptor while keeping WAF cookies.
 */
async function routeFetch(page, { url, method, headers, bodyText, bodyB64 }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser playback request timeout')), 60000);
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const handler = async (route) => {
      if (!route.request().url().includes('__kayo_cli_probe__')) {
        await route.continue();
        return;
      }

      try {
        const fetchOpts = { url, method, headers };
        if (bodyText != null) fetchOpts.postData = bodyText;
        else if (bodyB64 != null) fetchOpts.postData = Buffer.from(bodyB64, 'base64');

        const response = await route.fetch(fetchOpts);
        const status = response.status();
        let text = '';
        let b64 = '';

        if (bodyB64 != null) {
          b64 = (await response.body()).toString('base64');
          await route.fulfill({ status, body: Buffer.from(b64, 'base64') });
        } else {
          text = await response.text();
          await route.fulfill({ status, body: text });
        }

        finish(resolve, { status, text, b64 });
      } catch (err) {
        try { await route.abort(); } catch { /* ignore */ }
        finish(reject, err);
      }
    };

    page.route('**/*', handler).then(async () => {
      try {
        await page.evaluate(async (probeUrl) => {
          await fetch(probeUrl, { cache: 'no-store' });
        }, PROBE_URL);
        if (!settled) finish(reject, new Error('Browser playback probe did not run'));
      } catch (err) {
        finish(reject, err);
      } finally {
        await page.unroute('**/*', handler).catch(() => {});
      }
    }).catch((err) => finish(reject, err));
  });
}

async function pagePost(page, opts) {
  const { url, token, sessionId, bodyText, bodyB64, contentType, extraHeaders = {} } = opts;
  const pl = tokenPayload(token);
  const authToken = String(token).replace(/^Bearer\s+/i, '');
  const correlationId = crypto.randomUUID();
  const common = {
    postUrl: url,
    authToken,
    sid: sessionId || null,
    deviceId: pl.deviceId || null,
    daznId: pl.user || null,
    correlationId,
    extra: extraHeaders,
  };

  if (bodyText != null) {
    return page.evaluate(async ({ postUrl, textBody, authToken: t, sid, deviceId, daznId, correlationId: cid, ct, extra }) => {
      const headers = {
        Accept: '*/*',
        Authorization: `Bearer ${t}`,
        'X-BRAND': 'KAYO',
        'Content-Type': ct,
        Origin: 'https://kayosports.com.au',
        Referer: 'https://kayosports.com.au/',
        'Accept-Language': 'en-AU,en;q=0.9',
        'x-correlation-id': cid,
      };
      if (deviceId) headers['x-dazn-device'] = deviceId;
      if (daznId) headers['x-daznid'] = daznId;
      if (sid) headers['x-session-id'] = sid;
      if (extra) {
        for (const [k, v] of Object.entries(extra)) headers[k] = v;
      }
      const r = await fetch(postUrl, { method: 'POST', headers, body: textBody });
      return { status: r.status, text: await r.text(), b64: '' };
    }, { ...common, textBody: bodyText, ct: contentType });
  }

  return page.evaluate(async ({ postUrl, binaryB64, authToken: t, sid, deviceId, daznId, correlationId: cid, ct, extra }) => {
    const headers = {
      Accept: '*/*',
      Authorization: `Bearer ${t}`,
      'X-BRAND': 'KAYO',
      'Content-Type': ct,
      Origin: 'https://kayosports.com.au',
      Referer: 'https://kayosports.com.au/',
      'Accept-Language': 'en-AU,en;q=0.9',
      'x-correlation-id': cid,
    };
    if (deviceId) headers['x-dazn-device'] = deviceId;
    if (daznId) headers['x-daznid'] = daznId;
    if (sid) headers['x-session-id'] = sid;
    if (extra) {
      for (const [k, v] of Object.entries(extra)) headers[k] = v;
    }
    const bytes = Uint8Array.from(atob(binaryB64), (c) => c.charCodeAt(0));
    const r = await fetch(postUrl, { method: 'POST', headers, body: bytes });
    const buf = await r.arrayBuffer();
    const u8 = new Uint8Array(buf);
    let raw = '';
    for (let i = 0; i < u8.length; i += 8192) {
      raw += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    }
    return { status: r.status, text: '', b64: btoa(raw) };
  }, { ...common, binaryB64: bodyB64, ct: contentType });
}

async function browserPost(page, opts) {
  const { url, token, sessionId, bodyText, bodyB64, contentType, extraHeaders = {} } = opts;
  const headers = buildAuthHeaders(token, sessionId, contentType, extraHeaders);
  const method = 'POST';

  try {
    return await pagePost(page, opts);
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (!/failed to fetch|network|typeerror|econn|err_failed/i.test(msg)) throw err;
    return routeFetch(page, { url, method, headers, bodyText, bodyB64 });
  }
}

async function fetchPlaybackInPage(page, assetId, token, sessionId, { useMT = true } = {}) {
  const { url, body } = buildPlaybackRequest(assetId, { useMT });
  const result = await browserPost(page, {
    url,
    token,
    sessionId,
    bodyText: body,
    contentType: 'application/json; charset=UTF-8',
  });
  if (result.status === 401) throw new Error('Token expired — re-run kayo.cmd to sign in again');
  if (result.status !== 200) {
    const snippet = String(result.text || '').slice(0, 160).replace(/\s+/g, ' ');
    if (result.status === 403) {
      throw new Error(
        'PlayReady playback API HTTP 403 — CloudFront blocks the 4K ladder from this session. '
        + 'Try once with KAYO_BROWSER_HEADLESS=0, sign into Kayo in Chrome, then retry.',
      );
    }
    throw new Error(`Playback API HTTP ${result.status}${snippet ? `: ${snippet}` : ''}`);
  }
  const playback = JSON.parse(result.text);
  if (playback['odata.error']) {
    throw new Error(playback['odata.error'].message?.value || 'Playback API error');
  }
  return playback;
}

async function fetchManifestInPage(page, url) {
  const headers = {
    Accept: '*/*',
    Origin: 'https://kayosports.com.au',
    Referer: 'https://kayosports.com.au/',
    'Accept-Language': 'en-AU,en;q=0.9',
  };

  let result;
  try {
    result = await routeFetch(page, { url, method: 'GET', headers });
  } catch {
    result = await page.evaluate(async (manifestUrl) => {
      const r = await fetch(manifestUrl, {
        method: 'GET',
        credentials: 'omit',
        headers: {
          Accept: '*/*',
          Origin: 'https://kayosports.com.au',
          Referer: 'https://kayosports.com.au/',
        },
      });
      return { status: r.status, text: await r.text(), b64: '' };
    }, url);
  }

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`MPD fetch HTTP ${result.status}: ${String(result.text || '').slice(0, 200)}`);
  }
  if (!result.text || !/<MPD\b/i.test(result.text)) {
    throw new Error('MPD fetch did not return a manifest');
  }
  return result.text;
}

async function fetchLicenseInPage(page, url, challengeB64, token, sessionId, contentType, extraHeaders) {
  const result = await browserPost(page, {
    url,
    token,
    sessionId,
    bodyB64: challengeB64,
    contentType,
    extraHeaders,
  });
  if (result.status === 401) throw new Error('License 401 — re-run kayo.cmd to refresh auth');
  if (result.status !== 200) throw new Error(`License HTTP ${result.status}`);
  return result.b64;
}

async function dismissCookieBanner(page) {
  for (const sel of [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept All")',
    'button:has-text("AGREE")',
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count()) await btn.click({ timeout: 2000 });
    } catch { /* ignore */ }
  }
}

async function waitForWafReady(ctx, page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cookies = await ctx.cookies(['https://kayosports.com.au', 'https://www.kayosports.com.au']);
    const hasSession = cookies.some((c) => /nativeSession|aws-waf|session/i.test(c.name));
    if (hasSession || cookies.length >= 2) return;
    await page.waitForTimeout(500);
  }
}

async function withWafSession(callback, { onStatus } = {}) {
  const status = onStatus || (() => {});
  const headless = process.env.KAYO_BROWSER_HEADLESS !== '0';
  const ctx = await launchWafContext({
    headless,
    proxy: tunnelProxy(),
    onStatus: status,
  });

  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    status(headless
      ? 'Kayo WAF session (headless, keep VPN on)...'
      : 'Kayo WAF session (keep VPN on)...');
    await page.goto('https://kayosports.com.au/en-AU/home', {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await dismissCookieBanner(page);
    await waitForWafReady(ctx, page);
    await page.waitForTimeout(2000);

    const getBrowserUserAgent = async () => page.evaluate(() => navigator.userAgent);

    const waf = {
      page,
      fetchPlayback: (assetId, t, sid, opts) => fetchPlaybackInPage(page, assetId, t, sid, opts),
      fetchManifestText: (url) => fetchManifestInPage(page, url),
      fetchLicenseBinary: (url, challengeB64, t, sid, contentType, extraHeaders) =>
        fetchLicenseInPage(page, url, challengeB64, t, sid, contentType, extraHeaders),
      getDownloadCookies: async () => {
        const cookies = await ctx.cookies();
        return cookies
          .filter((c) => /dazn|indazn|kayo/i.test(c.domain))
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');
      },
      getBrowserUserAgent,
      request: ctx.request,
    };

    return await callback(waf, ctx);
  } finally {
    await ctx.close();
  }
}

module.exports = { withWafSession, buildPlaybackRequest, fetchPlaybackInPage };
