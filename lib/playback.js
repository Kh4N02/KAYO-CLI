'use strict';

const { withWafSession } = require('./waf-fetch');
const {
  resolveManifestUrls,
  applyLiveRangeToManifestUrls,
  buildNm3u8DlCommand,
  defaultDownloadHeaders,
  parseMpdMaxHeight,
  parseMpdHasHevc,
  parseMpdSegmentInfo,
  isLikely4kStream,
  isLiveCdn,
} = require('./mpd-formatter');
const { resolveDownloadProxyUrl } = require('./proxy-request');
const { vendor, tokenFile } = require('./paths');
const { localCdmAvailable } = require('./cdm-device');
const cdmLocal = require('./cdm-local');
const play = require(vendor('play'));

/** Kayo CDN order — fs/ac only (verified download paths). */
const CDN_PRIORITY = [
  'dck1-fs-live',
  'dck1-ac-live',
  'dck1-fs-vod',
  'dck1-ac-vod',
];

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

async function fetchMpdXml(manifestUrl, label, waf) {
  if (!manifestUrl) {
    throw new Error(`MPD manifest (${label}) — no URL`);
  }
  const mpdXml = await waf.fetchManifestText(manifestUrl);
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
  const preferPlayReady = usePlayReady || maxHeight >= 2160 || prPsshs.length > 0;

  const keyBatches = [];
  const useLocal = localCdmAvailable();

  if (preferPlayReady && prPsshs.length) {
    logs.push(`PlayReady: ${prPsshs.length} unique PSSH(s) — ${useLocal ? 'local .prd' : 'remote CDM'}`);
    for (let i = 0; i < prPsshs.length; i++) {
      const initData = prPsshs[i];
      try {
        let keys;
        if (useLocal) {
          const round = await cdmLocal.playReadyRound(initData);
          const licenseB64 = await fetchPlayReadyLicenseB64(
            waf, licenseUrl, round.challengeB64, token, sessionId,
          );
          keys = await cdmLocal.playReadyKeys(round.session, licenseB64);
        } else {
          const session = await play.resolvePlayback({ step: 'challenge', drm: 'playready', initData });
          const licenseB64 = await fetchPlayReadyLicenseB64(
            waf, licenseUrl, session.challengeB64, token, sessionId,
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
          logs.push(`  PSSH ${i + 1}/${prPsshs.length}: ${keys.length} key(s) — ${keys.map((k) => k.kid).join(', ')}`);
          keyBatches.push(keys);
        }
      } catch (e) {
        logs.push(`  PSSH ${i + 1}/${prPsshs.length}: failed — ${e.message}`);
      }
    }
  }

  if (!keyBatches.length && wvPsshs.length) {
    logs.push(`Widevine: ${wvPsshs.length} unique PSSH(s) — ${useLocal ? 'local .wvd' : 'remote CDM'}`);
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
          logs.push(`  PSSH ${i + 1}/${wvPsshs.length}: ${keys.length} key(s) — ${keys.map((k) => k.kid).join(', ')}`);
          keyBatches.push(keys);
        }
      } catch (e) {
        logs.push(`  PSSH ${i + 1}/${wvPsshs.length}: failed — ${e.message}`);
      }
    }
  }

  const keys = play.mergeKeysByKid(keyBatches);
  if (!keys.length) {
    throw new Error('No keys extracted (tried all PSSH boxes in MPD)');
  }

  logs.push(`Total: ${keys.length} unique key(s)`);
  const drm = preferPlayReady && prPsshs.length ? 'playready' : 'widevine';
  return {
    keys,
    drm,
    playReadyUrl: usePlayReady ? licenseUrl : null,
    laUrl: licenseUrl,
    pssh: prPsshs[0] || wvPsshs[0] || null,
  };
}

async function resolvePlaybackProxied({ assetId, authToken, onStatus, onStream, liveRange = null, waf: externalWaf = null }) {
  const token = play.normalizeToken(authToken);
  let sessionId;
  try {
    sessionId = JSON.parse(require('fs').readFileSync(tokenFile(), 'utf8')).sessionId;
  } catch { /* ignore */ }

  const logs = [];
  logs.push(`Playback for ${assetId}`);

  const run = async (waf) => {
    const browserUa = await waf.getBrowserUserAgent();
    const downloadHeaders = defaultDownloadHeaders(browserUa);

    const playback = await waf.fetchPlayback(assetId, token, sessionId, { useMT: false });
    logs.push('Playback API (useMT=false)');

    if (playback['odata.error']) {
      throw new Error(playback['odata.error'].message?.value || 'Playback API error');
    }

    const entries = listCdnEntries(playback);
    if (!entries.length) throw new Error('No CDN manifest in playback response');

    const title = playback.Asset?.Title || playback.Title || assetId;
    const streams = [];
    const nm3u8Proxy = await resolveDownloadProxyUrl();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const label = entry.CdnName || `cdn-${i + 1}`;
      onStatus?.(`Stream ${i + 1}/${entries.length}: ${label}...`);
      try {
        const cdnToken = entry.CdnToken?.Value;
        if (!cdnToken) {
          logs.push(`${label}: no CDN token`);
          continue;
        }

        const urls = applyLiveRangeToManifestUrls(resolveManifestUrls(entry), liveRange);
        const manifestUrl = urls.commandUrl;
        const { mpdXml } = await fetchMpdXml(manifestUrl, label, waf);
        const segInfo = parseMpdSegmentInfo(mpdXml);
        logs.push(`${label}: MPD ok (${segInfo.segments || '?'} segments, ${segInfo.periods || '?'} periods)`);

        const maxHeight = parseMpdMaxHeight(mpdXml);
        const hasHevc = parseMpdHasHevc(mpdXml);
        const maxQuality = maxHeight >= 2160 ? '2160p' : (maxHeight >= 1080 ? '1080p' : (maxHeight ? `${maxHeight}p` : 'unknown'));

        const keyResult = await extractKeysViaWaf(waf, mpdXml, entry, playback, token, sessionId, logs);
        const licenseUrl = keyResult.playReadyUrl || keyResult.laUrl;
        const liveStream = isLiveCdn(label);

        const stream = {
          cdnName: label,
          manifestUrl,
          segmentCount: segInfo.segments,
          periodCount: segInfo.periods,
          recommended: liveStream ? label === 'dck1-fs-live' : label === 'dck1-fs-vod',
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
          liveRangePreview: urls.liveRangePreview || null,
          cmd: buildNm3u8DlCommand(
            manifestUrl,
            keyResult.keys,
            title,
            label,
            downloadHeaders,
            { isLive: liveStream, proxyUrl: nm3u8Proxy },
          ),
        };
        streams.push(stream);
        logs.push(`${label}: ${keyResult.keys?.length || 0} key(s)`);
        await onStream?.({
          index: streams.length,
          total: entries.length,
          stream,
          title,
          failed: false,
        });
      } catch (e) {
        logs.push(`${label}: ${e.message}`);
        onStatus?.(`${label} failed: ${e.message}`);
        await onStream?.({
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

    if (!streams.length) throw new Error('No streams could be resolved from playback');
    return { title, streams, logs };
  };

  if (externalWaf) return run(externalWaf);
  return withWafSession(run, { onStatus });
}

module.exports = { resolvePlaybackProxied, listCdnEntries, buildNm3u8DlCommand };
