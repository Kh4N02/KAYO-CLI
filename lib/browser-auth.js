'use strict';

const { chromium } = require('playwright');
const { vendor, browserProfile } = require('./paths');
const { parseCustomProxy } = require(vendor('proxy-parse'));
const { authTokenFromRefreshResponse, normalizeToken } = require(vendor('auth'));

const DEFAULT_PROFILE = browserProfile();

function parseProxyForPlaywright(proxySpec) {
  const url = parseCustomProxy(proxySpec);
  if (!url) return null;
  const u = new URL(url);
  return {
    server: `${u.protocol}//${u.hostname}:${u.port}`,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

function tokenFromAuthResponse(json) {
  const fromBox = authTokenFromRefreshResponse(json);
  if (fromBox) return normalizeToken(fromBox);
  return null;
}

async function dismissDialogs(page) {
  for (const sel of [
    '[data-test-id="ERROR_DIALOG_BUTTON"]',
    'button:has-text("AGREE")',
    'button:has-text("OK")',
  ]) {
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      try { await btn.click({ timeout: 2000 }); } catch { /* ignore */ }
    }
  }
}

async function signInViaBrowser({ email, password, proxySpec, onStatus, headless }) {
  const status = onStatus || (() => {});
  const proxy = parseProxyForPlaywright(proxySpec);
  if (!proxy) throw new Error('Invalid KAYO_PROXY for browser sign-in');

  let capturedToken = null;
  const useHeadless = headless != null
    ? headless
    : process.env.KAYO_BROWSER_HEADLESS === '1';

  const ctx = await chromium.launchPersistentContext(DEFAULT_PROFILE, {
    headless: useHeadless,
    channel: 'chrome',
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    proxy,
    viewport: { width: 1280, height: 720 },
  });

  try {
    const page = ctx.pages()[0] || await ctx.newPage();

    page.on('response', async (r) => {
      const url = r.url();
      if (!/SignIn|RefreshAccessToken/i.test(url) || !url.includes('indazn.com')) return;
      if (r.status() !== 200) return;
      try {
        const json = await r.json();
        const token = tokenFromAuthResponse(json);
        if (token) capturedToken = token;
      } catch { /* ignore */ }
    });

    status('Opening Kayo (browser login through proxy)...');
    await page.goto('https://kayosports.com.au/', { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(3000);
    await dismissDialogs(page);

    status('Entering email & password...');
    await page.locator('#email').waitFor({ timeout: 30000 });
    await page.locator('#email').fill(email);
    await dismissDialogs(page);
    await page.locator('[data-test-id="refined-button-signin"]').click({ timeout: 20000 });
    await page.waitForTimeout(4000);
    await dismissDialogs(page);

    const bodyText = await page.locator('body').innerText();
    if (/No key found|97-000/i.test(bodyText)) {
      throw new Error('Kayo auth could not load encryption keys through this proxy (error 97-000--1)');
    }

    const pass = page.locator('input[type="password"]');
    await pass.first().waitFor({ timeout: 25000 });
    await pass.first().fill(password);
    await dismissDialogs(page);
    await page.locator('[data-test-id="refined-button-signin"], button:has-text("Sign in")').first().click({ timeout: 20000 });

    status('Waiting for Kayo token...');
    const deadline = Date.now() + 90000;
    while (!capturedToken && Date.now() < deadline) {
      await page.waitForTimeout(1000);
      if (/kayosports\.com\.au\/(en-AU\/)?(home|watch|browse|sport)/i.test(page.url())) break;
    }

    if (!capturedToken) {
      await page.goto('https://kayosports.com.au/', { waitUntil: 'load', timeout: 90000 });
      const waitMore = Date.now() + 20000;
      while (!capturedToken && Date.now() < waitMore) await page.waitForTimeout(1000);
    }

    if (!capturedToken) {
      throw new Error('Browser login finished but Kayo did not return a token');
    }
    return capturedToken;
  } finally {
    await ctx.close();
  }
}

module.exports = { signInViaBrowser };
