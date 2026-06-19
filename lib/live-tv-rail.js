'use strict';

const fs = require('fs');
const path = require('path');

const LIVE_TV_RAIL_ID = '9a782d94-691b-4077-8d58-86a04c424861';
const DATA_PATH = path.join(__dirname, '..', 'data', 'live-tv-rail.json');

const { browserProfile } = require('./paths');

function browserCacheDirs() {
  const profile = browserProfile();
  return [
    path.join(profile, 'Default', 'Cache', 'Cache_Data'),
  ];
}

function parseRailPayload(raw) {
  try {
    const json = JSON.parse(raw);
    if (json.Id === LIVE_TV_RAIL_ID && Array.isArray(json.Tiles) && json.Tiles.length) {
      return json;
    }
  } catch { /* ignore */ }
  return null;
}

function readRailFromBrowserCache() {
  for (const dir of browserCacheDirs()) {
    if (!fs.existsSync(dir)) continue;
    let newest = null;
    for (const name of fs.readdirSync(dir)) {
      const filePath = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size < 500) continue;
      let raw;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      if (!raw.includes(LIVE_TV_RAIL_ID) || !raw.includes('"Tiles"')) continue;
      const json = parseRailPayload(raw);
      if (!json) continue;
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { json, mtimeMs: stat.mtimeMs, source: filePath };
      }
    }
    if (newest) return newest.json;
  }
  return null;
}

function readRailFromDataFile() {
  try {
    if (!fs.existsSync(DATA_PATH)) return null;
    const json = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (Array.isArray(json.Tiles) && json.Tiles.length) return json;
  } catch { /* ignore */ }
  return null;
}

function saveRailSnapshot(json) {
  const dir = path.dirname(DATA_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify({
    Id: json.Id || LIVE_TV_RAIL_ID,
    Title: json.Title || 'Live Channels',
    updated: new Date().toISOString(),
    Tiles: json.Tiles,
  }, null, 2), 'utf8');
}

function clearLiveTvRailCache() {
  try {
    if (fs.existsSync(DATA_PATH)) fs.unlinkSync(DATA_PATH);
  } catch { /* ignore */ }
}

function loadLiveTvRail() {
  const cached = readRailFromBrowserCache();
  if (cached) {
    saveRailSnapshot(cached);
    return cached;
  }
  return readRailFromDataFile();
}

function eventIdForAsset(assetId) {
  const rail = loadLiveTvRail();
  if (!rail?.Tiles) return null;
  const tile = rail.Tiles.find((t) => t.AssetId === assetId);
  return tile?.EventId || null;
}

module.exports = {
  LIVE_TV_RAIL_ID,
  loadLiveTvRail,
  saveRailSnapshot,
  readRailFromBrowserCache,
  clearLiveTvRailCache,
  eventIdForAsset,
};
