'use strict';

const fs = require('fs');
const path = require('path');

const SUPPLEMENT_PATH = path.join(__dirname, '..', 'data', 'cricket-uhd-supplement.json');

function isT20CricketCompetition(competition) {
  return /t20|twenty20/i.test(String(competition || ''));
}

function loadCricketUhdSupplement() {
  try {
    if (!fs.existsSync(SUPPLEMENT_PATH)) return [];
    const rows = JSON.parse(fs.readFileSync(SUPPLEMENT_PATH, 'utf8'));
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row) => row?.assetId && isT20CricketCompetition(row.competition))
      .map((row) => ({
        assetId: row.assetId,
        eventId: row.eventId || null,
        title: row.title || '',
        sport: row.sport || 'Cricket',
        sportId: row.sportId || null,
        competition: row.competition || '',
        label: row.label || '',
        rawType: row.type || 'CatchUp',
        displayType: row.displayType || '',
        type: row.type || 'CatchUp',
        status: row.status || 'Catchup',
        isLinear: false,
        start: row.start || null,
        end: row.end || null,
        quality: 'UHD',
        channel: 'Cricket',
        logoImageId: null,
      }));
  } catch {
    return [];
  }
}

function verifiedUhdAssetIds() {
  return new Set(loadCricketUhdSupplement().map((row) => row.assetId));
}

function applyVerifiedUhd(item) {
  if (verifiedUhdAssetIds().has(item?.assetId)) return { ...item, quality: 'UHD' };
  return item;
}

module.exports = {
  loadCricketUhdSupplement,
  verifiedUhdAssetIds,
  applyVerifiedUhd,
  isT20CricketCompetition,
};
