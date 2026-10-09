'use strict';

const { playReadyPrdPath, widevineWvdPath } = require('./cdm-device');

/** Matches hisense_smarttv_hu32e5600fhwv_sl2000.prd (PlayReady SL2000 — Kayo 4K). */
const PROFILE_ID = 'hisense_smarttv_hu32e5600fhwv_sl2000';
const PLAYER_ID = '@dazn/peng-html5-core/vidaa/vidaa';
const WEB_PLAYER_ID = '@dazn/peng-html5-core/web/web';
const APP_VERSION = '0.134.1-hotfix.f7e0d40f1';

function playbackDeviceParams(profile = 'vidaa') {
  if (profile === 'web-playready-4k-cap') {
    return {
      AppVersion: APP_VERSION,
      DrmType: 'PLAYREADY',
      Format: 'MPEG-DASH',
      PlayerId: WEB_PLAYER_ID,
      Platform: 'web',
      Model: 'Chrome',
      Secure: 'true',
      Manufacturer: 'google',
      PlayReadyInitiator: 'false',
      Capabilities: process.env.KAYO_CAPABILITIES || '4k,dd,ddp,hdr,hevc,mta',
      MtaLanguageCode: '',
      LanguageCode: 'en',
    };
  }
  if (profile === 'webos') {
    return {
      AppVersion: APP_VERSION,
      DrmType: 'WIDEVINE',
      Format: 'MPEG-DASH',
      PlayerId: '@dazn/peng-html5-core/tv-next/tv',
      Platform: 'webos',
      Model: '43UR8050PSB',
      Secure: 'true',
      Manufacturer: 'lg',
      PlayReadyInitiator: 'false',
      Capabilities: process.env.KAYO_WEBOS_CAPABILITIES || '4k,dd,ddp,hdr,hevc,mta',
      MtaLanguageCode: '',
      LanguageCode: 'en',
    };
  }
  if (profile === 'web') {
    return {
      AppVersion: APP_VERSION,
      DrmType: 'WIDEVINE',
      Format: 'MPEG-DASH',
      PlayerId: process.env.KAYO_WEB_PLAYER_ID || WEB_PLAYER_ID,
      Platform: 'web',
      Model: 'Chrome',
      Secure: 'true',
      Manufacturer: 'google',
      PlayReadyInitiator: 'false',
      Capabilities: process.env.KAYO_WEB_CAPABILITIES || 'hdr,hevc,mta',
      MtaLanguageCode: '',
      LanguageCode: 'en',
    };
  }
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

function playbackAdParams(useMT, profile = 'vidaa') {
  if (profile === 'web-playready-4k-cap') {
    const playerId = WEB_PLAYER_ID;
    return {
      useMT,
      isLat: '0',
      deviceOs: 'web',
      optout: '0',
      deviceBrand: '',
      idType: '',
      startPos: -1,
      deviceType: 'Web',
      playerName: playerId,
      playerVersion: APP_VERSION,
      vpmute: '0',
      wta: useMT ? '1' : '0',
      requestPausedAdsUrl: !!useMT,
    };
  }
  if (profile === 'webos') {
    const playerId = '@dazn/peng-html5-core/tv-next/tv';
    return {
      useMT,
      isLat: '0',
      deviceOs: 'webos',
      optout: '0',
      deviceBrand: 'LG',
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
  if (profile === 'web') {
    const playerId = process.env.KAYO_WEB_PLAYER_ID || WEB_PLAYER_ID;
    return {
      useMT,
      isLat: '0',
      deviceOs: 'web',
      optout: '0',
      deviceBrand: '',
      idType: '',
      startPos: -1,
      deviceType: 'Web',
      playerName: playerId,
      playerVersion: APP_VERSION,
      vpmute: '0',
      wta: useMT ? '1' : '0',
      requestPausedAdsUrl: !!useMT,
    };
  }
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
