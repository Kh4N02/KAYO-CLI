'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');

const { vendor, tokenFile, ROOT } = require('./paths');
const { parseCustomProxy } = require(vendor('proxy-parse'));
const {
  normalizeToken,
  isJwtLike,
  resolveRefreshDeviceId,
  tokenNeedsRefresh,
  tokenExpiryMs,
  parseTokenPayload,
} = require(vendor('auth'));
const { fastRefresh, DEFAULT_TIMEOUT_MS } = require('./fast-auth');
const { signInViaBrowser } = require('./browser-auth');
const { loadLiveTvRail } = require('./live-tv-rail');
const { loadCricketUhdSupplement, applyVerifiedUhd } = require('./cricket-uhd-supplement');
const {
  loadCache,
  saveCache,
  isFresh,
  forceRefreshAll,
  formatCacheAge,
  defaultTtlHours,
} = require('./discovery-cache');
const { fetchSearch: fetchSearchApi } = require('./kayo-search');
const { SPORT_NAV_IDS } = require('./sport-subcategories');
const { proxyCandidates: authProxyCandidates } = require('./proxy-request');

const BROWSER_LOGIN_TIMEOUT_MS = 75000;

function proxyHost(proxy) {
  return String(proxy || '').split(':')[0] || '';
}

function shouldSkipBrowser() {
  return process.env.KAYO_SKIP_BROWSER === '1';
}

function proxyCandidates() {
  return authProxyCandidates();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuthBlockedError(err) {
  return /403|CloudFront|blocked|97-000|10-000-000|No key found/i.test(String(err?.message || err || ''));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const EPG_BASE = 'https://epg.discovery.indazn.com/eu/v5/epgWithDatesRange';
const EPG_CHUNK_DAYS = 6;
const EPG_FETCH_CONCURRENCY = 10;
const UHD_RAIL_CONCURRENCY = 16;
const LIVE_TV_RAIL_ID = '9a782d94-691b-4077-8d58-86a04c424861';
const RAIL_ROUTER_BASES = [
  `https://ruleset-rail-router.discovery.indazn.com/jp/v1/Rail?platform=web&id=${LIVE_TV_RAIL_ID}&country=au&brand=kayo&languageCode=en&params=PageType:Home%3BContentType:None`,
  `https://rail-router.discovery.indazn.com/jp/v10/Rail?platform=web&id=Livetvschedule&country=au&brand=kayo&languageCode=en`,
];
const RAIL_BASES = [
  'https://rails.discovery.indazn.com/eu/v6/Rail',
  'https://rails.discovery.indazn.com/eu/v5/Rail',
];

const SESSION_PATH = tokenFile();

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

function loadSession() {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    }
  } catch { /* ignore */ }

  const legacy = String(process.env.KAYO_LEGACY_TOKEN_FILE || '').trim();
  if (legacy && fs.existsSync(legacy)) {
    try {
      return JSON.parse(fs.readFileSync(legacy, 'utf8'));
    } catch { /* ignore */ }
  }
  return {};
}

function saveSession(patch) {
  const prev = loadSession();
  const next = { ...prev, ...patch, updated: new Date().toISOString() };
  fs.writeFileSync(SESSION_PATH, JSON.stringify(next, null, 2), 'utf8');
}

function proxySpec() {
  return String(process.env.KAYO_PROXY || '').trim();
}

function proxyAgent() {
  const tunnel = String(process.env.KAYO_PROXY_TUNNEL || '').trim();
  const spec = tunnel || proxySpec();
  const url = parseCustomProxy(spec);
  return url ? new HttpsProxyAgent(url, { timeout: 20000 }) : undefined;
}

function daznIdFromToken(token) {
  const p = parseTokenPayload(token);
  return p?.user || (p?.viewerId ? String(p.viewerId).split('-kayo')[0] : null);
}

function kayoHeaders(token, extra = {}) {
  const t = token ? normalizeToken(token) : '';
  const daznId = t ? daznIdFromToken(t) : null;
  const sess = loadSession();
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-AU,en;q=0.9',
    Origin: 'https://kayosports.com.au',
    Referer: 'https://kayosports.com.au/',
    'x-brand': 'kayo',
    ...extra,
  };
  if (t) headers.Authorization = `Bearer ${t}`;
  if (daznId) headers['x-daznid'] = daznId;
  if (sess.sessionId) headers['x-session-id'] = sess.sessionId;
  return headers;
}

function requestJson(url, { method = 'GET', headers = {}, body = null, useProxy = true } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const agent = useProxy ? proxyAgent() : undefined;
    const req = lib.request(u, { method, headers, agent, timeout: 45000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data || '{}'));
        } catch {
          reject(new Error('Response was not JSON'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function tryRefresh(seed, proxies, sessionId, deviceId, status) {
  if (!isJwtLike(seed)) return null;
  const token = normalizeToken(seed);
  for (const proxy of proxies) {
    const host = proxyHost(proxy);
    status(`Refreshing token via ${host} (~${DEFAULT_TIMEOUT_MS / 1000}s)...`);
    try {
      const next = await fastRefresh(
        token,
        proxy,
        sessionId,
        deviceId || resolveRefreshDeviceId(token),
      );
      return { token: next, proxy };
    } catch (err) {
      status(`Refresh via ${host} failed: ${(err.message || err).slice(0, 120)}`);
    }
  }
  return null;
}

/** Token for playback/4K — prefers kayo-token.json / KAYO_TOKEN without opening browser. */
function tokenForPlayback(onStatus) {
  const status = onStatus || (() => {});
  loadEnv();
  const sess = loadSession();
  const cached = isJwtLike(sess.token) ? normalizeToken(sess.token) : '';
  const envSeed = isJwtLike(process.env.KAYO_TOKEN) ? normalizeToken(process.env.KAYO_TOKEN) : '';
  const pick = cached || envSeed;
  if (pick && tokenExpiryMs(pick) && tokenExpiryMs(pick) > Date.now()) {
    status('Using session token (skip re-login)');
    return pick;
  }
  return null;
}

async function authenticate(onStatus) {
  const status = onStatus || (() => {});
  const proxies = proxyCandidates();
  if (!proxies.length) throw new Error('KAYO_PROXY not set in .env');

  const email = String(process.env.KAYO_EMAIL || '').trim();
  const password = String(process.env.KAYO_PASSWORD || '');

  const sess = loadSession();
  const sessionId = sess.sessionId || require('crypto').randomUUID();
  const deviceId = sess.deviceId || process.env.KAYO_DEVICE_ID;

  const cached = isJwtLike(sess.token) ? normalizeToken(sess.token) : '';
  if (cached && !tokenNeedsRefresh(cached, false)) {
    status('Using cached Kayo session token');
    return cached;
  }

  const envSeed = isJwtLike(process.env.KAYO_TOKEN) ? normalizeToken(process.env.KAYO_TOKEN) : '';
  const refreshSeeds = [...new Set([envSeed, cached].filter(Boolean))];
  let lastErr;

  for (const seed of refreshSeeds) {
    const refreshed = await tryRefresh(seed, proxies, sessionId, deviceId, status);
    if (refreshed) {
      saveSession({
        token: refreshed.token,
        deviceId: resolveRefreshDeviceId(refreshed.token) || deviceId,
        sessionId,
      });
      return refreshed.token;
    }
  }

  const stillValid = (t) => {
    const exp = tokenExpiryMs(t);
    return exp && exp > Date.now();
  };
  if (cached && stillValid(cached)) {
    status('Refresh failed — using saved token (still valid, no re-login)');
    return cached;
  }
  if (envSeed && stillValid(envSeed)) {
    status('Refresh failed — using KAYO_TOKEN (still valid, no re-login)');
    saveSession({
      token: envSeed,
      deviceId: resolveRefreshDeviceId(envSeed) || deviceId,
      sessionId,
    });
    return envSeed;
  }

  // Refresh failed — browser login with .env credentials (after proxy wait).
  if (email && password && !shouldSkipBrowser()) {
    try {
      status(`Browser login (max ${BROWSER_LOGIN_TIMEOUT_MS / 1000}s)...`);
      const browserToken = await Promise.race([
        signInViaBrowser({
          email,
          password,
          onStatus: status,
          headless: process.env.KAYO_BROWSER_HEADLESS === '1',
        }),
        sleep(BROWSER_LOGIN_TIMEOUT_MS).then(() => {
          throw new Error('Browser login timed out');
        }),
      ]);
      saveSession({
        token: browserToken,
        deviceId: resolveRefreshDeviceId(browserToken) || deviceId,
        sessionId,
      });
      status('Browser login OK — session saved to kayo-token.json');
      return browserToken;
    } catch (browserErr) {
      lastErr = browserErr;
    }
  } else if (email && password && shouldSkipBrowser()) {
    lastErr = new Error('Browser login disabled (KAYO_SKIP_BROWSER=1)');
  } else if (!email || !password) {
    lastErr = lastErr || new Error('Set KAYO_EMAIL and KAYO_PASSWORD in .env for automatic browser login');
  }

  const tunnel = String(process.env.KAYO_PROXY_TUNNEL || '').trim();
  const hint = refreshSeeds.length
    ? 'Token refresh failed — re-run kayo.cmd (browser login uses KAYO_EMAIL/KAYO_PASSWORD in .env)'
    : 'First-time setup: set KAYO_EMAIL and KAYO_PASSWORD in .env, then run kayo.cmd';
  const tunnelNote = tunnel
    ? `\nKeep VPN/tunnel running (${tunnel} → AU proxy).`
    : '';

  throw new Error(
    `Could not get Kayo token.\n${hint}${tunnelNote}\nLast error: ${lastErr?.message || lastErr || 'unknown'}`,
  );
}

function auTimezoneOffsetMinutes() {
  const month = new Date().getUTCMonth();
  const isDst = month >= 9 || month <= 3;
  return isDst ? 660 : 600;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function deriveStatus(tile) {
  const type = String(tile.Type || tile.DisplayType || '').toLowerCase();
  if (tile.IsLinear || type === 'live') return 'Live';
  if (type === 'upcoming' || type === 'fixture' || type === 'scheduled') return 'Upcoming';
  if (tile.Start) {
    const now = Date.now();
    const start = new Date(tile.Start).getTime();
    const end = tile.End ? new Date(tile.End).getTime() : null;
    if (end && now >= start && now <= end) return 'Live';
    if (start > now) return 'Upcoming';
  }
  if (type === 'catchup' || type === 'replay') return 'Catchup';
  return '';
}

function mapTile(tile) {
  const rawType = tile.Type || '';
  const displayType = tile.DisplayType || tile.DisplayTypeLabel || tile.Label || '';
  return {
    assetId: tile.AssetId || null,
    eventId: tile.EventId || null,
    title: tile.Title || '',
    sport: tile.Sport?.Title || '',
    sportId: tile.Sport?.Id || null,
    competition: tile.Competition?.Title || '',
    label: tile.Label || tile.DisplayTypeLabel || '',
    rawType,
    displayType,
    type: rawType || displayType || '',
    status: deriveStatus(tile),
    isLinear: !!tile.IsLinear,
    start: tile.Start || null,
    end: tile.End || null,
    quality: tile.IsLinear
      ? 'HD'
      : (isLikelyUhdEvent({
        title: tile.Title,
        competition: tile.Competition?.Title,
        status: deriveStatus(tile),
      }, tile) ? 'UHD' : 'HD'),
    channel: tile.IsLinear
      ? (tile.Sport?.Title || tile.Competition?.Title || 'Live TV')
      : (tile.Sport?.Title || tile.Competition?.Title || 'Kayo'),
    logoImageId: tile.LogoImage?.Id || tile.Image?.Id || null,
  };
}

function mergeTilesByAssetId(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list || []) {
      if (!item?.assetId || seen.has(item.assetId)) continue;
      seen.add(item.assetId);
      out.push(item);
    }
  }
  return out;
}

function sortLiveUpcoming(items) {
  const rank = { Live: 0, Upcoming: 1 };
  return [...items].sort((a, b) => {
    const ra = rank[a.status] ?? 9;
    const rb = rank[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    const sa = a.start ? new Date(a.start).getTime() : 0;
    const sb = b.start ? new Date(b.start).getTime() : 0;
    return sa - sb;
  });
}

function formatLocalTime(iso) {
  if (!iso) return '';
  try {
    // Device locale + timezone (Kuwait, UK, AU, etc.)
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: undefined,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function isCricketUhdItem(item, sportTitle = 'Cricket') {
  if (!item) return false;
  if (item.sport === sportTitle) return true;
  const haystack = `${item.title} ${item.competition} ${item.label}`.toLowerCase();
  return /cricket|twenty20|t20i|t20 |test cricket|ashes|\bodi\b/.test(haystack)
    || (/pakistan/.test(haystack) && /australia/.test(haystack));
}

async function fetchRailRouter(token) {
  let lastErr;
  for (const url of RAIL_ROUTER_BASES) {
    try {
      const data = await requestJson(url, { headers: kayoHeaders(token), useProxy: true });
      if (data.Tiles?.length) {
        const { saveRailSnapshot } = require('./live-tv-rail');
        saveRailSnapshot(data);
        return (data.Tiles || []).map(mapTile).filter((t) => t.assetId);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not fetch rail-router');
}

const LIVE_UPCOMING_RAIL_ID = 'acf17a4a-e499-4fc6-9d85-87c98a5ff1cc';

let uhdAssetIds = null;
let uhdItemsCache = null;
let uhdWarmPromise = null;

function homePageParams(openBrowse = true) {
  const base = 'PageType:Home;ContentType:None';
  return openBrowse ? `${base};OpenBrowse:True` : base;
}

function markUhdQuality(item) {
  return { ...item, quality: 'UHD' };
}

function isUhdTile(tile) {
  if (!tile) return false;
  if (tile.HeEventTypeConfig?.is4k === true) return true;
  if ((tile.dolbyConfig || []).some((d) => /4k|uhd|hevc/i.test(JSON.stringify(d)))) return true;
  if (/4k|uhd/i.test(tile.Title || '')) return true;
  return false;
}

function isF1MainSession(title) {
  const t = String(title || '').toLowerCase();
  if (/tracker|pit lane|timing|kid|co-pilot|driver tracker|mini|bite|highlights/i.test(t)) {
    return false;
  }
  return /race|qualifying|sprint|practice|grand prix/i.test(t);
}

function isLikelyUhdEvent(mapped, rawTile = null) {
  if (isUhdTile(rawTile)) return true;
  const title = mapped.title || '';
  const comp = mapped.competition || rawTile?.Competition?.Title || '';
  const status = mapped.status || deriveStatus(rawTile || {});
  if (/4k|uhd/i.test(title)) return true;
  // F1 UHD is only offered live/upcoming on Kayo — not on catchup replays.
  if (/formula 1/i.test(comp) && isF1MainSession(title)) {
    return status === 'Live' || status === 'Upcoming';
  }
  return false;
}

function sportPageParams(navId, openBrowse = true) {
  const base = `PageType:Sport;ContentType:Sport;ContentId:${navId}`;
  return openBrowse ? `${base};OpenBrowse:True` : base;
}

function rulesetRailUrl(railId, pageParams) {
  const params = new URLSearchParams({
    platform: 'web',
    id: railId,
    country: 'au',
    brand: 'kayo',
    languageCode: 'en',
  });
  if (pageParams) params.set('params', pageParams);
  return `https://ruleset-rail-router.discovery.indazn.com/jp/v1/Rail?${params}`;
}

async function fetchRail(railId, token, { pageParams = null } = {}) {
  if (railId === LIVE_TV_RAIL_ID) {
    try {
      return await fetchRailRouter(token);
    } catch { /* fall through to legacy */ }
  }

  let lastErr;
  const rulesetAttempts = pageParams ? [pageParams, null] : [null];
  for (const params of rulesetAttempts) {
    try {
      const data = await requestJson(rulesetRailUrl(railId, params), {
        headers: kayoHeaders(token),
        useProxy: true,
      });
      if (data.Tiles) return tilesFromRailJson(data);
    } catch (e) {
      lastErr = e;
    }
  }

  const legacyParams = new URLSearchParams({
    id: railId,
    country: 'au',
    languageCode: 'en',
    brand: 'kayo',
    platform: 'web',
  });
  for (const base of RAIL_BASES) {
    try {
      const data = await requestJson(`${base}?${legacyParams}`, {
        headers: kayoHeaders(token),
        useProxy: true,
      });
      if (data.Tiles) return tilesFromRailJson(data);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not fetch rail');
}

async function fetchRailTitle(railId, token, { pageParams = null } = {}) {
  const data = await requestJson(rulesetRailUrl(railId, pageParams), {
    headers: kayoHeaders(token),
    useProxy: true,
  });
  return String(data.Title || data.title || '').trim();
}

function tilesFromRailJson(json) {
  const items = (json.Tiles || []).map(mapTile).filter((t) => t.assetId);
  return uhdAssetIds ? items.map(applyUhdCacheToItem) : items;
}

function sortByRecent(items) {
  return [...items].sort((a, b) => {
    const ta = a.start ? new Date(a.start).getTime() : 0;
    const tb = b.start ? new Date(b.start).getTime() : 0;
    return tb - ta;
  });
}

const CRICKET_REPLAY_DAYS_BACK = 730;
const UHD_CACHE_NAME = 'uhd-events-cache';

function replayPoolCacheName(sportTitle) {
  return `replay-pool-${slugifySportTitle(sportTitle)}`;
}

function applyUhdItemsToMemory(items) {
  uhdItemsCache = items;
  uhdAssetIds = new Set(items.map((i) => i.assetId).filter(Boolean));
  return uhdAssetIds;
}

function hydrateUhdFromDisk() {
  const cached = loadCache(UHD_CACHE_NAME);
  if (!cached?.items?.length || !isFresh(cached)) return null;
  applyUhdItemsToMemory(cached.items);
  return cached;
}

async function fetchSportReplayPool(sportTitle, token, { daysBack = null, forceRefresh = false } = {}) {
  const shouldRefresh = forceRefresh || forceRefreshAll();
  const poolCacheName = replayPoolCacheName(sportTitle);
  if (!shouldRefresh) {
    const cached = loadCache(poolCacheName);
    if (cached?.items?.length && isFresh(cached)) {
      return cached.items;
    }
  }

  const lookback = daysBack ?? (sportTitle === 'Cricket' ? CRICKET_REPLAY_DAYS_BACK : 365);
  const navMap = await discoverSportNavIds().catch(() => ({ ...SPORT_NAV_IDS }));
  const navId = navMap[sportTitle] || SPORT_NAV_IDS[sportTitle];

  const [epgItems, railItems] = await Promise.all([
    fetchEpgTiles({
      sportTitleExact: sportTitle,
      catchupOnly: true,
      daysBack: lookback,
      daysForward: 0,
    }),
    (async () => {
      if (!navId || !token) return [];
      const { pageParams, railIds } = await fetchSportRailIds(navId, token);
      if (!railIds.length) return [];
      const batches = await mapPool(
        railIds,
        (railId) => fetchRail(railId, token, { pageParams }).catch(() => []),
        12,
      );
      return mergeTilesByAssetId(...batches);
    })(),
  ]);

  let uhdItems = [];
  if (token) {
    await warmUhdAssetCache(token);
    if (uhdItemsCache?.length) {
      uhdItems = uhdItemsCache
        .filter((item) => (sportTitle === 'Cricket'
          ? isCricketUhdItem(item, sportTitle)
          : item.sport === sportTitle))
        .map(markUhdQuality);
    }
  }

  let result;
  if (sportTitle === 'Cricket') {
    const supplement = loadCricketUhdSupplement();
    result = supplement.length
      ? sortByRecent(mergeTilesByAssetId(railItems, epgItems, uhdItems, supplement))
      : sortByRecent(mergeTilesByAssetId(railItems, epgItems, uhdItems));
  } else {
    result = sortByRecent(mergeTilesByAssetId(railItems, epgItems, uhdItems));
  }

  saveCache(poolCacheName, { sportTitle, items: result });
  return result;
}

async function fetchCricketUhdItems(token, { forceRefresh = false } = {}) {
  const pool = await fetchSportReplayPool('Cricket', token, { forceRefresh });
  return sortByRecent(pool.filter((item) => {
    if (item.quality !== 'UHD') return false;
    const type = String(item.type || item.rawType || '').toLowerCase();
    return type !== 'live' && !item.isLinear && item.status !== 'Live';
  }));
}

function extractRailIds(catalog) {
  return (catalog?.Rails || catalog?.rails || [])
    .map((rail) => (typeof rail === 'string' ? rail : (rail.Id || rail.id)))
    .filter((id) => /^[0-9a-f-]{36}$/i.test(String(id)));
}

async function fetchRawRailTiles(railId, token, pageParams) {
  const data = await requestJson(rulesetRailUrl(railId, pageParams), {
    headers: kayoHeaders(token),
    useProxy: true,
  });
  return data.Tiles || [];
}

async function fetchHomeRailIds(token) {
  const pageParams = homePageParams();
  const url = `https://rails.discovery.indazn.com/jp/v9/rails?groupId=home&country=au&params=${encodeURIComponent(pageParams)}&openBrowse=true&brand=kayo`;
  const data = await requestJson(url, { headers: kayoHeaders(token), useProxy: true });
  return extractRailIds(data);
}

async function discoverSportNavIds() {
  const map = { ...SPORT_NAV_IDS };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rangeStart = addDays(today, -90);
  const rangeEnd = addDays(today, 7);
  const responses = await fetchEpgResponsesParallel(rangeStart, rangeEnd);
  for (const data of responses) {
    for (const tile of data.Tiles || []) {
      const title = tile.Sport?.Title;
      const id = tile.Sport?.Id;
      if (title && id) map[title] = id;
    }
  }
  return map;
}

function buildEpgDateChunks(rangeStart, rangeEnd, chunkDays = EPG_CHUNK_DAYS) {
  const chunks = [];
  for (let cur = new Date(rangeStart); cur <= rangeEnd; cur = addDays(cur, chunkDays)) {
    const chunkEnd = addDays(cur, chunkDays);
    chunks.push({
      start: new Date(cur),
      end: chunkEnd > rangeEnd ? rangeEnd : chunkEnd,
    });
  }
  return chunks;
}

async function requestEpgChunk(startDate, endDate, tzOffset) {
  const params = new URLSearchParams({
    country: 'au',
    languageCode: 'en',
    openBrowse: 'false',
    timeZoneOffset: String(tzOffset),
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
    brand: 'kayo',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestJson(`${EPG_BASE}?${params}`, { useProxy: true });
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(800 * (attempt + 1));
    }
  }
  return { Tiles: [] };
}

async function fetchEpgResponsesParallel(rangeStart, rangeEnd, concurrency = EPG_FETCH_CONCURRENCY) {
  const tzOffset = auTimezoneOffsetMinutes();
  const chunks = buildEpgDateChunks(rangeStart, rangeEnd);
  return mapPool(chunks, async ({ start, end }) => {
    try {
      return await requestEpgChunk(start, end, tzOffset);
    } catch {
      return { Tiles: [] };
    }
  }, concurrency);
}

async function mapPool(items, mapper, concurrency = 12) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function fetchSportRailIds(navId, token) {
  const pageParams = sportPageParams(navId);
  const url = `https://rails.discovery.indazn.com/jp/v9/rails?groupId=sport&country=au&params=${encodeURIComponent(pageParams)}&openBrowse=true&brand=kayo`;
  try {
    const data = await requestJson(url, { headers: kayoHeaders(token), useProxy: true });
    return { pageParams, railIds: extractRailIds(data) };
  } catch {
    return { pageParams, railIds: [] };
  }
}

function applyUhdCacheToItem(item) {
  if (uhdAssetIds?.has(item.assetId)) return markUhdQuality(item);
  return item;
}

function sortUhdItems(items) {
  const rank = { Live: 0, Upcoming: 1, Catchup: 2 };
  return [...items].sort((a, b) => {
    const ra = rank[a.status] ?? 9;
    const rb = rank[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    const ta = a.start ? new Date(a.start).getTime() : 0;
    const tb = b.start ? new Date(b.start).getTime() : 0;
    return tb - ta;
  });
}

async function collectAllUhdItems(token) {
  const homeParams = homePageParams();
  const [homeRailIds, navMap] = await Promise.all([
    fetchHomeRailIds(token).catch(() => []),
    discoverSportNavIds(),
  ]);

  const catalogs = await mapPool(
    [...new Set(Object.values(navMap))],
    (navId) => fetchSportRailIds(navId, token),
    12,
  );
  const sportRailPairs = [];
  for (const { pageParams, railIds } of catalogs) {
    for (const railId of railIds) {
      sportRailPairs.push({ railId, pageParams });
    }
  }

  const mapUhdRailTiles = (tiles) => tiles.filter(isUhdTile).map(mapTile);

  const [homeBatches, sportBatches, liveBatch] = await Promise.all([
    mapPool(homeRailIds, (railId) =>
      fetchRawRailTiles(railId, token, homeParams)
        .then(mapUhdRailTiles)
        .catch(() => []),
    UHD_RAIL_CONCURRENCY),
    mapPool(sportRailPairs, ({ railId, pageParams }) =>
      fetchRawRailTiles(railId, token, pageParams)
        .then(mapUhdRailTiles)
        .catch(() => []),
    UHD_RAIL_CONCURRENCY),
    fetchRawRailTiles(LIVE_UPCOMING_RAIL_ID, token, homeParams)
      .then((tiles) => {
        const items = [];
        for (const tile of tiles) {
          if (isUhdTile(tile)) {
            items.push(mapTile(tile));
            continue;
          }
          const mapped = mapTile(tile);
          if (/formula 1/i.test(mapped.competition) && isF1MainSession(mapped.title)
            && (mapped.status === 'Live' || mapped.status === 'Upcoming')) {
            items.push(mapped);
          }
        }
        return items;
      })
      .catch(() => []),
  ]);

  const seen = new Set();
  const out = [];
  for (const items of [...homeBatches, ...sportBatches, liveBatch]) {
    for (const item of items) {
      if (!item?.assetId || seen.has(item.assetId)) continue;
      seen.add(item.assetId);
      out.push(markUhdQuality(item));
    }
  }
  return out;
}

async function warmUhdAssetCache(token, { forceRefresh = false } = {}) {
  const shouldRefresh = forceRefresh || forceRefreshAll();
  if (uhdAssetIds && uhdItemsCache && !shouldRefresh) return uhdAssetIds;

  if (!shouldRefresh) {
    const cached = hydrateUhdFromDisk();
    if (cached) return uhdAssetIds;
  } else {
    resetUhdCache();
  }

  if (!uhdWarmPromise) {
    uhdWarmPromise = collectAllUhdItems(token)
      .then((items) => {
        applyUhdItemsToMemory(items);
        saveCache(UHD_CACHE_NAME, { items });
        return uhdAssetIds;
      })
      .finally(() => {
        uhdWarmPromise = null;
      });
  }
  return uhdWarmPromise;
}

function resetUhdCache() {
  uhdAssetIds = null;
  uhdItemsCache = null;
  uhdWarmPromise = null;
}

async function fetchLiveTvChannels(token) {
  try {
    const items = await fetchRail(LIVE_TV_RAIL_ID, token);
    if (items.length) return items;
  } catch { /* try cache */ }

  const cached = loadLiveTvRail();
  if (cached?.Tiles?.length) {
    return tilesFromRailJson(cached);
  }

  return fetchEpgTiles({ liveOnly: true, daysBack: 0, daysForward: 3 });
}

function sportMatches(title, matcher) {
  const s = String(title || '').toLowerCase();
  if (typeof matcher === 'function') return matcher(s, title);
  if (Array.isArray(matcher)) return matcher.some((m) => s.includes(String(m).toLowerCase()));
  return s === String(matcher || '').toLowerCase() || s.includes(String(matcher || '').toLowerCase());
}

const REPLAY_SPORT_PRIORITY = [
  'Cricket',
  'Australian Rules Football',
  'Rugby League',
  'Motorsport',
  'Golf',
  'Basketball',
  'Baseball',
  'Netball',
  'Football',
  'Ice Hockey',
  'MMA',
  'American Football',
];

function replaySportSortKey(title) {
  const idx = REPLAY_SPORT_PRIORITY.indexOf(title);
  return idx >= 0 ? idx : REPLAY_SPORT_PRIORITY.length;
}

function slugifySportTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function discoverReplaySports({ daysBack = 365, daysForward = 0 } = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rangeStart = addDays(today, -daysBack);
  const rangeEnd = addDays(today, daysForward);
  const sportCounts = new Map();
  const responses = await fetchEpgResponsesParallel(rangeStart, rangeEnd);

  for (const data of responses) {
    for (const tile of data.Tiles || []) {
      const sportTitle = tile.Sport?.Title;
      if (!sportTitle) continue;
      const type = String(tile.Type || '').toLowerCase();
      if (type !== 'catchup') continue;
      sportCounts.set(sportTitle, (sportCounts.get(sportTitle) || 0) + 1);
    }
  }

  return [...sportCounts.entries()]
    .sort((a, b) => {
      const ra = replaySportSortKey(a[0]);
      const rb = replaySportSortKey(b[0]);
      if (ra !== rb) return ra - rb;
      return a[0].localeCompare(b[0]);
    })
    .map(([sportTitle, count]) => ({ sportTitle, count }));
}

function buildReplayCategory(sportTitle) {
  const key = `replay-${slugifySportTitle(sportTitle)}`;
  return {
    key,
    label: `${sportTitle} Replays`,
    sportTitle,
    hasSubcategories: true,
    fetch: (token) => fetchSportReplayPool(sportTitle, token),
  };
}

async function loadReplaySubcategories(sportTitle, token) {
  const { loadSportSubcategories } = require('./sport-subcategories');
  return loadSportSubcategories(sportTitle, {
    token,
    requestJson,
    kayoHeaders,
    fetchRail,
    fetchRailTitle,
    fetchEpgTiles,
    fetchSportReplayPool,
    fetchCricketUhdItems,
  });
}

async function fetchEpgTiles({
  daysBack = 7,
  daysForward = 7,
  sportFilter = null,
  sportTitleExact = null,
  catchupOnly = false,
  liveOnly = false,
  liveAndUpcomingOnly = false,
  uhdOnly = false,
} = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rangeStart = addDays(today, -daysBack);
  const rangeEnd = addDays(today, daysForward);
  const seen = new Set();
  const items = [];
  const responses = await fetchEpgResponsesParallel(rangeStart, rangeEnd);

  for (const data of responses) {
    for (const tile of data.Tiles || []) {
      const assetId = tile.AssetId;
      if (!assetId || seen.has(assetId)) continue;
      const mapped = mapTile(tile);
      if (sportTitleExact && mapped.sport !== sportTitleExact) continue;
      if (sportFilter && !sportMatches(mapped.sport, sportFilter)) continue;
      const type = (mapped.type || '').toLowerCase();
      if (catchupOnly && type !== 'catchup') continue;
      if (liveOnly && type !== 'live' && !mapped.isLinear) continue;
      if (liveAndUpcomingOnly && mapped.status !== 'Live' && mapped.status !== 'Upcoming') continue;
      if (uhdOnly) {
        if (!isLikelyUhdEvent(mapped, tile)) continue;
        mapped.quality = 'UHD';
      }
      seen.add(assetId);
      items.push(mapped);
    }
  }
  return uhdAssetIds ? items.map(applyUhdCacheToItem) : items;
}

async function fetchUhdEvents(token, { forceRefresh = false } = {}) {
  await warmUhdAssetCache(token, { forceRefresh: forceRefresh || forceRefreshAll() });
  return sortUhdItems(uhdItemsCache || []);
}

async function fetchSearch(query, token, { eventsOnly = true } = {}) {
  const items = await fetchSearchApi(query, token, {
    kayoHeaders,
    proxyAgent,
    mapTile,
    applyUhdCacheToItem,
    applyVerifiedUhd,
    warmUhdAssetCache,
    sortByRecent,
  }, { eventsOnly });
  return items;
}

const BASE_CATEGORIES = [
  { key: 'search', label: 'Search Kayo', isSearch: true },
  { key: 'live-tv', label: 'Live TV Channels', fetch: (token) => fetchLiveTvChannels(token) },
  {
    key: 'epg',
    label: 'Live & Upcoming (EPG)',
    fetch: async (token) => {
      const epg = await fetchEpgTiles({
        liveAndUpcomingOnly: true,
        daysBack: 0,
        daysForward: 7,
      });
      let rail = [];
      try {
        rail = await fetchRail('acf17a4a-e499-4fc6-9d85-87c98a5ff1cc', token);
      } catch { /* rail optional */ }
      return sortLiveUpcoming(mergeTilesByAssetId(rail, epg));
    },
  },
  { key: 'uhd', label: '4K UHD Events', fetch: (token) => fetchUhdEvents(token) },
];

let cachedCategories = null;

async function loadCategories(onStatus) {
  if (cachedCategories) return cachedCategories;

  const status = onStatus || (() => {});
  status('Discovering replay categories from EPG...');
  const replaySports = await discoverReplaySports();
  const replayCategories = replaySports.map(({ sportTitle }) => buildReplayCategory(sportTitle));
  cachedCategories = [...BASE_CATEGORIES, ...replayCategories];
  status(`Found ${replayCategories.length} replay sport(s)`);
  return cachedCategories;
}

function getCategories() {
  return cachedCategories || BASE_CATEGORIES;
}

module.exports = {
  loadEnv,
  authenticate,
  tokenForPlayback,
  loadCategories,
  getCategories,
  loadReplaySubcategories,
  discoverReplaySports,
  fetchRail,
  fetchSportReplayPool,
  fetchCricketUhdItems,
  fetchSearch,
  formatLocalTime,
  warmUhdAssetCache,
  hydrateUhdFromDisk,
  formatCacheAge,
  proxySpec,
  proxyCandidates,
  proxyAgent,
  ROOT,
};
