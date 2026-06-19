'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function cacheFilePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function defaultTtlHours() {
  const h = Number(process.env.KAYO_CACHE_HOURS);
  return Number.isFinite(h) && h > 0 ? h : 24;
}

function forceRefreshAll() {
  const v = String(process.env.KAYO_REFRESH_CACHE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function isFresh(entry, ttlHours = defaultTtlHours()) {
  if (!entry?.updated) return false;
  const ageMs = Date.now() - new Date(entry.updated).getTime();
  return ageMs >= 0 && ageMs < ttlHours * 3600 * 1000;
}

function formatCacheAge(iso) {
  if (!iso) return 'unknown age';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function loadCache(name) {
  try {
    const filePath = cacheFilePath(name);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveCache(name, payload) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(cacheFilePath(name), JSON.stringify({
    updated: new Date().toISOString(),
    ...payload,
  }, null, 2), 'utf8');
}

function clearCache(name) {
  try {
    fs.unlinkSync(cacheFilePath(name));
  } catch { /* ignore */ }
}

function clearDiscoveryCaches() {
  clearCache('uhd-events-cache');
  if (!fs.existsSync(DATA_DIR)) return;
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (name.startsWith('replay-pool-') && name.endsWith('.json')) {
      clearCache(name.replace(/\.json$/, ''));
    }
  }
}

module.exports = {
  loadCache,
  saveCache,
  clearCache,
  clearDiscoveryCaches,
  isFresh,
  forceRefreshAll,
  defaultTtlHours,
  formatCacheAge,
};
