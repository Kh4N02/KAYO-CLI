'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'kayo-profile-playback-test.py');

/**
 * Re-auth via Python (curl_cffi), try each Kayo household profile, save best token.
 * @returns {Promise<string|null>} switched token or null
 */
function switchToBestPlaybackProfile(assetId, onStatus) {
  const status = onStatus || (() => {});
  status('Kayo: trying household profiles (4K entitlement)...');
  const result = spawnSync('python', [SCRIPT, assetId || '47lg4yrp7l7j1p9432wz832v3'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 300000,
  });
  const out = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status === 0 && /Token saved/.test(out)) {
    try {
      const token = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'kayo-token.json'), 'utf8')).token;
      status('Kayo: saved token for best household profile');
      return token;
    } catch {
      return null;
    }
  }
  status(`Kayo profile probe: ${out.split('\n').filter(Boolean).slice(-3).join(' · ') || 'failed'}`);
  return null;
}

module.exports = { switchToBestPlaybackProfile };
