#!/usr/bin/env node
'use strict';
/** Show Kayo subscription tier from kayo-token.json — 4K needs Premium. */
require('../lib/kayo-api').loadEnv();
const fs = require('fs');
const { tokenFile } = require('../lib/paths');
const { kayoTierInfo } = require('../lib/kayo-entitlements');

const sess = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
const tier = kayoTierInfo(sess.token);

console.log('KAYO product status:', tier.productStatus || '?');
console.log('Entitlement tier:   ', tier.tierId || '(unknown)');
console.log('4K / PlayReady ladder:', tier.has4kEntitlement ? 'YES (Premium)' : 'NO — Standard is HD only');
console.log('');
if (!tier.has4kEntitlement) {
  console.log('Your token is Standard tier. Kayo blocks PlayReady 4K playback (HTTP 403) for non-Premium accounts.');
  console.log('Friends on Premium + a TV auth script can reach the 2160p manifest; keys/CDM are not the blocker.');
  process.exit(1);
}
