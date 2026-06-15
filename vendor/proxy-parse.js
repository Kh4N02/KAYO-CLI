'use strict';

/** host:port:user:pass (preferred) or http://user:pass@host:port → proxy URL for HttpsProxyAgent */
function parseCustomProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!u.hostname || !u.port) return null;
      if (!u.username || !u.password) return null;
      return s;
    } catch {
      return null;
    }
  }

  const parts = s.split(':');
  if (parts.length < 2) return null;

  const host = parts[0];
  const port = parts[1];
  if (!host || !port) return null;

  if (parts.length === 3) return null;

  if (parts.length >= 4) {
    const user = parts[2];
    const pass = parts.slice(3).join(':');
    if (!user || !pass) return null;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  return `http://${host}:${port}`;
}

/** Warn when .env uses Webshare datacenter (6887 / bare IP) instead of residential backbone. */
function validateKayoProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Set KAYO_PROXY in proxy/.env';
  const host = s.split(':')[0] || '';
  const port = s.split(':')[1] || '';
  if (port === '6887' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return 'Datacenter proxy (IP:6887) times out and gets DAZN 403. Use only: p.webshare.io:80:YOUR_USER-AU-rotate:YOUR_PASS';
  }
  if (host === 'p.webshare.io' && port === '80' && !/-AU-rotate/i.test(s)) {
    return 'Webshare AU: username must end with -AU-rotate (e.g. udiwafqs-AU-rotate)';
  }
  return null;
}

function proxyFormatHint(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Set KAYO_PROXY=host:port:user:pass in proxy/.env';
  if (/^https?:\/\//i.test(s)) {
    return 'KAYO_PROXY: use host:port:user:pass (not a masked http:// URL with ***)';
  }
  const n = s.split(':').length;
  if (n === 3) {
    return 'KAYO_PROXY is missing the password — use host:port:user:pass (four parts, e.g. p.webshare.io:80:udiwafqs-AU-rotate:YOUR_PASS)';
  }
  return 'KAYO_PROXY format: host:port:user:pass';
}

module.exports = { parseCustomProxy, proxyFormatHint, validateKayoProxy };
