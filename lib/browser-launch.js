'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { browserProfile } = require('./paths');

const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'lockfile'];

function removeProfileLocks(profilePath) {
  for (const name of LOCK_FILES) {
    try {
      fs.unlinkSync(path.join(profilePath, name));
    } catch { /* ignore */ }
  }
}

function resetBrowserProfile(profilePath) {
  removeProfileLocks(profilePath);
  try {
    fs.rmSync(profilePath, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function fallbackProfilePath() {
  return path.join(os.tmpdir(), 'kayo-browser-profile');
}

function baseLaunchOptions({ headless, proxy }) {
  return {
    headless,
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    proxy: proxy || undefined,
    viewport: { width: 1280, height: 720 },
    args: [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
    ],
  };
}

async function launchEphemeral(options, { channel } = {}) {
  const browser = await chromium.launch({
    ...options,
    channel,
  });
  const ctx = await browser.newContext({
    locale: options.locale,
    timezoneId: options.timezoneId,
    viewport: options.viewport,
  });
  const closeContext = ctx.close.bind(ctx);
  ctx.close = async () => {
    await closeContext();
    await browser.close();
  };
  return ctx;
}

async function launchPersistent(profilePath, options, { channel } = {}) {
  try {
    return await chromium.launchPersistentContext(profilePath, {
      ...options,
      channel,
    });
  } catch (err) {
    if (channel === 'chrome') {
      return chromium.launchPersistentContext(profilePath, {
        ...options,
        channel: undefined,
      });
    }
    throw err;
  }
}

/**
 * Launch a Playwright context for Kayo WAF playback.
 * Retries with lock cleanup, profile reset, temp profile, ephemeral session.
 */
async function launchWafContext({ headless, proxy, onStatus } = {}) {
  const status = onStatus || (() => {});
  const primaryProfile = browserProfile();
  const profiles = [primaryProfile, fallbackProfilePath()];
  const options = baseLaunchOptions({ headless, proxy });
  const channels = ['chrome', undefined];

  for (let profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
    const profilePath = profiles[profileIndex];

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) {
        status(profileIndex === 0
          ? 'Browser profile locked — clearing locks...'
          : 'Primary profile unavailable — using temp profile...');
        removeProfileLocks(profilePath);
        if (profileIndex === 0) {
          resetBrowserProfile(profilePath);
        }
      }

      for (const channel of channels) {
        try {
          return await launchPersistent(profilePath, options, { channel });
        } catch (err) {
          if (attempt === 0) continue;
        }
      }
    }
  }

  status('Using temporary browser session...');
  for (const channel of channels) {
    try {
      return await launchEphemeral(options, { channel });
    } catch { /* try next channel */ }
  }

  throw new Error(
    'Could not start Chrome for Kayo playback — close Chrome windows opened for Kayo, '
    + 'delete .kayo-browser-profile if present, ensure VPN/tunnel is on, then retry',
  );
}

module.exports = {
  launchWafContext,
  resetBrowserProfile,
  removeProfileLocks,
  fallbackProfilePath,
};
