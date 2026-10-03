'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths');
const { CMDS_DIR } = require('./cdm-device');

const BUNDLED = [
  {
    name: 'xiaomi_m2103k19pi_16.1.1_006_30cd6121_21111_l1.wvd',
    env: 'KAYO_WIDEVINE_WVD',
  },
  {
    name: 'hisense_smarttv_43a6101eu_sl3000.prd',
    env: 'KAYO_PLAYREADY_PRD',
  },
];

/** Copy repo-root device files into cmds/ when missing (local drop-in). */
function ensureCmdDevices() {
  if (process.env.KAYO_SKIP_ENSURE_DEVICES === '1') return [];
  fs.mkdirSync(CMDS_DIR, { recursive: true });
  const copied = [];
  for (const { name, env } of BUNDLED) {
    if (process.env[env]) continue;
    const dest = path.join(CMDS_DIR, name);
    if (fs.existsSync(dest)) continue;
    const src = path.join(ROOT, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, dest);
    copied.push(name);
  }
  return copied;
}

module.exports = { ensureCmdDevices };
