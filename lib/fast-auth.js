'use strict';

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');

const { vendor } = require('./paths');
const { parseCustomProxy } = require(vendor('proxy-parse'));
const {
  authTokenFromRefreshResponse,
  buildRefreshHeaders,
  resolveRefreshDeviceId,
} = require(vendor('auth'));

const SIGNIN_URL = 'https://authentication-prod.ar.indazn.com/v5/SignIn';
const REFRESH_URL = 'https://ott-authz-bff-prod.ar.indazn.com/v5/RefreshAccessToken';
const SIGNIN_UA = 'Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
const DEFAULT_TIMEOUT_MS = 15000;

function buildDeviceId(override) {
  const o = String(override || '').trim();
  if (!o) return `${crypto.randomUUID()}|kayo`;
  if (o.includes('|')) return o;
  if (/^[0-9a-f-]{36}$/i.test(o)) return `${o}|kayo`;
  return `${crypto.randomUUID()}-${o}|kayo`;
}

function postJson(url, headers, body, proxySpec, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const proxyUrl = parseCustomProxy(proxySpec);
  if (!proxyUrl) return Promise.reject(new Error('Invalid KAYO_PROXY'));
  const agent = new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs });
  const u = new URL(url);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new Error(`Auth request timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs + 500);

    const req = https.request(u, { method: 'POST', headers, agent, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const snippet = data.slice(0, 200).replace(/\s+/g, ' ');
          reject(new Error(`HTTP ${res.statusCode}: ${snippet}`));
          return;
        }
        let json = {};
        try {
          json = JSON.parse(data || '{}');
        } catch {
          reject(new Error('Auth response was not JSON'));
          return;
        }
        const headerAuth = res.headers.authorization || res.headers.Authorization;
        if (headerAuth && !authTokenFromRefreshResponse(json)) {
          json = { ...json, _headerToken: String(headerAuth).replace(/^Bearer\s+/i, '') };
        }
        resolve(json);
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('timeout', () => req.destroy(new Error('Auth timeout')));
    req.write(body);
    req.end();
  });
}

async function fastSignIn({ email, password, proxySpec, deviceId }) {
  const dev = buildDeviceId(deviceId);
  const body = JSON.stringify({
    Email: String(email || '').trim(),
    Password: String(password || ''),
    DeviceId: dev,
    Platform: 'web',
    ProfilingSessionId: crypto.randomUUID(),
  });
  const headers = {
    'User-Agent': SIGNIN_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'Content-Type': 'application/json',
    Origin: 'https://kayosports.com.au',
    Referer: 'https://kayosports.com.au/',
    'x-brand': 'kayo',
  };

  const json = await postJson(SIGNIN_URL, headers, body, proxySpec);
  const token = authTokenFromRefreshResponse(json);
  if (!token) {
    const result = json.Result || json.result || 'unknown';
    throw new Error(`SignIn had no token (Result: ${result})`);
  }
  return { token, deviceId: dev };
}

async function fastRefresh(token, proxySpec, sessionId, deviceIdOverride) {
  const deviceId = resolveRefreshDeviceId(token, deviceIdOverride);
  if (!deviceId) throw new Error('Token missing deviceId');

  const body = JSON.stringify({ DeviceId: deviceId });
  const sid = sessionId || crypto.randomUUID();
  const headers = buildRefreshHeaders(token, sid);
  const json = await postJson(REFRESH_URL, headers, body, proxySpec);
  const next = authTokenFromRefreshResponse(json) || json._headerToken;
  if (!next) throw new Error('Refresh response had no token');
  return next;
}

module.exports = { fastSignIn, fastRefresh, DEFAULT_TIMEOUT_MS };
