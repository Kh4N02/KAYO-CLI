'use strict';

const { withWafSession, fetchPlaybackInPage } = require('./waf-fetch');
const {
  createWidevineSession,
  createProfileSession,
  createCookieProfileSession,
  probeUhdProfiles,
  probeCdnManifest,
} = require('./curl-playback');
const {
  resolveManifestUrls,
  applyLiveRangeToManifestUrls,
  buildNm3u8DlCommand,
  normalizeDownloadBuild,
  defaultDownloadHeaders,
  liveDownloadHeaders,
  hasCompleteLiveRange,
  buildLiveSavePaths,
  parseMpdMaxHeight,
  parseMpdHasHevc,
  parseMpdSegmentInfo,
  isLikely4kStream,
  isLiveCdn,
  isVodCdn,
} = require('./mpd-formatter');
const path = require('path');
const { vendor, tokenFile } = require('./paths');
const { prepareLiveCatchupMpd } = require('./live-catchup-mpd');
const { localCdmAvailable, widevineWvdPath } = require('./cdm-device');
const cdmLocal = require('./cdm-local');
const play = require(vendor('play'));

/** Kayo CDN order — fs/ac only (verified download paths). */
const CDN_PRIORITY = [
  'dck1-fs-live',
  'dck1-ac-live',
  'dck1-fs-vod',
  'dck1-ac-vod',
];

/** fs-live first — Kayo Jinx default; ac-live often 401 on init segments. */
const LIVE_CDN_PROBE_ORDER = ['dck1-fs-live', 'dck1-ac-live'];

function vodCdnProbeOrder() {
  const pref = String(process.env.KAYO_VOD_CDN || '').trim().toLowerCase();
  if (pref === 'fs-vod' || pref === 'dck1-fs-vod') return ['dck1-fs-vod', 'dck1-ac-vod'];
  if (pref === 'ac-vod' || pref === 'dck1-ac-vod') return ['dck1-ac-vod', 'dck1-fs-vod'];
  return ['dck1-ac-vod', 'dck1-fs-vod'];
}

/** Default 4K path: webOS TV + Widevine + 4k capabilities (what worked on F1 UHD). */
const DEFAULT_UHD_PROFILE = 'webos-widevine';

/** Optional full sweep when KAYO_UHD_PROBE_ALL=1 */
const UHD_CURL_PROFILE_ORDER_ALL = [
  'webos-widevine',
  'web-playready-4k-cap',
  'webos-lg-4k',
  'tizen-samsung-4k',
  'androidtv-4k',
  'firetv-4k',
  'appletv-4k',
  'xbox-playready',
  'ps5-playready',
  'hisense-vidaa-sl3000',
  'chromecast-4k',
  'sony-androidtv-4k',
];

function uhdProfilesToTry() {
  const forced = String(process.env.KAYO_UHD_PROFILE || '').trim();
  if (forced) return [forced];
  if (process.env.KAYO_UHD_PROBE_ALL === '1') return UHD_CURL_PROFILE_ORDER_ALL;
  return [DEFAULT_UHD_PROFILE];
}

function listCdnEntries(playback) {
  const details = playback.PlaybackDetails || [];
  const out = [];
  const seen = new Set();
  for (const name of CDN_PRIORITY) {
    const entry = details.find((p) => p.CdnName === name);
    if (entry?.ManifestUrl && !seen.has(name)) {
      seen.add(name);
      out.push(entry);
    }
  }
  return out;
}

function pickCdnEntry(entries, logs, { live = false } = {}) {
  const order = live ? LIVE_CDN_PROBE_ORDER : vodCdnProbeOrder();
  for (const name of order) {
    const entry = entries.find((e) => e.CdnName === name);
    if (!entry?.CdnToken?.Value) continue;
    const { commandUrl } = resolveManifestUrls(entry);
    try {
      const probe = probeCdnManifest(commandUrl);
      if (probe.ok) {
        logs.push(`CDN probe: ${name} init OK`);
        return entry;
      }
      if (live && probe.mpd_status === 200) {
        logs.push(`CDN probe: ${name} MPD OK, init HTTP ${probe.init_status || '?'} — using anyway (live/catchup)`);
        return entry;
      }
      logs.push(`CDN probe: ${name} skipped — init HTTP ${probe.init_status || probe.mpd_status || '?'}`);
    } catch (e) {
      logs.push(`CDN probe: ${name} failed — ${e.message}`);
    }
  }
  return null;
}

function pickLiveCdnEntry(entries, logs) {
  return pickCdnEntry(entries, logs, { live: true });
}

function entriesForPlayback(entries, { liveChannel = false, liveEntry = null, uhdEntry = null } = {}) {
  if (uhdEntry) return [uhdEntry];
  if (!liveChannel) return entries;
  if (liveEntry) return [liveEntry];
  const picked = [];
  for (const name of LIVE_CDN_PROBE_ORDER) {
    const entry = entries.find((e) => e.CdnName === name);
    if (entry) picked.push(entry);
  }
  return picked.length ? picked : entries.filter((e) => isLiveCdn(e.CdnName)).slice(0, 1);
}

async function fetchMpdXml(manifestUrl, label, waf) {
  if (!manifestUrl) {
    throw new Error(`MPD manifest (${label}) — no URL`);
  }
  const isCdn = /dck1-(ac|fs|ak)-(live|vod)/i.test(manifestUrl);
  const mpdXml = isCdn && typeof waf.fetchLiveManifestText === 'function'
    ? await waf.fetchLiveManifestText(manifestUrl)
    : await waf.fetchManifestText(manifestUrl);
  return { mpdXml, fetchUrl: manifestUrl };
}

async function fetchPlayReadyLicenseB64(waf, licenseUrl, challengeB64, token, sessionId) {
  try {
    return await waf.fetchLicenseBinary(
      licenseUrl,
      challengeB64,
      token,
      sessionId,
      'text/xml; charset=UTF-8',
      { SOAPAction: '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"' },
    );
  } catch {
    return waf.fetchLicenseBinary(
      licenseUrl,
      challengeB64,
      token,
      sessionId,
      'application/octet-stream',
    );
  }
}

async function fetchWidevineLicenseB64(waf, licenseUrl, challengeB64, token, sessionId) {
  return waf.fetchLicenseBinary(
    licenseUrl,
    challengeB64,
    token,
    sessionId,
    'application/octet-stream',
  );
}

/** One license round per unique PSSH → merge keys by KID. */
async function extractKeysViaWaf(waf, mpdXml, entry, playback, token, sessionId, logs) {
  const licenseUrl = entry?.LaUrl || playback?.LaUrl
    || entry?.PlayReadyLaUrl || playback?.PlayReadyLaUrl;
  if (!licenseUrl) throw new Error('No license URL in playback response');

  const usePlayReady = play.isPlayReadyLicenseUrl(licenseUrl);
  const prPsshs = play.extractAllPlayReadyPsshFromMpd(mpdXml);
  const wvPsshs = play.extractAllWidevinePsshFromMpd(mpdXml);
  const maxHeight = parseMpdMaxHeight(mpdXml);
  // HD catchup already has a PlayReady PSSH. Widevine is only the fallback.
  const preferPlayReady = usePlayReady || maxHeight >= 2160 || prPsshs.length > 0;
  const playReadyLicenseUrl = usePlayReady
    ? licenseUrl
    : play.toPlayReadyLicenseUrl(licenseUrl);

  const keyBatches = [];
  const useLocal = localCdmAvailable();
  let drmUsed = null;

  async function collectPlayReady() {
    if (!prPsshs.length) return;
    logs.push(`PlayReady: ${prPsshs.length} unique PSSH(s) — ${useLocal ? 'local .prd' : 'remote CDM'}`);
    if (!usePlayReady && playReadyLicenseUrl !== licenseUrl) {
      logs.push('PlayReady license via Widevine LaUrl path swap');
    }
    for (let i = 0; i < prPsshs.length; i++) {
      const initData = prPsshs[i];
      try {
        let keys;
        if (useLocal) {
          const round = await cdmLocal.playReadyRound(initData);
          const licenseB64 = await fetchPlayReadyLicenseB64(
            waf, playReadyLicenseUrl, round.challengeB64, token, sessionId,
          );
          keys = await cdmLocal.playReadyKeys(round.session, licenseB64);
        } else {
          const session = await play.resolvePlayback({ step: 'challenge', drm: 'playready', initData });
          const licenseB64 = await fetchPlayReadyLicenseB64(
            waf, playReadyLicenseUrl, session.challengeB64, token, sessionId,
          );
          const result = await play.resolvePlayback({
            step: 'keys',
            drm: 'playready',
            sessionId: session.sessionId,
            licenseB64,
            localPrd: session.localPrd,
          });
          keys = result.keys;
        }
        if (keys?.length) {
          drmUsed = drmUsed || 'playready';
          logs.push(`  PSSH ${i + 1}/${prPsshs.length}: ${keys.length} key(s) — ${keys.map((k) => k.kid).join(', ')}`);
          keyBatches.push(keys);
        }
      } catch (e) {
        logs.push(`  PSSH ${i + 1}/${prPsshs.length}: failed — ${e.message}`);
      }
    }
  }

  async function collectWidevine() {
    if (!wvPsshs.length) return;
    const wvdName = widevineWvdPath();
    logs.push(`Widevine: ${wvPsshs.length} unique PSSH(s) — ${useLocal && wvdName ? path.basename(wvdName) : 'remote CDM'}`);
    for (let i = 0; i < wvPsshs.length; i++) {
      const pssh = wvPsshs[i];
      try {
        let keys;
        if (useLocal) {
          const round = await cdmLocal.widevineRound(pssh);
          const licenseB64 = await fetchWidevineLicenseB64(
            waf, licenseUrl, round.challengeB64, token, sessionId,
          );
          keys = await cdmLocal.widevineKeys(round.session, licenseB64);
        } else {
          const session = await play.resolvePlayback({ step: 'challenge', pssh });
          const licenseB64 = await fetchWidevineLicenseB64(
            waf, licenseUrl, session.challengeB64, token, sessionId,
          );
          const result = await play.resolvePlayback({
            step: 'keys',
            drm: 'widevine',
            sessionId: session.sessionId,
            licenseB64,
          });
          keys = result.keys;
        }
        if (keys?.length) {
          drmUsed = 'widevine';
          logs.push(`  PSSH ${i + 1}/${wvPsshs.length}: ${keys.length} key(s) — ${keys.map((k) => k.kid).join(', ')}`);
          keyBatches.push(keys);
        }
      } catch (e) {
        logs.push(`  PSSH ${i + 1}/${wvPsshs.length}: failed — ${e.message}`);
      }
    }
  }

  const drmFirst = String(process.env.KAYO_DRM_FIRST || '').toLowerCase();
  const webosWidevinePlayback = waf?.playbackProfileId === 'webos-widevine';
  const preferWidevineFirst = drmFirst === 'widevine'
    || (drmFirst !== 'playready' && webosWidevinePlayback);

  if (preferWidevineFirst) {
    await collectWidevine();
    if (!keyBatches.length) await collectPlayReady();
  } else if (drmFirst === 'playready') {
    await collectPlayReady();
    if (!keyBatches.length) await collectWidevine();
  } else if (preferPlayReady) {
    await collectPlayReady();
    if (!keyBatches.length) await collectWidevine();
  } else {
    await collectWidevine();
    if (!keyBatches.length) await collectPlayReady();
  }

  const keys = play.mergeKeysByKid(keyBatches);
  if (!keys.length) {
    throw new Error('No keys extracted (tried all PSSH boxes in MPD)');
  }

  logs.push(`Total: ${keys.length} unique key(s)`);
  const drm = drmUsed || (preferPlayReady ? 'playready' : 'widevine');
  return {
    keys,
    drm,
    playReadyUrl: drm === 'playready' ? playReadyLicenseUrl : null,
    laUrl: licenseUrl,
    pssh: (drm === 'playready' ? prPsshs[0] : wvPsshs[0]) || prPsshs[0] || wvPsshs[0] || null,
  };
}

function isPlaybackApi403(err) {
  return /Playback API HTTP 403|PlayReady playback API HTTP 403/i.test(String(err?.message || err));
}

function wafWithPlaybackProfile(waf, profile) {
  return {
    ...waf,
    fetchPlayback: (assetId, t, sid, opts = {}) =>
      fetchPlaybackInPage(waf.page, assetId, t, sid, { useMT: false, profile, ...opts }),
  };
}

function isRetriablePlaybackError(err) {
  const msg = String(err?.message || err || '');
  return isPlaybackApi403(err)
    || /unknown profile/i.test(msg)
    || /Browser playback network error|TLS|socket disconnected|route\.fetch/i.test(msg);
}

async function tryUhdCurlProfiles(run, token, { onStatus, logs, cookieHeader = null } = {}) {
  for (const profileId of uhdProfilesToTry()) {
    onStatus?.(`UHD: ${profileId}...`);
    const session = cookieHeader
      ? createCookieProfileSession(token, cookieHeader, profileId)
      : createProfileSession(token, profileId);
    try {
      return await run(session);
    } catch (e) {
      if (!isRetriablePlaybackError(e)) throw e;
      logs.push(`${profileId}: ${String(e.message || e).slice(0, 140)}`);
    }
  }
  return null;
}

async function runWidevineThenBrowserWaf(run, token, { onStatus, logs } = {}) {
  try {
    return await run(createWidevineSession(token));
  } catch (e) {
    if (!isPlaybackApi403(e)) throw e;
    logs.push('HD curl playback 403 — retrying with browser WAF session');
    onStatus?.('Playback API 403 — browser WAF retry...');
    return withWafSession((waf) => run(waf), { onStatus });
  }
}

async function resolveUhdPlayback(run, token, { onStatus, logs, probe } = {}) {
  if (probe?.best?.max_h >= 2160 && probe.best.profile) {
    onStatus?.(`UHD: ${probe.best.profile} → ${probe.best.cdn} (${probe.best.max_h}p)`);
    logs.push(`UHD probe winner: ${probe.best.profile} ${probe.best.max_h}p`);
    try {
      return await run(createProfileSession(token, probe.best.profile));
    } catch (e) {
      if (!isRetriablePlaybackError(e)) throw e;
      logs.push(`UHD probe profile failed: ${e.message}`);
    }
  }

  let result = await tryUhdCurlProfiles(run, token, { onStatus, logs });
  if (result) return result;

  const probeRow = probe?.results?.[0];
  const probeStatus = probeRow?.status;
  if (process.env.KAYO_UHD_BROWSER_WAF !== '1') {
    const detail = probeStatus ? `Playback API HTTP ${probeStatus}` : 'Playback API failed';
    throw new Error(
      `${detail} on webos-widevine with your current token — fix AU VPN/egress (not a login step). `
      + 'Set KAYO_UHD_BROWSER_WAF=1 only if you want Chrome WAF retry.',
    );
  }

  logs.push('UHD curl blocked — browser WAF + cookie-backed playback profiles (KAYO_UHD_BROWSER_WAF=1)');
  onStatus?.('UHD: browser WAF (AU VPN on)...');
  return withWafSession(async (waf) => {
    const cookies = await waf.getDownloadCookies();
    if (cookies) {
      result = await tryUhdCurlProfiles(run, token, { onStatus, logs, cookieHeader: cookies });
      if (result) return result;
    }

    const browserProfiles = process.env.KAYO_UHD_PROBE_ALL === '1'
      ? ['webos', 'web-playready-4k-cap', 'web', 'vidaa']
      : ['webos'];
    for (const profile of browserProfiles) {
      onStatus?.(`UHD browser: ${profile}...`);
      try {
        return await run(wafWithPlaybackProfile(waf, profile));
      } catch (e) {
        if (!isRetriablePlaybackError(e)) throw e;
        logs.push(`UHD browser ${profile}: ${String(e.message || e).slice(0, 140)}`);
      }
    }

    throw new Error(
      'UHD playback blocked (403) on webos-widevine — fix AU VPN/token, or set KAYO_UHD_PROBE_ALL=1 to try other TV profiles.',
    );
  }, { onStatus });
}

async function resolvePlaybackProxied({
  assetId, authToken, onStatus, onStream, liveRange = null, liveChannel = false,
  catchupReplay = false,
  waf: externalWaf = null, isUhd = false,
  /** UniDL / external CDM: manifest + license URL only (no local .prd/.wvd round-trips). */
  deferKeys = false,
}) {
  const token = play.normalizeToken(authToken);
  let sessionId;
  try {
    sessionId = JSON.parse(require('fs').readFileSync(tokenFile(), 'utf8')).sessionId;
  } catch { /* ignore */ }

  const logs = [];
  logs.push(`Playback for ${assetId}`);

  const run = async (waf) => {
    const browserUa = await waf.getBrowserUserAgent();
    const vodDownloadHeaders = defaultDownloadHeaders(browserUa);
    const liveClip = hasCompleteLiveRange(liveRange);

    const playback = await waf.fetchPlayback(assetId, token, sessionId, { useMT: false });
    logs.push('Playback API (useMT=false)');

    if (playback['odata.error']) {
      throw new Error(playback['odata.error'].message?.value || 'Playback API error');
    }

    const allEntries = listCdnEntries(playback);
    let liveEntry = null;
    let uhdEntry = null;
    if (liveChannel) {
      onStatus?.('Probing live CDN (init segment auth)...');
      liveEntry = pickLiveCdnEntry(allEntries, logs);
      if (!liveEntry) {
        throw new Error('No live CDN passed segment auth (tried ac-live and fs-live)');
      }
    } else if (isUhd) {
      onStatus?.('Probing VOD CDN (init segment auth)...');
      uhdEntry = pickCdnEntry(allEntries, logs, { live: false });
      if (!uhdEntry) {
        throw new Error('No VOD CDN passed segment auth (tried ac-vod and fs-vod)');
      }
    }
    let entries = entriesForPlayback(allEntries, { liveChannel, liveEntry, uhdEntry });
    if (catchupReplay && !liveChannel) {
      const vodFirst = [...entries].sort((a, b) => {
        const av = isVodCdn(a.CdnName) ? 0 : 1;
        const bv = isVodCdn(b.CdnName) ? 0 : 1;
        return av - bv;
      });
      entries = vodFirst;
    }
    if (!entries.length) throw new Error('No CDN manifest in playback response');

    const preferVodForReplay = catchupReplay
      && entries.some((e) => isVodCdn(e.CdnName));

    const title = playback.Asset?.Title || playback.Title || assetId;
    const streams = [];
    const failedStreams = [];

    async function resolveEntry(entry, index, total) {
      const label = entry.CdnName || `cdn-${index + 1}`;
      onStatus?.(`Stream ${index + 1}/${total}: ${label}...`);
      const cdnToken = entry.CdnToken?.Value;
      if (!cdnToken) {
        throw new Error('no CDN token');
      }

      const baseUrls = resolveManifestUrls(entry);
      const clipUrls = liveClip
        ? applyLiveRangeToManifestUrls(baseUrls, liveRange)
        : baseUrls;
      const manifestUrlForKeys = baseUrls.commandUrl;
      const manifestUrl = liveClip ? baseUrls.commandUrl : clipUrls.commandUrl;
      const liveStream = isLiveCdn(label);
      const livePerformAsVod = catchupReplay && liveStream && !liveClip;
      const uhdStream = isUhd && !liveChannel;
      const streamHeaders = (liveStream || uhdStream) ? liveDownloadHeaders() : vodDownloadHeaders;
      const { mpdXml } = await fetchMpdXml(manifestUrlForKeys, label, waf);
      const segInfo = parseMpdSegmentInfo(mpdXml);
      logs.push(`${label}: MPD ok (${segInfo.segments || '?'} segments, ${segInfo.periods || '?'} periods)`);

      const maxHeight = parseMpdMaxHeight(mpdXml);
      const hasHevc = parseMpdHasHevc(mpdXml);
      const maxQuality = maxHeight >= 2160 ? '2160p' : (maxHeight >= 1080 ? '1080p' : (maxHeight ? `${maxHeight}p` : 'unknown'));

      let keyResult;
      if (deferKeys) {
        const laUrl = entry?.LaUrl || playback?.LaUrl
          || entry?.PlayReadyLaUrl || playback?.PlayReadyLaUrl;
        if (!laUrl) throw new Error('No license URL in playback response');
        const prPsshs = play.extractAllPlayReadyPsshFromMpd(mpdXml);
        const maxHeight = parseMpdMaxHeight(mpdXml);
        const usePlayReady = play.isPlayReadyLicenseUrl(laUrl)
          || prPsshs.length > 0
          || maxHeight >= 2160;
        const playReadyLicenseUrl = usePlayReady ? laUrl : play.toPlayReadyLicenseUrl(laUrl);
        keyResult = {
          keys: [],
          drm: usePlayReady ? 'playready' : 'widevine',
          playReadyUrl: playReadyLicenseUrl,
          laUrl,
        };
        logs.push(`${label}: deferKeys — manifest only (license via UniDL CDM)`);
      } else {
        keyResult = await extractKeysViaWaf(waf, mpdXml, entry, playback, token, sessionId, logs);
      }
      const licenseUrl = keyResult.playReadyUrl || keyResult.laUrl;

      return {
        cdnName: label,
        manifestUrl,
        mpdXml,
        segmentCount: segInfo.segments,
        periodCount: segInfo.periods,
        recommended: true,
        licenseUrl,
        laUrl: keyResult.laUrl,
        playReadyUrl: keyResult.playReadyUrl,
        drm: keyResult.drm,
        keys: keyResult.keys,
        maxHeight,
        hasHevc,
        maxQuality,
        uhdAvailable: isLikely4kStream(label, keyResult.keys, maxHeight),
        isLiveCdn: liveStream,
        catchupReplay: livePerformAsVod,
        isUhd: uhdStream,
        liveClip,
        liveRangePreview: clipUrls.liveRangePreview || null,
        saveDir: liveStream ? buildLiveSavePaths(title, liveClip).dir : null,
        ...(liveClip ? {} : (() => {
          const built = normalizeDownloadBuild(buildNm3u8DlCommand(
            manifestUrl,
            keyResult.keys,
            title,
            label,
            streamHeaders,
            {
              isLive: liveStream,
              liveClip,
              livePerformAsVod,
              isUhd: uhdStream,
              maxHeight,
            },
          ));
          return {
            cmd: built.cmd,
            cdnUpstreamBase: built.cdnUpstreamBase,
            downloader: built.downloader,
          };
        })()),
      };
    }

    if (liveChannel || isUhd) {
      let lastErr;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const label = entry.CdnName || `cdn-${i + 1}`;
        try {
          const stream = await resolveEntry(entry, i, entries.length);
          streams.push(stream);
          logs.push(`${label}: ${stream.keys?.length || 0} key(s)`);
          break;
        } catch (e) {
          lastErr = e;
          logs.push(`${label}: ${e.message}`);
          onStatus?.(`${label} failed — ${entries[i + 1] ? 'trying next CDN...' : e.message}`);
        }
      }
      if (!streams.length) {
        throw new Error(lastErr?.message || (liveChannel ? 'No live CDN could be resolved' : 'No VOD CDN could be resolved'));
      }
    } else {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const label = entry.CdnName || `cdn-${i + 1}`;
        try {
          const stream = await resolveEntry(entry, i, entries.length);
          if (preferVodForReplay) {
            stream.recommended = label === 'dck1-fs-vod';
          } else if (catchupReplay && isLiveCdn(label)) {
            stream.recommended = label === 'dck1-fs-live';
          } else {
            stream.recommended = isLiveCdn(label) ? label === 'dck1-fs-live' : label === 'dck1-fs-vod';
          }
          streams.push(stream);
          logs.push(`${label}: ${stream.keys?.length || 0} key(s)`);
        } catch (e) {
          logs.push(`${label}: ${e.message}`);
          onStatus?.(`${label} failed: ${e.message}`);
          failedStreams.push({
            index: i + 1,
            total: entries.length,
            stream: {
              cdnName: label,
              manifestUrl: '',
              licenseUrl: '',
              keys: [],
              cmd: null,
              error: e.message,
            },
            title,
            failed: true,
          });
        }
      }
    }

    if (!streams.length && !failedStreams.length) {
      throw new Error('No streams could be resolved from playback');
    }

    const hasLive = streams.some((s) => s.isLiveCdn && s.keys?.length);
    const hasUhd = isUhd && streams.some((s) => s.isUhd && s.keys?.length);
    if (hasLive || hasUhd) {
      onStatus?.('Refreshing CDN tokens before download...');
      try {
        const freshPlayback = await waf.fetchPlayback(assetId, token, sessionId, { useMT: false });
        const freshEntries = listCdnEntries(freshPlayback);
        logs.push(hasLive ? 'Live: token refresh before N_m3u8DL command' : 'UHD: token refresh before N_m3u8DL command');
        for (const stream of streams) {
          if (!stream.keys?.length) continue;
          const entry = freshEntries.find((e) => e.CdnName === stream.cdnName);
          if (!entry?.CdnToken?.Value) continue;
          const baseUrls = resolveManifestUrls(entry);

          if (stream.liveClip && liveRange) {
            onStatus?.('Building local clip manifest (token injection)...');
            const clipUrls = applyLiveRangeToManifestUrls(baseUrls, liveRange);
            const saveDir = stream.saveDir || buildLiveSavePaths(title, true).dir;
            const fetchClipMpd = typeof waf.fetchClipManifestText === 'function'
              ? (url) => waf.fetchClipManifestText(url, token)
              : null;
            if (!fetchClipMpd) {
              throw new Error('Clip MPD fetch not available');
            }
            const local = await prepareLiveCatchupMpd({
              baseManifestUrl: baseUrls.commandUrl,
              clipManifestUrl: clipUrls.commandUrl,
              saveDir,
              fetchClipMpd,
            });
            stream.manifestUrl = local.localPath;
            stream.tokenRefreshed = true;
            Object.assign(stream, normalizeDownloadBuild(buildNm3u8DlCommand(
              local.localPath,
              stream.keys,
              title,
              stream.cdnName,
              null,
              {
                isLive: true,
                liveClip: true,
                baseUrl: local.baseUrl,
                manifestUrl: baseUrls.commandUrl,
                skipAppendUrlParams: true,
              },
            )));
            logs.push(`${stream.cdnName}: local clip MPD → ${local.localPath}`);
          } else if (stream.isLiveCdn) {
            stream.manifestUrl = baseUrls.commandUrl;
            stream.tokenRefreshed = true;
            Object.assign(stream, normalizeDownloadBuild(buildNm3u8DlCommand(
              baseUrls.commandUrl,
              stream.keys,
              title,
              stream.cdnName,
              liveDownloadHeaders(),
              {
                isLive: true,
                liveClip: false,
                livePerformAsVod: Boolean(stream.catchupReplay),
              },
            )));
          } else if (stream.isUhd) {
            stream.manifestUrl = baseUrls.commandUrl;
            stream.tokenRefreshed = true;
            Object.assign(stream, normalizeDownloadBuild(buildNm3u8DlCommand(
              baseUrls.commandUrl,
              stream.keys,
              title,
              stream.cdnName,
              liveDownloadHeaders(),
              { isLive: false, isUhd: true, maxHeight: stream.maxHeight },
            )));
            logs.push(`${stream.cdnName}: UHD download command rebuilt with fresh token`);
          }
        }
      } catch (e) {
        logs.push(`${hasLive ? 'Live' : 'UHD'} token refresh: ${e.message}`);
        onStatus?.(`Download prep failed: ${e.message}`);
      }
    }

    for (const failed of failedStreams) {
      await onStream?.(failed);
    }
    for (let i = 0; i < streams.length; i++) {
      await onStream?.({
        index: i + 1,
        total: entries.length,
        stream: streams[i],
        title,
        failed: false,
      });
    }

    if (!streams.length) throw new Error('No streams could be resolved from playback');

    const downloadStream = (liveChannel || isUhd) && streams[0]?.cmd ? streams[0] : null;
    return { title, streams, logs, downloadStream };
  };

  if (externalWaf) return run(externalWaf);

  if (isUhd) {
    if (process.env.KAYO_SWITCH_HOUSEHOLD_PROFILE === '1') {
      try {
        const { switchToBestPlaybackProfile } = require('./household-profiles');
        const switched = switchToBestPlaybackProfile(assetId, onStatus);
        if (switched) token = play.normalizeToken(switched);
      } catch (err) {
        logs.push(`Household profile switch skipped: ${err.message}`);
      }
    }

    const uhdProfiles = uhdProfilesToTry();
    const uhdLabel = uhdProfiles[0] === DEFAULT_UHD_PROFILE && uhdProfiles.length === 1
      ? 'webOS TV + Widevine + 4K cap (webos-widevine)'
      : uhdProfiles.join(', ');
    onStatus?.(`UHD: ${uhdLabel}...`);
    logs.push(`UHD profile(s): ${uhdProfiles.join(', ')}`);

    let probe;
    try {
      probe = probeUhdProfiles(assetId, token, sessionId);
      const row = probe?.results?.[0];
      if (row?.status === 200) {
        logs.push(`UHD probe: ${row.profile} → ${row.max_h || 0}p ${row.cdn || ''}`.trim());
      } else if (row) {
        logs.push(`UHD probe: ${row.profile || 'webos-widevine'} HTTP ${row.status || '?'} (VPN/WAF/token if not 200)`);
      }
    } catch (err) {
      logs.push(`UHD probe skipped: ${err.message}`);
    }

    return resolveUhdPlayback(run, token, { onStatus, logs, probe });
  }

  onStatus?.('HD: Widevine playback...');
  return runWidevineThenBrowserWaf(run, token, { onStatus, logs });
}

module.exports = { resolvePlaybackProxied, listCdnEntries, buildNm3u8DlCommand };
