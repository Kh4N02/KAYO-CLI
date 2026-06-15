'use strict';

const { playReadyPrdPath, widevineWvdPath } = require('./cdm-device');

/** Matches hisense_smarttv_43a6101eu_sl3000.prd (PlayReady SL3000). */
const PROFILE_ID = 'hisense_smarttv_43a6101eu_sl3000';
const PLAYER_ID = '@dazn/peng-html5-core/vidaa/vidaa';
const APP_VERSION = '0.134.1-hotfix.f7e0d40f1';

function playbackDeviceParams() {
  return {
    AppVersion: APP_VERSION,
    DrmType: 'PLAYREADY',
    Format: 'MPEG-DASH',
    PlayerId: process.env.KAYO_PLAYER_ID || PLAYER_ID,
    Platform: 'vidaa',
    Model: '43A6101EU',
    Secure: 'true',
    Manufacturer: 'Hisense',
    PlayReadyInitiator: 'true',
    Capabilities: process.env.KAYO_CAPABILITIES || '4k,hdr,hevc,mta',
    MtaLanguageCode: '',
    LanguageCode: 'en',
  };
}

function playbackAdParams(useMT) {
  const playerId = process.env.KAYO_PLAYER_ID || PLAYER_ID;
  return {
    useMT,
    isLat: '0',
    deviceOs: 'vidaa',
    optout: '0',
    deviceBrand: 'HISENSE',
    idType: '',
    startPos: -1,
    deviceType: 'Tv',
    playerName: playerId,
    playerVersion: APP_VERSION,
    vpmute: '0',
    wta: useMT ? '1' : '0',
    requestPausedAdsUrl: !!useMT,
  };
}

function playReadyCdmBaseUrl() {
  // Remote getwvkeys hosts SL3000 devices by name; override with KAYO_PLAYREADY_CDM if you run your own CDM + .prd.
  const device = process.env.KAYO_PLAYREADY_CDM || 'getwvkeys';
  return `https://getwvkeys.cc/api/remotecdm/playready/${device}`;
}

module.exports = {
  PROFILE_ID,
  PLAYER_ID,
  APP_VERSION,
  playReadyPrdPath,
  widevineWvdPath,
  playReadyCdmBaseUrl,
  playbackDeviceParams,
  playbackAdParams,
};
