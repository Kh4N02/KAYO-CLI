'use strict';

const { chromium } = require('playwright');
const { browserProfile } = require('./paths');
const { resolvePlaywrightProxy } = require('./proxy-request');
const { playbackDeviceParams, playbackAdParams } = require('./playback-device');

const DEFAULT_PROFILE = browserProfile();

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

async function browserPost(page, { url, token, sessionId, bodyText, bodyB64, contentType, extraHeaders = {} }) {
  const pl = tokenPayload(token);
  const authToken = String(token).replace(/^Bearer\s+/i, '');
  if (bodyText != null) {
    return page.evaluate(async ({ postUrl, textBody, authToken: t, sid, deviceId, daznId, ct, extra }) => {
      const headers = {
        Accept: '*/*',
        Authorization: `Bearer ${t}`,
        'X-BRAND': 'KAYO',
        'Content-Type': ct,
        Origin: 'https://kayosports.com.au',
        Referer: 'https://kayosports.com.au/',
      };
      if (deviceId) headers['x-dazn-device'] = deviceId;
      if (daznId) headers['x-daznid'] = daznId;
      if (sid) headers['x-session-id'] = sid;
      if (extra) {
        for (const [k, v] of Object.entries(extra)) headers[k] = v;
      }
      const r = await fetch(postUrl, { method: 'POST', headers, body: textBody });
      return { status: r.status, text: await r.text(), b64: '' };
    }, {
      postUrl: url,
      textBody: bodyText,
      authToken,
      sid: sessionId || null,
      deviceId: pl.deviceId || null,
      daznId: pl.user || null,
      ct: contentType,
      extra: extraHeaders,
    });
  }

  return page.evaluate(async ({ postUrl, binaryB64, authToken: t, sid, deviceId, daznId, ct, extra }) => {
    const headers = {
      Accept: '*/*',
      Authorization: `Bearer ${t}`,
      'X-BRAND': 'KAYO',
      'Content-Type': ct,
      Origin: 'https://kayosports.com.au',
      Referer: 'https://kayosports.com.au/',
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
  }, {
    postUrl: url,
    binaryB64: bodyB64,
    authToken,
    sid: sessionId || null,
    deviceId: pl.deviceId || null,
    daznId: pl.user || null,
    ct: contentType,
    extra: extraHeaders,
  });
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
    throw new Error(`Playback API HTTP ${result.status} — log into Kayo in Chrome once (same profile) with VPN on`);
  }
  const playback = JSON.parse(result.text);
  if (playback['odata.error']) {
    throw new Error(playback['odata.error'].message?.value || 'Playback API error');
  }
  return playback;
}

async function fetchManifestInPage(page, url) {
  const result = await page.evaluate(async (manifestUrl) => {
    const r = await fetch(manifestUrl, {
      method: 'GET',
      credentials: 'omit',
      headers: {
        Accept: '*/*',
        Origin: 'https://kayosports.com.au',
        Referer: 'https://kayosports.com.au/',
      },
    });
    return { status: r.status, text: await r.text() };
  }, url);

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`MPD browser fetch HTTP ${result.status}: ${String(result.text || '').slice(0, 200)}`);
  }
  if (!result.text || !/<MPD\b/i.test(result.text)) {
    throw new Error('MPD browser fetch did not return a manifest');
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

async function withWafSession(callback, { onStatus } = {}) {
  const status = onStatus || (() => {});
  const headless = process.env.KAYO_BROWSER_HEADLESS !== '0';
  const ctx = await chromium.launchPersistentContext(DEFAULT_PROFILE, {
    headless,
    channel: 'chrome',
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    proxy: tunnelProxy() || undefined,
    viewport: { width: 1280, height: 720 },
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
    await page.waitForTimeout(6000);

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
