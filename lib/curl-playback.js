'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'curl-playback.py');

function runPython(args) {
  const attempts = [
    ['python', args],
    ['python3', args],
    ['py', ['-3', ...args]],
  ];
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(http|https|all)_proxy$/i.test(key) || /^proxy$/i.test(key)) {
      delete env[key];
    }
  }
  let lastErr;
  for (const [bin, argv] of attempts) {
    const result = spawnSync(bin, argv, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      cwd: path.join(__dirname, '..'),
      env,
    });
    if (result.error?.code === 'ENOENT') {
      lastErr = result.error;
      continue;
    }
    const stdout = String(result.stdout || '').trim();
    const stderr = String(result.stderr || '').trim();
    if (result.status !== 0) {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      const msg = parsed?.error || stderr || stdout || `curl-playback exited ${result.status}`;
      throw new Error(msg);
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(stderr || stdout || 'Invalid curl-playback response');
    }
  }
  throw lastErr || new Error('Python not found — install Python 3 + curl_cffi for HD playback');
}

function fetchPlaybackWidevine(assetId, token, sessionId) {
  const args = ['playback', assetId, String(token).replace(/^Bearer\s+/i, '')];
  if (sessionId) args.push(sessionId);
  return runPython([SCRIPT, ...args]);
}

function probeUhdProfiles(assetId, token, sessionId) {
  const args = ['probe-uhd', assetId, String(token).replace(/^Bearer\s+/i, '')];
  if (sessionId) args.push(sessionId);
  return runPython([SCRIPT, ...args]);
}

function fetchPlaybackProfile(assetId, token, sessionId, profileId) {
  const args = ['playback-profile', assetId, String(token).replace(/^Bearer\s+/i, ''), profileId];
  if (sessionId) args.push(sessionId);
  return runPython([SCRIPT, ...args]);
}

function fetchText(url, token) {
  const data = runPython([SCRIPT, 'get', url, String(token).replace(/^Bearer\s+/i, '')]);
  return data.text;
}

function fetchBinaryPost(url, token, bodyB64, contentType) {
  const data = runPython([
    SCRIPT,
    'post',
    url,
    String(token).replace(/^Bearer\s+/i, ''),
    bodyB64,
    contentType,
  ]);
  return data.b64;
}

function fetchLiveManifestText(url) {
  const data = runPython([SCRIPT, 'get-mpd', url]);
  return data.text;
}

function fetchClipManifestText(url, token) {
  try {
    return fetchLiveManifestText(url);
  } catch {
    const data = runPython([SCRIPT, 'get-mpd-auth', url, String(token).replace(/^Bearer\s+/i, '')]);
    return data.text;
  }
}

function probeCdnManifest(manifestUrl) {
  return runPython([SCRIPT, 'probe-live-cdn', manifestUrl]);
}

/** @deprecated use probeCdnManifest */
const probeLiveCdn = probeCdnManifest;

function fetchPlaybackPlayReadyJinx(assetId, token, deviceUuid) {
  const args = ['playback-playready-jinx', assetId, String(token).replace(/^Bearer\s+/i, ''), deviceUuid];
  return runPython([SCRIPT, ...args]);
}

function cdnManifestFetch(url, authToken) {
  if (/dck1-(ac|fs|ak)-(live|vod)/i.test(String(url || ''))) {
    return fetchLiveManifestText(url);
  }
  return fetchText(url, authToken);
}

function createWidevineSession(token) {
  const authToken = String(token).replace(/^Bearer\s+/i, '');
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  return {
    fetchPlayback: (assetId, t, sessionId, opts) => {
      void opts;
      return fetchPlaybackWidevine(assetId, t || authToken, sessionId);
    },
    fetchManifestText: (url) => cdnManifestFetch(url, authToken),
    fetchLiveManifestText: (url) => fetchLiveManifestText(url),
    fetchClipManifestText: (url, t) => fetchClipManifestText(url, t || authToken),
    fetchLicenseBinary: (url, challengeB64, t, sessionId, contentType) => {
      void sessionId;
      return fetchBinaryPost(url, t || authToken, challengeB64, contentType);
    },
    getBrowserUserAgent: async () => ua,
    getDownloadCookies: async () => '',
  };
}

function createProfileSession(token, profileId) {
  const authToken = String(token).replace(/^Bearer\s+/i, '');
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  return {
    fetchPlayback: (assetId, t, sessionId, opts) => {
      void opts;
      return fetchPlaybackProfile(assetId, t || authToken, sessionId, profileId);
    },
    fetchManifestText: (url) => cdnManifestFetch(url, authToken),
    fetchLiveManifestText: (url) => fetchLiveManifestText(url),
    fetchClipManifestText: (url, t) => fetchClipManifestText(url, t || authToken),
    fetchLicenseBinary: (url, challengeB64, t, sessionId, contentType) => {
      void sessionId;
      return fetchBinaryPost(url, t || authToken, challengeB64, contentType);
    },
    getBrowserUserAgent: async () => ua,
    getDownloadCookies: async () => '',
  };
}

module.exports = {
  createWidevineSession,
  createProfileSession,
  fetchPlaybackWidevine,
  probeUhdProfiles,
  fetchLiveManifestText,
  probeCdnManifest,
  probeLiveCdn,
  fetchPlaybackPlayReadyJinx,
};
