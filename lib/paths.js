'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');

function vendor(name) {
  return path.join(VENDOR, name);
}

function tokenFile() {
  return process.env.KAYO_TOKEN_FILE || path.join(ROOT, 'kayo-token.json');
}

function browserProfile() {
  return process.env.KAYO_BROWSER_PROFILE || path.join(ROOT, '.kayo-browser-profile');
}

module.exports = {
  ROOT,
  VENDOR,
  vendor,
  tokenFile,
  browserProfile,
};
