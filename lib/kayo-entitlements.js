'use strict';

function tokenPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  } catch {
    return {};
  }
}

function kayoTierInfo(token) {
  const pl = tokenPayload(token);
  const sets = pl.entitlements?.entitlementSets || [];
  const kayoSet = sets.find((s) => s.brand === 'KAYO') || sets[0];
  const tierId = kayoSet?.id || '';
  const isPremium = /premium/i.test(tierId);
  const isStandard = /standard/i.test(tierId);
  return {
    tierId,
    isPremium,
    isStandard,
    has4kEntitlement: isPremium,
    productStatus: pl.productStatus?.KAYO || null,
  };
}

module.exports = { tokenPayload, kayoTierInfo };
