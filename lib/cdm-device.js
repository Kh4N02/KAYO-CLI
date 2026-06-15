'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths');

const CMDS_DIR = path.join(ROOT, 'cmds');

const WIDEVINE_UUID = Buffer.from([
  0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce,
  0xa3, 0xc8, 0x27, 0xdc, 0xd5, 0x1d, 0x21, 0xed,
]);

const PLAYREADY_UUID = Buffer.from([
  0x9a, 0x04, 0xf0, 0x79, 0x98, 0x40, 0x42, 0x86,
  0xab, 0x92, 0xe6, 0x5b, 0xe0, 0x88, 0x5f, 0x95,
]);

function firstFileInDir(dir, ext) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(ext))
      .map((f) => path.join(dir, f));
    return files[0] || null;
  } catch {
    return null;
  }
}

function resolveDeviceFile(envVar, defaultName, ext) {
  const custom = process.env[envVar];
  if (custom) {
    const p = path.isAbsolute(custom) ? custom : path.join(ROOT, custom);
    if (fs.existsSync(p)) return p;
  }
  const exact = path.join(CMDS_DIR, defaultName);
  if (fs.existsSync(exact)) return exact;
  return firstFileInDir(CMDS_DIR, ext);
}

function playReadyPrdPath() {
  return resolveDeviceFile(
    'KAYO_PLAYREADY_PRD',
    'hisense_smarttv_43a6101eu_sl3000.prd',
    '.prd',
  );
}

function widevineWvdPath() {
  return resolveDeviceFile(
    'KAYO_WIDEVINE_WVD',
    'motorola_moto_g_v5.0.0-android_d9eff17f_4445_l3.wvd',
    '.wvd',
  );
}

function localCdmAvailable() {
  if (process.env.KAYO_LOCAL_CDM === '0') return false;
  try {
    return !!(playReadyPrdPath() && widevineWvdPath());
  } catch {
    return false;
  }
}

module.exports = {
  CMDS_DIR,
  WIDEVINE_UUID,
  PLAYREADY_UUID,
  playReadyPrdPath,
  widevineWvdPath,
  localCdmAvailable,
};
