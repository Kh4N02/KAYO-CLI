'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const PLAYBACK_BASE = 'https://api.playback.indazn.com/v5/Playback';
const REMOTE_WV_CDM = 'https://getwvkeys.cc/api/remotecdm/widevine/getwvkeys';
const { playReadyCdmBaseUrl } = require('../lib/playback-device');
const { localCdmAvailable } = require('../lib/cdm-device');
const cdmLocal = require('../lib/cdm-local');
const { WIDEVINE_UUID, PLAYREADY_UUID } = require('../lib/cdm-device');
const CDN_NAMES = [
  'dck1-fs-live',
  'dck1-fs-vod',
  'dck1-ac-live',
  'dck1-ac-vod',
  'dck1-ak-live',
  'dck1-ak-vod',
];
const PLAYREADY_SCHEME = /9a04f079-9840-4286-ab92-e65be0885f95/i;

const KAYO_HEADERS = {
  'User-Agent': UA,
  Accept: '*/*',
  Origin: 'https://kayosports.com.au',
  Referer: 'https://kayosports.com.au/',
  'Accept-Language': 'en-AU,en;q=0.9',
};

function normalizeToken(raw) {
  if (!raw) return '';
  return String(raw).trim().replace(/^Bearer\s+/i, '');
}

function deviceIdFromToken(token) {
  try {
    const part = token.split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload.deviceId || payload.deviceid || null;
  } catch {
    return null;
  }
}

function playbackHeaders(token) {
  const headers = {
    ...KAYO_HEADERS,
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'X-BRAND': 'kayo',
    'x-correlation-id': crypto.randomUUID(),
  };
  const deviceId = deviceIdFromToken(token);
  if (deviceId) headers['x-dazn-device'] = deviceId;
  return headers;
}

function httpError(step, url, status, body) {
  const snippet = body.toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
  const err = new Error(`${step} failed (HTTP ${status}): ${snippet}`);
  err.step = step;
  err.url = url;
  err.status = status;
  return err;
}

function requestBuffer(url, options = {}) {
  const step = options.step || 'Request';
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 45000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(httpError(step, url, res.statusCode, body));
          return;
        }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', (e) => {
      e.step = step;
      e.url = url;
      reject(e);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`${step} timeout`), { step, url })));
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function requestJson(url, options = {}) {
  const res = await requestBuffer(url, options);
  return JSON.parse(res.body.toString('utf8'));
}

async function requestText(url, options = {}) {
  const res = await requestBuffer(url, options);
  return res.body.toString('utf8');
}

function buildPlaybackUrl(assetId) {
  const { playbackDeviceParams } = require('../lib/playback-device');
  const params = new URLSearchParams({
    ...playbackDeviceParams(),
    AssetId: assetId,
  });
  return `${PLAYBACK_BASE}?${params}`;
}

function pickCdnEntry(playback) {
  const details = playback.PlaybackDetails || [];
  for (const name of CDN_NAMES) {
    const entry = details.find((p) => p.CdnName === name);
    if (entry?.ManifestUrl) return entry;
  }
  return details.find((p) => p.ManifestUrl) || null;
}

function parseManifestBase(manifestUrl) {
  const sessionMatch = manifestUrl.match(/aws\.sessionId=([^&]+)/);
  return { sessionId: sessionMatch ? sessionMatch[1] : null };
}

function buildManifestUrl(manifestUrl, token) {
  const u = new URL(manifestUrl);
  u.searchParams.set('dazn-token', token);
  const { sessionId } = parseManifestBase(manifestUrl);
  if (sessionId) u.searchParams.set('aws.sessionId', sessionId);
  return u.toString();
}

function psshContainsSystemId(psshB64, systemIdBuf) {
  try {
    return Buffer.from(psshB64, 'base64').includes(systemIdBuf);
  } catch {
    return false;
  }
}

function extractAllPsshBySystem(mpdXml, systemIdBuf) {
  const xml = String(mpdXml || '');
  const seen = new Set();
  const out = [];
  const re = /<(?:cenc:)?pssh[^>]*>([A-Za-z0-9+/=]+)<\/(?:cenc:)?pssh>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const val = match[1].trim();
    if (!val || seen.has(val) || !psshContainsSystemId(val, systemIdBuf)) continue;
    seen.add(val);
    out.push(val);
  }
  return out;
}

function extractAllPlayReadyPsshFromMpd(mpdXml) {
  return extractAllPsshBySystem(mpdXml, PLAYREADY_UUID);
}

function extractAllWidevinePsshFromMpd(mpdXml) {
  return extractAllPsshBySystem(mpdXml, WIDEVINE_UUID);
}

function mergeKeysByKid(keyLists) {
  const map = new Map();
  for (const list of keyLists) {
    for (const k of list || []) {
      if (k?.kid && k?.key) map.set(k.kid.toLowerCase(), k);
    }
  }
  return [...map.values()];
}

function isPlayReadyLicenseUrl(url) {
  return /playready/i.test(String(url || ''));
}

function extractPsshFromMpd(mpdXml) {
  const all = extractAllWidevinePsshFromMpd(mpdXml);
  if (all.length) return all[0];
  throw new Error('No Widevine PSSH found in MPD');
}

/** PlayReady LA URL + init (mspr:pro or PlayReady PSSH) from MPD — Fox/Kayo style. */
function extractPlayReadyFromMpd(mpdXml) {
  const xml = String(mpdXml || '');
  let laUrl = null;

  const laurlMatch = xml.match(/<(?:[\w-]+:)?Laurl[^>]*>([^<]+)<\/(?:[\w-]+:)?Laurl>/i);
  if (laurlMatch) laUrl = laurlMatch[1].trim();

  let initData = null;
  const proMatch = xml.match(/<(?:mspr:)?pro[^>]*>([\sA-Za-z0-9+/=]+)<\/(?:mspr:)?pro>/i);
  if (proMatch) initData = proMatch[1].replace(/\s+/g, '');

  if (!initData) {
    const blocks = xml.split(/<ContentProtection\b/i);
    for (let i = 1; i < blocks.length; i++) {
      if (!PLAYREADY_SCHEME.test(blocks[i])) continue;
      const pssh = blocks[i].match(/<(?:cenc:)?pssh[^>]*>([A-Za-z0-9+/=]+)<\/(?:cenc:)?pssh>/i);
      if (pssh) {
        initData = pssh[1].trim();
        break;
      }
    }
  }

  if (!laUrl && initData) {
    try {
      const decoded = Buffer.from(initData, 'base64').toString('utf8');
      const m = decoded.match(/<LA_URL>([^<]+)<\/LA_URL>/i);
      if (m) laUrl = m[1].trim();
    } catch {
      // binary PRO — LA URL must come from dashif:Laurl or playback
    }
  }

  if (!initData) return null;
  return { laUrl: laUrl || null, initData };
}

function pickPlayReadyLicenseUrl(entry, playback, mpdPr) {
  const fromApi = entry?.PlayReadyLaUrl || entry?.PlayReadyUrl || entry?.PrUrl
    || playback?.PlayReadyLaUrl || playback?.PlayReadyUrl;
  return mpdPr?.laUrl || fromApi || entry?.LaUrl || playback?.LaUrl || null;
}

function playReadyLicenseHeaders(token) {
  return {
    ...playbackHeaders(token),
    Accept: '*/*',
    'Content-Type': 'text/xml; charset=UTF-8',
    SOAPAction: '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"',
  };
}

async function cdmOpen(baseUrl, logs, label) {
  const data = await requestJson(`${baseUrl}/open`, {
    headers: { 'User-Agent': UA },
  });
  if (data.status !== 200) throw new Error(data.message || `${label} CDM open failed`);
  logs.push(`${label} CDM session opened`);
  return data.data.session_id;
}

async function cdmClose(baseUrl, sessionId) {
  try {
    await requestJson(`${baseUrl}/close/${sessionId}`, { headers: { 'User-Agent': UA } });
  } catch {
    // ignore
  }
}

async function cdmGetChallenge(baseUrl, path, sessionId, initData, logs, label, extra = {}) {
  logs.push(`Generating ${label} license challenge`);
  const data = await requestJson(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, init_data: initData, privacy_mode: false, ...extra }),
  });
  const challenge = data.data?.challenge_b64 || data.data?.challenge;
  if (data.status !== 200 || !challenge) {
    throw new Error(data.message || `${label} license challenge failed`);
  }
  logs.push(`${label} challenge generated`);
  return typeof challenge === 'string' && !/^[A-Za-z0-9+/=]+$/.test(challenge.slice(0, 20))
    ? Buffer.from(challenge, 'utf8').toString('base64')
    : challenge;
}

async function cdmParseLicense(baseUrl, sessionId, licenseB64, logs, label) {
  logs.push(`Parsing ${label} license`);
  const data = await requestJson(`${baseUrl}/parse_license`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, license_message: licenseB64 }),
  });
  if (data.status !== 200) throw new Error(data.message || `${label} parse license failed`);
  logs.push(`${label} license parsed`);
}

async function cdmGetKeys(baseUrl, sessionId, logs, label) {
  logs.push(`Extracting keys (${label})`);
  const data = await requestJson(`${baseUrl}/get_keys/CONTENT`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (data.status !== 200) throw new Error(data.message || `${label} get keys failed`);
  const keys = (data.data?.keys || []).map((k) => ({
    kid: (k.key_id || k.kid || '').replace(/-/g, '').toLowerCase(),
    key: (k.key || k.k || '').replace(/-/g, '').toLowerCase(),
  })).filter((k) => k.kid && k.key);
  logs.push(`Extracted ${keys.length} key(s)`);
  return keys;
}

async function fetchLicenseServer(laUrl, challengeB64, authToken) {
  const challenge = Buffer.from(challengeB64, 'base64');
  const res = await requestBuffer(laUrl, {
    step: 'Widevine license',
    method: 'POST',
    headers: {
      ...playbackHeaders(authToken),
      'Content-Type': 'application/octet-stream',
    },
    body: challenge,
  });
  return res.body.toString('base64');
}

async function startWidevineChallenge(pssh) {
  const logs = [];
  const sessionId = await cdmOpen(REMOTE_WV_CDM, logs, 'Widevine');
  const challengeB64 = await cdmGetChallenge(
    REMOTE_WV_CDM, '/get_license_challenge/STREAMING', sessionId, pssh, logs, 'Widevine',
  );
  return { sessionId, challengeB64, logs, drm: 'widevine' };
}

async function finishWidevineKeys(sessionId, licenseB64) {
  const logs = [];
  await cdmParseLicense(REMOTE_WV_CDM, sessionId, licenseB64, logs, 'Widevine');
  const keys = await cdmGetKeys(REMOTE_WV_CDM, sessionId, logs, 'Widevine');
  await cdmClose(REMOTE_WV_CDM, sessionId);
  return { keys, logs };
}

function remotePlayReadyCdm() {
  return playReadyCdmBaseUrl();
}

async function startPlayReadyChallenge(initData) {
  if (localCdmAvailable()) {
    const round = await cdmLocal.playReadyRound(initData);
    return {
      sessionId: round.session,
      challengeB64: round.challengeB64,
      logs: ['PlayReady challenge (local cmds/*.prd)'],
      drm: 'playready',
      localPrd: true,
    };
  }
  const logs = [];
  const cdmBase = remotePlayReadyCdm();
  const sessionId = await cdmOpen(cdmBase, logs, 'PlayReady');
  const challengeB64 = await cdmGetChallenge(
    cdmBase, '/get_license_challenge', sessionId, initData, logs, 'PlayReady',
  );
  return { sessionId, challengeB64, logs, drm: 'playready', localPrd: false };
}

async function finishPlayReadyKeys(sessionId, licenseB64, { localPrd = false } = {}) {
  if (localPrd) {
    const keys = await cdmLocal.playReadyKeys(sessionId, licenseB64);
    return { keys, logs: [`Extracted ${keys.length} key(s) via local .prd`] };
  }
  const logs = [];
  const cdmBase = remotePlayReadyCdm();
  await cdmParseLicense(cdmBase, sessionId, licenseB64, logs, 'PlayReady');
  const keys = await cdmGetKeys(cdmBase, sessionId, logs, 'PlayReady');
  await cdmClose(cdmBase, sessionId);
  return { keys, logs };
}

async function fetchPlayReadyLicense(prUrl, challengeB64, authToken) {
  const challenge = Buffer.from(challengeB64, 'base64');
  try {
    const res = await requestBuffer(prUrl, {
      step: 'PlayReady license',
      method: 'POST',
      headers: playReadyLicenseHeaders(authToken),
      body: challenge,
    });
    return res.body.toString('base64');
  } catch (e) {
    if (e.status !== 415 && e.status !== 400) throw e;
    const res = await requestBuffer(prUrl, {
      step: 'PlayReady license',
      method: 'POST',
      headers: {
        ...playbackHeaders(authToken),
        'Content-Type': 'application/octet-stream',
      },
      body: challenge,
    });
    return res.body.toString('base64');
  }
}

async function extractKeysFromMpd(mpdXml, entry, playback, token, logs) {
  const mpdPr = extractPlayReadyFromMpd(mpdXml);
  const playReadyUrl = pickPlayReadyLicenseUrl(entry, playback, mpdPr);

  if (mpdPr?.initData && playReadyUrl) {
    logs.push(`PlayReady URL: ${playReadyUrl}`);
    const session = await startPlayReadyChallenge(mpdPr.initData);
    logs.push(...session.logs);
    const license = await fetchPlayReadyLicense(playReadyUrl, session.challengeB64, token);
    logs.push('PlayReady license received');
    const { keys, logs: keyLogs } = await finishPlayReadyKeys(session.sessionId, license, {
      localPrd: session.localPrd,
    });
    logs.push(...keyLogs);
    return {
      keys,
      drm: 'playready',
      playReadyUrl,
      laUrl: playReadyUrl,
      pssh: mpdPr.initData,
    };
  }

  const widevineUrl = entry?.LaUrl || playback?.LaUrl;
  if (!widevineUrl) throw new Error('No PlayReady data in MPD and no Widevine LaUrl');

  logs.push('PlayReady not in MPD — falling back to Widevine LaUrl');
  const pssh = extractPsshFromMpd(mpdXml);
  logs.push('Widevine PSSH extracted');
  const session = await startWidevineChallenge(pssh);
  logs.push(...session.logs);
  const license = await fetchLicenseServer(widevineUrl, session.challengeB64, token);
  logs.push('Widevine license received');
  const { keys, logs: keyLogs } = await finishWidevineKeys(session.sessionId, license);
  logs.push(...keyLogs);
  return {
    keys,
    drm: 'widevine',
    playReadyUrl: playReadyUrl || null,
    laUrl: widevineUrl,
    pssh,
  };
}

function buildDownloadCmd(manifestUrl, keys, title, format = 'mkv') {
  const safe = (title || 'Kayo_Video').replace(/[^a-zA-Z0-9_\-() ]/g, '').trim() || 'Kayo_Video';
  const keyFlags = keys.map((k) => `--key ${k.kid}:${k.key}`).join(' ');
  return [
    `N_m3u8DL-RE "${manifestUrl}"`,
    keyFlags,
    '--header "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"',
    '--header "Referer: https://kayosports.com.au/"',
    '--append-url-params',
    `-mt --del-after-done true -M format=${format}`,
    `--save-name "D:\\\\${safe}"`,
  ].join(' ');
}

const VPN_HINT = 'Kayo API calls run in your browser (uses VPN). Only key extraction uses the local server.';

async function resolvePlayback({
  assetId, authToken, step, sessionId, licenseB64, pssh, initData, drm,
  manifestUrl, laUrl, playReadyUrl, title, cdnName, localPrd,
}) {
  if (step === 'challenge') {
    if (drm === 'playready') {
      if (!initData) throw new Error('initData is required for PlayReady');
      const result = await startPlayReadyChallenge(initData);
      return { ...result, hint: VPN_HINT };
    }
    if (!pssh) throw new Error('pssh is required');
    const result = await startWidevineChallenge(pssh);
    return { ...result, hint: VPN_HINT };
  }

  if (step === 'keys') {
    if (!sessionId || !licenseB64) throw new Error('sessionId and licenseB64 are required');
    const finish = drm === 'playready' ? finishPlayReadyKeys : finishWidevineKeys;
    const { keys, logs } = await finish(sessionId, licenseB64, { localPrd: !!localPrd });
    return {
      title: title || assetId,
      manifestUrl,
      laUrl: laUrl || playReadyUrl,
      playReadyUrl: playReadyUrl || laUrl,
      pssh,
      drm: drm || 'widevine',
      keys,
      cdnName,
      logs,
      cmd: buildDownloadCmd(manifestUrl, keys, title, 'mkv'),
    };
  }

  const logs = [];
  const token = normalizeToken(authToken);
  if (!assetId) throw new Error('assetId is required');
  if (!token) throw new Error('Kayo Bearer token is required');

  logs.push(`Playback API for asset ${assetId} (server — may bypass VPN)`);
  const playbackUrl = buildPlaybackUrl(assetId);
  let playback;
  try {
    playback = await requestJson(playbackUrl, {
      step: 'Playback API',
      headers: playbackHeaders(token),
    });
  } catch (e) {
    if (e.status === 401) throw new Error('Token expired — paste a fresh Bearer token from Kayo DevTools');
    if (e.status === 403) {
      throw new Error('Playback API blocked on server (403). Use Fetch again — it will call Kayo via your browser/VPN automatically.');
    }
    throw e;
  }

  if (playback['odata.error']) {
    throw new Error(playback['odata.error'].message?.value || 'Playback API error');
  }

  const entry = pickCdnEntry(playback);
  if (!entry) throw new Error('No CDN manifest in playback response');

  const cdnToken = entry.CdnToken?.Value;
  if (!cdnToken) throw new Error('No CDN token in playback response');

  const resolvedLaUrl = entry.LaUrl || playback.LaUrl;

  const resolvedManifestUrl = buildManifestUrl(entry.ManifestUrl, cdnToken);
  logs.push(`Manifest: ${entry.CdnName}`);

  const mpdXml = await requestText(resolvedManifestUrl, {
    step: 'MPD manifest',
    headers: KAYO_HEADERS,
  });
  logs.push('MPD fetched');

  const keyResult = await extractKeysFromMpd(mpdXml, entry, playback, token, logs);
  const resolvedTitle = playback.Asset?.Title || playback.Title || assetId;

  return {
    title: resolvedTitle,
    manifestUrl: resolvedManifestUrl,
    laUrl: keyResult.laUrl,
    playReadyUrl: keyResult.playReadyUrl,
    pssh: keyResult.pssh,
    drm: keyResult.drm,
    keys: keyResult.keys,
    cdnName: entry.CdnName,
    logs,
    cmd: buildDownloadCmd(resolvedManifestUrl, keyResult.keys, resolvedTitle, 'mkv'),
  };
}

module.exports = {
  resolvePlayback,
  buildDownloadCmd,
  buildPlaybackUrl,
  buildManifestUrl,
  pickCdnEntry,
  extractKeysFromMpd,
  extractPsshFromMpd,
  extractAllPlayReadyPsshFromMpd,
  extractAllWidevinePsshFromMpd,
  mergeKeysByKid,
  isPlayReadyLicenseUrl,
  extractPlayReadyFromMpd,
  pickPlayReadyLicenseUrl,
  playReadyLicenseHeaders,
  playbackHeaders,
  normalizeToken,
};
