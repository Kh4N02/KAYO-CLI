'use strict';

const zlib = require('zlib');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const SEARCH_BASE = 'https://search.discovery.indazn.com/jp/v1/Search';

function requestSearchJson(url, { headers = {}, useProxy = true, proxyAgent = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const agent = useProxy ? proxyAgent : undefined;
    const req = lib.request(u, { method: 'GET', headers, agent, timeout: 45000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
          return;
        }
        try {
          let buf = Buffer.concat(chunks);
          if (res.headers['content-encoding'] === 'gzip') {
            buf = zlib.gunzipSync(buf);
          }
          resolve(JSON.parse(buf.toString('utf8') || '{}'));
        } catch (err) {
          reject(new Error(`Search response was not JSON: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Search request timeout')));
    req.end();
  });
}

function flattenSearchTiles(data, { eventsOnly = true } = {}) {
  const tiles = [];
  for (const cat of data.Results || []) {
    const catId = String(cat.Id || '').toLowerCase();
    if (eventsOnly && catId && !catId.includes('event') && !catId.includes('feature')) continue;
    for (const tile of cat.Tiles || []) {
      const type = String(tile.Type || '').toLowerCase();
      if (eventsOnly && type === 'navigation') continue;
      if (!tile.AssetId) continue;
      tiles.push(tile);
    }
  }
  return tiles;
}

async function fetchSearch(query, token, deps, { eventsOnly = true } = {}) {
  const {
    kayoHeaders,
    proxyAgent,
    mapTile,
    applyUhdCacheToItem,
    applyVerifiedUhd,
    warmUhdAssetCache,
    sortByRecent,
  } = deps;

  const term = String(query || '').trim();
  if (!term) return [];

  const params = new URLSearchParams({
    SearchTerm: term,
    country: 'au',
    brand: 'kayo',
    languageCode: 'en',
    platform: 'web',
  });

  const data = await requestSearchJson(`${SEARCH_BASE}?${params}`, {
    headers: kayoHeaders(token),
    useProxy: true,
    proxyAgent: proxyAgent(),
  });

  await warmUhdAssetCache(token).catch(() => {});

  const seen = new Set();
  const items = [];
  for (const tile of flattenSearchTiles(data, { eventsOnly })) {
    if (seen.has(tile.AssetId)) continue;
    seen.add(tile.AssetId);
    items.push(applyVerifiedUhd(applyUhdCacheToItem(mapTile(tile))));
  }
  return sortByRecent(items);
}

module.exports = {
  fetchSearch,
  flattenSearchTiles,
};
