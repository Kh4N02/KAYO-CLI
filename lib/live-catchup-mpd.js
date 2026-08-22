'use strict';

const fs = require('fs');
const path = require('path');

function extractBaseUrl(mpdUrl) {
  const u = new URL(mpdUrl);
  let p = u.pathname;
  if (/\/(index\.mpd|manifest\.mpd)$/i.test(p)) {
    p = p.slice(0, p.lastIndexOf('/') + 1);
  }
  return `${u.protocol}//${u.host}${p}`;
}

function extractCdnTokenFromUrl(url) {
  const match = String(url || '').match(/[?&]dazn-token=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Inject dazn-token into DASH segment template URLs (Fastly/fs-live requires this). */
function injectCdnTokenIntoMpd(mpdText, tokenValue) {
  if (!tokenValue) return mpdText;
  const injectAttr = (attr, val) => {
    if (/dazn-token=/i.test(val)) {
      return `${attr}="${val}"`;
    }
    const sep = val.includes('?') ? '&amp;' : '?';
    return `${attr}="${val}${sep}dazn-token=${tokenValue}"`;
  };
  return String(mpdText || '')
    .replace(/initialization="([^"]+)"/g, (m, val) => injectAttr('initialization', val))
    .replace(/media="([^"]+)"/g, (m, val) => injectAttr('media', val));
}

/** Drop SCTE-35 ad periods when present (same idea as Kayo Jinx). */
function removeAdPeriodsFromMpd(mpdText) {
  const text = String(mpdText || '');
  if (!/SpliceInfoSection/i.test(text)) {
    return null;
  }

  const periodRe = /<Period[\s\S]*?<\/Period>/gi;
  const periods = text.match(periodRe) || [];
  const kept = periods.filter((p) => !/SpliceInfoSection/i.test(p));
  if (kept.length === periods.length) {
    return null;
  }

  let body = text;
  for (const period of periods) {
    if (/SpliceInfoSection/i.test(period)) {
      body = body.replace(period, '');
    }
  }

  const parseDur = (durStr) => {
    const m = String(durStr || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
    if (!m) return 0;
    return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  };

  let cursor = 0;
  kept.forEach((periodXml) => {
    const durMatch = periodXml.match(/\bduration="([^"]+)"/);
    const next = periodXml.replace(
      /\bstart="[^"]*"/,
      `start="PT${cursor.toFixed(3)}S"`,
    );
    body = body.replace(periodXml, next);
    if (durMatch) cursor += parseDur(durMatch[1]);
  });

  if (cursor > 0) {
    body = body.replace(
      /mediaPresentationDuration="[^"]*"/,
      `mediaPresentationDuration="PT${cursor.toFixed(3)}S"`,
    );
  }

  return body;
}

/**
 * Build local manifest.mpd for live catchup clip (Jinx mode 1).
 * @returns {{ localPath: string, baseUrl: string } | null}
 */
async function prepareLiveCatchupMpd({
  baseManifestUrl,
  clipManifestUrl,
  saveDir,
  fetchClipMpd,
}) {
  const tokenValue = extractCdnTokenFromUrl(baseManifestUrl);
  if (!tokenValue) {
    throw new Error('No dazn-token in manifest URL');
  }

  let mpdText = await fetchClipMpd(clipManifestUrl);
  mpdText = injectCdnTokenIntoMpd(mpdText, tokenValue);
  const trimmed = removeAdPeriodsFromMpd(mpdText);
  if (trimmed) {
    mpdText = trimmed;
  }

  fs.mkdirSync(saveDir, { recursive: true });
  const localPath = path.join(saveDir, 'manifest.mpd');
  fs.writeFileSync(localPath, mpdText, 'utf8');

  return {
    localPath,
    baseUrl: extractBaseUrl(baseManifestUrl),
  };
}

module.exports = {
  extractBaseUrl,
  extractCdnTokenFromUrl,
  injectCdnTokenIntoMpd,
  removeAdPeriodsFromMpd,
  prepareLiveCatchupMpd,
};
