'use strict';

const path = require('path');

const { downloadProxyUrl } = require('./proxy-request');
const { resolvePython } = require('./python-resolve');
const { BRIDGE_PLACEHOLDER, useNm3u8dlDownloader } = require('./kayo-cdn-bridge');
const FS_LIVE_CDN = 'dck1-fs-live';
const FS_VOD_CDN = 'dck1-fs-vod';

const DOWNLOAD_HEADER_KEYS = ['user-agent', 'referer', 'origin', 'accept'];

/** Fixed Chrome 120 UA — live CDN tokens bind to this hash (matches Kayo Jinx / curl_cffi). */
const LIVE_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function appendCommonQueryParams(formatted, manifestUrl, playbackDetail) {
  const sessionId = manifestUrl.searchParams.get('aws.sessionId');
  if (sessionId) {
    formatted.searchParams.set('aws.sessionId', sessionId);
  }

  const tokenName = playbackDetail.CdnToken?.Name || 'dazn-token';
  formatted.searchParams.set(tokenName, playbackDetail.CdnToken.Value);

  const start = manifestUrl.searchParams.get('start');
  if (start) {
    formatted.searchParams.set('start', start);
  }

  const end = manifestUrl.searchParams.get('end');
  if (end) {
    formatted.searchParams.set('end', end);
  }
}

function formatNestedLiveMpdUrl(playbackDetail) {
  if (!playbackDetail?.ManifestUrl || !playbackDetail?.CdnToken?.Value) {
    return null;
  }

  let manifestUrl;
  try {
    manifestUrl = new URL(playbackDetail.ManifestUrl);
  } catch {
    return null;
  }

  const matches = [...manifestUrl.pathname.matchAll(/\/out\/v1\/([^/]+)\/([^/]+)\//g)];
  if (!matches.length) {
    return null;
  }

  // First /out/v1/{a}/{b}/ is the CDN auth path (not deeper segment dirs).
  const [, id1, id2] = matches[0];
  const formatted = new URL(`https://${manifestUrl.host}/out/v1/${id1}/${id2}/index.mpd`);
  appendCommonQueryParams(formatted, manifestUrl, playbackDetail);
  return formatted.toString();
}

function formatFsLiveMpdUrl(playbackDetail) {
  return formatNestedLiveMpdUrl(playbackDetail);
}

function formatFsVodMpdUrl(playbackDetail) {
  if (!playbackDetail?.ManifestUrl || !playbackDetail?.CdnToken?.Value) {
    return null;
  }

  let manifestUrl;
  try {
    manifestUrl = new URL(playbackDetail.ManifestUrl);
  } catch {
    return null;
  }

  const nestedMatch = manifestUrl.pathname.match(/\/out\/v1\/([^/]+)\/([^/]+)\//);
  if (nestedMatch) {
    const [, id1, id2] = nestedMatch;
    const formatted = new URL(`https://${manifestUrl.host}/out/v1/${id1}/${id2}/index.mpd`);
    appendCommonQueryParams(formatted, manifestUrl, playbackDetail);
    return formatted.toString();
  }

  const shortMatch = manifestUrl.pathname.match(/\/out\/v1\/([^/]+)\/index\.mpd/i);
  if (shortMatch) {
    const formatted = new URL(`${manifestUrl.origin}${manifestUrl.pathname}`);
    appendCommonQueryParams(formatted, manifestUrl, playbackDetail);
    return formatted.toString();
  }

  // fs-vod only: /v1/dash/{hash}/ → /out/v1/{hash}/index.mpd (not ac-vod SSAI).
  const sessionMatch = manifestUrl.pathname.match(/\/v1\/dash\/([^/]+)\//);
  if (sessionMatch && !isSsaiVodManifest(playbackDetail.ManifestUrl)) {
    const [, sessionHash] = sessionMatch;
    const formatted = new URL(`https://${manifestUrl.host}/out/v1/${sessionHash}/index.mpd`);
    appendCommonQueryParams(formatted, manifestUrl, playbackDetail);
    return formatted.toString();
  }

  return null;
}

function formatVodMpdUrl(playbackDetail) {
  const tokenUrl = formatVodMpdFromTokenPaths(playbackDetail);
  const nestedUrl = formatNestedLiveMpdUrl(playbackDetail);
  const ssai = isSsaiVodManifest(playbackDetail?.ManifestUrl);

  if (ssai || isAcCdn(playbackDetail?.CdnName) || isAkCdn(playbackDetail?.CdnName)) {
    return tokenUrl || nestedUrl;
  }

  return formatFsVodMpdUrl(playbackDetail) || nestedUrl || tokenUrl;
}

function formatMpdUrl(playbackDetail) {
  if (!playbackDetail?.CdnName) {
    return null;
  }

  if (isLiveCdn(playbackDetail.CdnName)) {
    return formatNestedLiveMpdUrl(playbackDetail);
  }

  if (isVodCdn(playbackDetail.CdnName)) {
    return formatVodMpdUrl(playbackDetail);
  }

  return null;
}

function parseCdnTokenJwtPaths(cdnToken) {
  const value = String(cdnToken?.Value || '').trim();
  if (!value.includes('.')) return null;
  try {
    const part = value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
    return Array.isArray(payload.paths) ? payload.paths : null;
  } catch {
    return null;
  }
}

/** ac-vod JWT tokens embed the allowed short path in paths[]. */
function formatVodMpdFromTokenPaths(playbackDetail) {
  const paths = parseCdnTokenJwtPaths(playbackDetail?.CdnToken);
  if (!paths?.length || !playbackDetail?.CdnToken?.Value) return null;

  let manifestUrl;
  try {
    manifestUrl = new URL(playbackDetail.ManifestUrl);
  } catch {
    return null;
  }

  const path = String(paths[0] || '').replace(/\/$/, '');
  if (!path.startsWith('/out/v1/')) return null;

  const formatted = new URL(`https://${manifestUrl.host}${path}/index.mpd`);
  appendCommonQueryParams(formatted, manifestUrl, playbackDetail);
  return formatted.toString();
}

function appendCdnTokenToManifestUrl(manifestUrl, cdnToken) {
  if (!manifestUrl || !cdnToken?.Value) {
    return null;
  }

  try {
    const url = new URL(manifestUrl);
    const tokenName = cdnToken.Name || 'dazn-token';
    url.searchParams.set(tokenName, cdnToken.Value);
    const sessionId = manifestUrl.match(/aws\.sessionId=([^&]+)/)?.[1];
    if (sessionId) {
      url.searchParams.set('aws.sessionId', sessionId);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function parseMpdMaxHeight(mpdXml) {
  const heights = [...String(mpdXml || '').matchAll(/height="(\d+)"/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0);
  if (!heights.length) return 0;
  return Math.max(...heights);
}

function parseMpdHasHevc(mpdXml) {
  return /hvc1|hev1|dvh1/i.test(String(mpdXml || ''));
}

function parseMpdSegmentInfo(mpdXml) {
  const xml = String(mpdXml || '');
  const periods = (xml.match(/<Period[\s>]/g) || []).length;
  const segmentTemplates = (xml.match(/<SegmentTemplate/g) || []).length;
  const segments = (xml.match(/<S[\s/>]/g) || []).length;
  return { periods, segmentTemplates, segments };
}

function isSsaiHeavyManifest(mpdXml, manifestUrl = '') {
  const { periods, segments } = parseMpdSegmentInfo(mpdXml);
  const url = String(manifestUrl || '');
  // Full SSAI session path = ad-stitched (often 1000s–7000s of segments).
  if (isSsaiVodManifest(url) || isSsaiLiveManifest(url)) {
    return segments > 600 || periods > 4;
  }
  // Clean short-path manifests: only flag extreme multi-period ad ladders.
  return segments > 2500 || periods > 15;
}

function formatAcMpdUrl(playbackDetail) {
  return formatNestedLiveMpdUrl(playbackDetail);
}

function isSsaiVodManifest(url) {
  return /dazn-strex-sports-vod-drm-session/i.test(String(url || ''));
}

function isSsaiLiveManifest(url) {
  return /dazn-strex-sports-live-drm-session/i.test(String(url || ''));
}

const MIN_CLIP_MS = 1000;
const MAX_CLIP_MS = 24 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseLocalDateString(dateValue) {
  const match = String(dateValue || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function todayLocalDayMonthString(date = new Date()) {
  return `${pad2(date.getDate())} ${pad2(date.getMonth() + 1)}`;
}

function formatDayMonthDisplayIso(iso) {
  if (!iso) return todayLocalDayMonthString();
  const parts = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return iso;
  return `${parts[3]} ${parts[2]}`;
}

function isoToLocalDayMonthString(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return todayLocalDayMonthString(d);
}

function inferYearForDayMonth(day, month, { yearHint, anchor = new Date() } = {}) {
  let year = yearHint || anchor.getFullYear();
  let candidate = new Date(year, month - 1, day);
  const sixMonthsMs = 183 * 24 * 60 * 60 * 1000;
  const diffMs = candidate.getTime() - anchor.getTime();
  if (diffMs > sixMonthsMs) year -= 1;
  if (diffMs < -sixMonthsMs) year += 1;
  candidate = new Date(year, month - 1, day);
  if (
    candidate.getFullYear() !== year
    || candidate.getMonth() !== month - 1
    || candidate.getDate() !== day
  ) {
    return null;
  }
  return year;
}

function parseDayMonthInput(raw, { yearHint, fieldLabel = 'Date', anchor = new Date() } = {}) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    return { ok: false, error: `${fieldLabel} is required.` };
  }

  const dm = trimmed.match(/^(\d{1,2})[\s\-\/](\d{1,2})$/);
  if (!dm) {
    return {
      ok: false,
      error: `${fieldLabel} use day then month — e.g. ${todayLocalDayMonthString()} (9 June). Spaces, - or / OK.`,
    };
  }

  const day = Number(dm[1]);
  const month = Number(dm[2]);
  if (month < 1 || month > 12) {
    return { ok: false, error: `${fieldLabel} month must be 01–12.` };
  }
  if (day < 1 || day > 31) {
    return { ok: false, error: `${fieldLabel} day must be 01–31.` };
  }

  const year = inferYearForDayMonth(day, month, { yearHint, anchor });
  if (!year) {
    return {
      ok: false,
      error: `${fieldLabel} "${trimmed}" is not a valid day/month (e.g. no 31-02).`,
    };
  }

  const iso = parseLocalDateString(`${year}-${pad2(month)}-${pad2(day)}`);
  if (!iso) {
    return {
      ok: false,
      error: `${fieldLabel} "${trimmed}" is not a valid day for that month (e.g. no 31-02).`,
    };
  }

  return {
    ok: true,
    value: iso,
    display: formatDayMonthDisplayIso(iso),
  };
}

function normalizeTimeInput(timeValue) {
  const parts = parseTimeParts(timeValue);
  if (!parts) {
    return null;
  }
  if (parts.second != null) {
    return `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
  }
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function localTimezoneLabel() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  } catch {
    return 'local time';
  }
}

function validateStrictDateInput(raw, { fieldLabel = 'Date', yearHint, anchor = new Date() } = {}) {
  const trimmed = String(raw ?? '').trim();
  const isoDirect = parseLocalDateString(trimmed);
  if (isoDirect) {
    return { ok: true, value: isoDirect, display: formatDayMonthDisplayIso(isoDirect) };
  }
  return parseDayMonthInput(trimmed, { yearHint, fieldLabel, anchor });
}

function validateStrictTimeInput(raw, { fieldLabel = 'Time' } = {}) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    return { ok: false, error: `${fieldLabel} is required.` };
  }
  if (/am|pm/i.test(trimmed)) {
    return {
      ok: false,
      error: `${fieldLabel} must be 24-hour time — no AM/PM (examples: 14:30, 14:30:00).`,
    };
  }

  const parts = parseTimeParts(trimmed);
  if (!parts) {
    return {
      ok: false,
      error: `${fieldLabel} must be HH:MM or HH:MM:SS (examples: 14:30, 9:05, 14:30:00).`,
    };
  }

  const normalized = parts.second != null
    ? `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`
    : `${pad2(parts.hour)}:${pad2(parts.minute)}`;

  return { ok: true, value: normalized };
}

function validateDurationInput(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Duration is required.' };
  }
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 1) {
      return { ok: false, error: 'Duration in seconds — at least 1 (e.g. 185 for 3m05s).' };
    }
    if (seconds > 24 * 3600) {
      return { ok: false, error: 'Duration max 86400 seconds (24 hours).' };
    }
    return { ok: true, value: seconds * 1000, label: `${seconds} sec` };
  }
  const hms = trimmed.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hms) {
    const hours = Number(hms[1]);
    const minutes = Number(hms[2]);
    const seconds = Number(hms[3]);
    if (minutes > 59 || seconds > 59) {
      return { ok: false, error: 'Duration HH:MM:SS — minutes and seconds must be 00–59.' };
    }
    const durationMs = ((hours * 3600) + (minutes * 60) + seconds) * 1000;
    if (durationMs < MIN_CLIP_MS) {
      return { ok: false, error: 'Duration must be at least 1 second (e.g. 00:00:01 or 185).' };
    }
    if (durationMs > MAX_CLIP_MS) {
      return { ok: false, error: 'Duration max 24:00:00.' };
    }
    return { ok: true, value: durationMs, label: trimmed };
  }
  return {
    ok: false,
    error: 'Duration: seconds number (e.g. 185) or HH:MM:SS (e.g. 00:03:05).',
  };
}

function buildLiveRangeFromStartAndDuration(startDateInput, startTime, durationMs, { yearHint, anchor = new Date() } = {}) {
  const startDateCheck = validateStrictDateInput(startDateInput, {
    fieldLabel: 'Start date',
    yearHint,
    anchor,
  });
  const startCheck = validateStrictTimeInput(startTime, { fieldLabel: 'Start time' });
  const errors = [];
  if (!startDateCheck.ok) errors.push(startDateCheck.error);
  if (!startCheck.ok) errors.push(startCheck.error);
  if (errors.length) {
    return { ok: false, errors, range: null, preview: null };
  }

  const startAt = buildLocalDate(startDateCheck.value, startCheck.value, 0);
  if (!startAt || Number.isNaN(startAt.getTime())) {
    return { ok: false, errors: ['Could not parse start date/time.'], range: null, preview: null };
  }

  const endAt = new Date(startAt.getTime() + durationMs);
  const endDate = `${endAt.getFullYear()}-${pad2(endAt.getMonth() + 1)}-${pad2(endAt.getDate())}`;
  const end = `${pad2(endAt.getHours())}:${pad2(endAt.getMinutes())}:${pad2(endAt.getSeconds())}`;

  const startAu = localInputToKayoAustralianParam(startDateCheck.value, startCheck.value, 0);
  const endAu = localInputToKayoAustralianParam(endDate, end, endAt.getSeconds());
  if (!startAu || !endAu) {
    return { ok: false, errors: ['Could not convert to Australian URL times.'], range: null, preview: null };
  }

  return {
    ok: true,
    errors: [],
    range: {
      startDate: startDateCheck.value,
      startDateDisplay: startDateCheck.display,
      start: startCheck.value,
      endDate,
      endDateDisplay: formatDayMonthDisplayIso(endDate),
      end,
    },
    preview: {
      startAu,
      endAu,
      durationSec: Math.max(1, Math.round(durationMs / 1000)),
    },
  };
}

function validateLiveRange(range, { yearHintStart, yearHintEnd, anchor = new Date() } = {}) {
  const errors = [];
  const startDateCheck = validateStrictDateInput(range?.startDate, {
    fieldLabel: 'Start date',
    yearHint: yearHintStart,
    anchor,
  });
  const endDateCheck = validateStrictDateInput(range?.endDate, {
    fieldLabel: 'End date',
    yearHint: yearHintStart ?? yearHintEnd,
    anchor,
  });
  const startCheck = validateStrictTimeInput(range?.start, { fieldLabel: 'Start time' });
  const endCheck = validateStrictTimeInput(range?.end, { fieldLabel: 'End time' });

  if (!startDateCheck.ok) errors.push(startDateCheck.error);
  if (!endDateCheck.ok) errors.push(endDateCheck.error);
  if (!startCheck.ok) errors.push(startCheck.error);
  if (!endCheck.ok) errors.push(endCheck.error);
  if (errors.length) {
    return { ok: false, errors, range: null, preview: null };
  }

  const startDate = startDateCheck.value;
  const endDate = endDateCheck.value;
  const start = startCheck.value;
  const end = endCheck.value;

  const startAt = buildLocalDate(startDate, start, 0);
  const endAt = buildLocalDate(endDate, end, 59);
  if (!startAt || !endAt || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    errors.push('Could not parse the date/time values.');
    return { ok: false, errors, range: null, preview: null };
  }

  if (endAt.getTime() <= startAt.getTime()) {
    errors.push('End must be after start (same-day example: start 14:30, end 18:45).');
    return { ok: false, errors, range: null, preview: null };
  }

  const durationMs = endAt.getTime() - startAt.getTime();
  if (durationMs < MIN_CLIP_MS) {
    errors.push('Clip must be at least 1 second long.');
    return { ok: false, errors, range: null, preview: null };
  }
  if (durationMs > MAX_CLIP_MS) {
    errors.push('Clip is longer than 24 hours — use a shorter range or split into multiple clips.');
    return { ok: false, errors, range: null, preview: null };
  }

  const startAu = localInputToKayoAustralianParam(startDate, start, 59);
  const endAu = localInputToKayoAustralianParam(endDate, end, 59);
  if (!startAu || !endAu) {
    errors.push('Could not convert local time to Australian URL parameters.');
    return { ok: false, errors, range: null, preview: null };
  }

  if (startAu >= endAu) {
    errors.push('Australian URL start/end order is invalid — check your local date and time.');
    return { ok: false, errors, range: null, preview: null };
  }

  return {
    ok: true,
    errors: [],
    range: {
      startDate,
      startDateDisplay: startDateCheck.display,
      start,
      endDate,
      endDateDisplay: endDateCheck.display,
      end,
    },
    preview: { startAu, endAu, durationSec: Math.max(1, Math.round(durationMs / 1000)) },
  };
}

/** Manifest URL for keys + N_m3u8DL: playback ManifestUrl + dazn-token (+ live start/end when set). */
function resolveManifestUrls(entry) {
  const rawManifestUrl = entry?.ManifestUrl || null;
  const live = isLiveCdn(entry?.CdnName);
  const commandUrl = appendCdnTokenToManifestUrl(rawManifestUrl, entry?.CdnToken);

  return {
    rawManifestUrl,
    commandUrl,
    displayUrl: commandUrl,
    isLiveStream: live,
  };
}

function normalizeHeaderName(name) {
  return String(name || '').trim().toLowerCase();
}

function normalizeHeaders(headers) {
  const normalized = {};
  if (!headers) {
    return normalized;
  }

  Object.entries(headers).forEach(([key, value]) => {
    normalized[normalizeHeaderName(key)] = String(value);
  });
  return normalized;
}

function pickManifestHeaders(headers) {
  const source = normalizeHeaders(headers);
  const picked = {};
  const keys = [
    'user-agent', 'referer', 'origin', 'accept', 'accept-language',
    'accept-encoding', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  ];
  keys.forEach((key) => {
    if (source[key]) picked[key] = source[key];
  });
  return picked;
}

const AU_TIMEZONE = 'Australia/Sydney';

function todayLocalDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseTimeParts(timeValue) {
  if (!timeValue) {
    return null;
  }

  const trimmed = String(timeValue).trim();
  const withSeconds = trimmed.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (withSeconds) {
    const hour = Number(withSeconds[1]);
    const minute = Number(withSeconds[2]);
    const second = Number(withSeconds[3]);
    if (hour > 23 || minute > 59 || second > 59) {
      return null;
    }
    return { hour, minute, second };
  }

  const noSeconds = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!noSeconds) {
    return null;
  }

  const hour = Number(noSeconds[1]);
  const minute = Number(noSeconds[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }

  return { hour, minute, second: null };
}

function buildLocalDate(dateValue, timeValue, fallbackSecond = 59) {
  const parts = parseTimeParts(timeValue);
  if (!parts || !dateValue) {
    return null;
  }

  const [year, month, day] = String(dateValue).split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }

  const second = parts.second != null ? parts.second : fallbackSecond;
  return new Date(year, month - 1, day, parts.hour, parts.minute, second, 0);
}

function getAustralianOffsetString(date) {
  const token = new Intl.DateTimeFormat('en-US', {
    timeZone: AU_TIMEZONE,
    timeZoneName: 'longOffset',
  }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value || 'GMT+10';

  const match = token.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) {
    return '+10:00';
  }

  const [, sign, hours, minutes = '00'] = match;
  return `${sign}${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
}

function localInputToKayoAustralianParam(dateValue, timeValue, fallbackSecond = 59) {
  const parts = parseTimeParts(timeValue);
  if (!parts) {
    return null;
  }
  const second = parts.second != null ? parts.second : fallbackSecond;
  const localDate = buildLocalDate(dateValue, timeValue, second);
  if (!localDate || Number.isNaN(localDate.getTime())) {
    return null;
  }

  const wallClock = new Intl.DateTimeFormat('sv-SE', {
    timeZone: AU_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(localDate);

  return `${wallClock.replace(' ', 'T')}${getAustralianOffsetString(localDate)}`;
}

function appendLiveTimeRangeToUrl(baseUrl, startDate, startTime, endDate, endTime) {
  if (!baseUrl || !startDate || !startTime || !endDate || !endTime) {
    return baseUrl;
  }

  if (!parseTimeParts(startTime) || !parseTimeParts(endTime)) {
    return baseUrl;
  }

  const startParam = localInputToKayoAustralianParam(startDate, startTime, 0);
  const endParam = localInputToKayoAustralianParam(endDate, endTime, 59);
  if (!startParam || !endParam) {
    return baseUrl;
  }

  try {
    const url = new URL(baseUrl);
    url.searchParams.set('start', startParam);
    url.searchParams.set('end', endParam);
    return url.toString();
  } catch {
    return baseUrl;
  }
}

function hasCompleteLiveRange(range) {
  return Boolean(range?.startDate && range?.start && range?.endDate && range?.end);
}

function isoToLocalDateString(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isoToLocalTimeString(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = pad2(d.getHours());
  const m = pad2(d.getMinutes());
  const s = d.getSeconds();
  if (s) return `${h}:${m}:${pad2(s)}`;
  return `${h}:${m}`;
}

function yearHintFromIso(iso) {
  if (!iso) return new Date().getFullYear();
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
}

function defaultDurationSeconds(item) {
  if (item?.start && item?.end) {
    const ms = new Date(item.end).getTime() - new Date(item.start).getTime();
    if (ms >= MIN_CLIP_MS && ms <= MAX_CLIP_MS) {
      return String(Math.max(1, Math.round(ms / 1000)));
    }
  }
  return '60';
}

function defaultLiveRangeFromItem(item) {
  const now = new Date();
  // Linear live-TV tiles often carry a programme Start far in the future/past — use today.
  const useItemSchedule = item?.start && !item?.isLinear;
  return {
    startDate: (useItemSchedule ? isoToLocalDayMonthString(item.start) : null)
      || todayLocalDayMonthString(now),
    startYearHint: useItemSchedule ? yearHintFromIso(item.start) : now.getFullYear(),
    start: useItemSchedule ? isoToLocalTimeString(item.start) : '',
    duration: defaultDurationSeconds(item),
  };
}

function applyLiveRangeToManifestUrls(urls, liveRange) {
  if (!urls || !hasCompleteLiveRange(liveRange)) {
    return urls;
  }

  const validated = validateLiveRange(liveRange, {
    yearHintStart: liveRange.startYearHint,
    yearHintEnd: liveRange.startYearHint,
  });
  if (!validated.ok) {
    return urls;
  }

  const { startDate, start, endDate, end } = validated.range;
  const commandUrl = appendLiveTimeRangeToUrl(urls.commandUrl, startDate, start, endDate, end);

  return {
    ...urls,
    commandUrl,
    displayUrl: commandUrl,
    liveRangePreview: validated.preview,
  };
}

/**
 * Kayo CDN segment/init fetches must NOT send Referer/Origin/UA — dazn-token JWT
 * binds ua/hash and returns 401 Unauthorized 684 when browser headers are present.
 * curl_cffi + N_m3u8DL work with impersonate/TLS only (no --header flags).
 */
function kayoCdnDownloadHeaders() {
  return {};
}

function defaultDownloadHeaders(_userAgent = null) {
  return kayoCdnDownloadHeaders();
}

function liveDownloadHeaders() {
  return kayoCdnDownloadHeaders();
}

function pickDownloadHeaders(headers) {
  const picked = pickManifestHeaders(headers);
  const downloadHeaders = {};
  DOWNLOAD_HEADER_KEYS.forEach((key) => {
    if (picked[key]) downloadHeaders[key] = picked[key];
  });
  return downloadHeaders;
}

function headersToCanonical(headers) {
  const canonical = {};
  Object.entries(headers).forEach(([key, value]) => {
    const titleKey = key.split('-').map((part) => {
      if (part.length <= 3 && part !== 'ua') {
        return part.toUpperCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    }).join('-');
    canonical[titleKey] = value;
  });
  return canonical;
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function sanitizeSaveName(title) {
  return String(title || '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function sanitizeFolderName(title) {
  return String(title || 'live')
    .replace(/[^\w\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120) || 'live';
}

/** Output folder + save name for live / catchup clip downloads. */
function buildLiveSavePaths(title, liveClip = false) {
  const clean = sanitizeFolderName(title);
  const folder = liveClip ? `${clean}_catchup` : `${clean}_live`;
  const root = process.env.KAYO_DOWNLOAD_DIR || path.join(__dirname, '..');
  const dir = path.join(root, folder);
  return {
    dir,
    saveName: `${liveClip ? 'Catchup' : 'Live'}_${clean}_trimmed`,
  };
}

function isLiveCdn(cdnName) {
  return cdnName === FS_LIVE_CDN || String(cdnName || '').endsWith('-live');
}

function isFsCdn(cdnName) {
  return cdnName === FS_LIVE_CDN || cdnName === FS_VOD_CDN;
}

function isAcCdn(cdnName) {
  return /dck1-ac-(live|vod)/i.test(String(cdnName || ''));
}

function isAkCdn(cdnName) {
  return /dck1-ak-(live|vod)/i.test(String(cdnName || ''));
}

function isVodCdn(cdnName) {
  return cdnName === FS_VOD_CDN || String(cdnName || '').endsWith('-vod');
}

/** ac-live/vod may carry UHD during live events; 4 keys ≈ multi-rep ladder. */
function isLikely4kStream(cdnName, keys, maxHeight = 0) {
  if (maxHeight >= 2160) return true;
  if ((keys?.length || 0) >= 4) return true;
  return false;
}

function cdnUpstreamFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function bridgeManifestArg(url) {
  if (!url || !String(url).startsWith('http')) return url;
  try {
    const u = new URL(url);
    return `${BRIDGE_PLACEHOLDER}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function bridgeBaseArg(baseUrl) {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    const p = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
    return `${BRIDGE_PLACEHOLDER}${p}`;
  } catch {
    return `${BRIDGE_PLACEHOLDER}/`;
  }
}

/** curl_cffi DASH downloader (fallback when KAYO_DOWNLOADER=python). */
function buildKayoDownloadCommand(url, keys, title, cdnName, {
  isLive = null,
  liveClip = false,
  baseUrl = null,
  manifestUrl = null,
} = {}) {
  if (!url) {
    return null;
  }

  const live = isLive != null ? isLive : isLiveCdn(cdnName);
  const livePaths = live ? buildLiveSavePaths(title, liveClip) : null;
  const saveDir = livePaths?.dir
    || path.join(process.env.KAYO_DOWNLOAD_DIR || path.join(__dirname, '..'), sanitizeSaveName(title) || 'download');
  const saveName = livePaths?.saveName || sanitizeSaveName(title) || 'output';
  const script = path.join(__dirname, 'kayo-download.py');
  const dlArgs = [script, 'download', url];
  if (baseUrl) {
    dlArgs.push('--base-url', baseUrl);
  }
  if (manifestUrl) {
    dlArgs.push('--manifest-url', manifestUrl);
  }
  for (const k of keys || []) {
    dlArgs.push('--key', `${k.kid}:${k.key}`);
  }
  dlArgs.push('--save-dir', saveDir, '--save-name', saveName, '--format', live ? 'mkv' : 'mp4');

  const py = resolvePython();
  return [py.command, ...py.prefix, ...dlArgs.map((arg) => quoteCmdArg(arg))].join(' ');
}

function normalizeDownloadBuild(result) {
  if (!result) return { cmd: null, cdnUpstreamBase: null, downloader: null };
  if (typeof result === 'string') {
    return { cmd: result, cdnUpstreamBase: null, downloader: null };
  }
  return {
    cmd: result.cmd || null,
    cdnUpstreamBase: result.cdnUpstreamBase || null,
    downloader: result.downloader || null,
  };
}

function buildNm3u8DlCommand(url, keys, title, cdnName, _headers = null, options = {}) {
  if (!url) return null;

  if (!useNm3u8dlDownloader()) {
    const pyCmd = buildKayoDownloadCommand(url, keys, title, cdnName, {
      isLive: options.isLive,
      liveClip: options.liveClip,
      baseUrl: options.baseUrl || null,
      manifestUrl: options.manifestUrl || (String(url).startsWith('http') ? url : null),
    });
    return { cmd: pyCmd, cdnUpstreamBase: null, downloader: 'python' };
  }

  const live = options.isLive != null ? options.isLive : isLiveCdn(cdnName);
  const livePaths = live ? buildLiveSavePaths(title, options.liveClip) : null;
  const upstream = options.cdnUpstreamBase
    || cdnUpstreamFromUrl(options.baseUrl)
    || cdnUpstreamFromUrl(options.manifestUrl)
    || cdnUpstreamFromUrl(url);

  const manifestArg = String(url).startsWith('http') ? bridgeManifestArg(url) : url;
  const parts = [process.env.KAYO_NM3U8DL || 'N_m3u8DL-RE', quoteCmdArg(manifestArg)];
  for (const k of keys || []) {
    parts.push('--key', `${k.kid}:${k.key}`);
  }

  if (live && livePaths) {
    parts.push('--save-name', quoteCmdArg(livePaths.saveName));
    parts.push('--save-dir', quoteCmdArg(livePaths.dir));
    parts.push('--tmp-dir', quoteCmdArg(livePaths.dir));
  } else {
    const saveName = sanitizeSaveName(title);
    if (saveName) parts.push('--save-name', quoteCmdArg(saveName));
  }

  parts.push('-mt', '--auto-select');
  if (options.skipAppendUrlParams && options.baseUrl) {
    parts.push('--base-url', quoteCmdArg(bridgeBaseArg(options.baseUrl)));
  } else if (!options.skipAppendUrlParams) {
    parts.push('--append-url-params');
  }

  if (live) {
    if (options.liveClip) {
      parts.push('--live-perform-as-vod');
    } else {
      parts.push('--use-shaka-packager', '--live-real-time-merge', '--del-after-done', 'false');
    }
    parts.push('-sv', 'res=1080:*', '-sa', 'lang=en:for=worst', '-ds', 'all');
    parts.push('-M', quoteCmdArg('format=mkv:muxer=mkvmerge'));
  } else if (options.isUhd) {
    const sv = options.maxHeight >= 2160 ? 'res=2160:*' : 'res=1080:*';
    parts.push('-sv', sv, '-sa', 'lang=en:for=worst', '-ds', 'all');
    parts.push('--mux-after-done', quoteCmdArg('format=mp4'));
  } else {
    parts.push('-sv', 'best', '-sa', 'lang=en:for=worst', '-ds', 'all');
    parts.push('--mux-after-done', quoteCmdArg('format=mp4'));
  }

  parts.push('--check-segments-count', 'false');
  parts.push('--use-system-proxy', 'false');
  parts.push('--disable-update-check');

  return {
    cmd: parts.join(' '),
    cdnUpstreamBase: upstream,
    downloader: 'nm3u8dl',
  };
}

module.exports = {
  FS_LIVE_CDN,
  FS_VOD_CDN,
  formatFsLiveMpdUrl,
  formatFsVodMpdUrl,
  formatMpdUrl,
  appendCdnTokenToManifestUrl,
  appendLiveTimeRangeToUrl,
  applyLiveRangeToManifestUrls,
  resolveManifestUrls,
  buildKayoDownloadCommand,
  buildNm3u8DlCommand,
  normalizeDownloadBuild,
  cdnUpstreamFromUrl,
  bridgeManifestArg,
  bridgeBaseArg,
  buildLiveSavePaths,
  sanitizeFolderName,
  isLiveCdn,
  isFsCdn,
  isAcCdn,
  isAkCdn,
  isVodCdn,
  parseMpdSegmentInfo,
  isLikely4kStream,
  parseMpdMaxHeight,
  parseMpdHasHevc,
  kayoCdnDownloadHeaders,
  defaultDownloadHeaders,
  liveDownloadHeaders,
  LIVE_CHROME_UA,
  todayLocalDateString,
  todayLocalDayMonthString,
  defaultLiveRangeFromItem,
  hasCompleteLiveRange,
  localInputToKayoAustralianParam,
  validateLiveRange,
  validateStrictDateInput,
  validateStrictTimeInput,
  validateDurationInput,
  buildLiveRangeFromStartAndDuration,
  parseLocalDateString,
  normalizeTimeInput,
  localTimezoneLabel,
};
