'use strict';

const APP_VERSION = '0.134.1-hotfix.f7e0d40f1';

/** 4K TV device profiles — Kayo help article + legacy probes. */
const CAPS_4K = '4k,dd,ddp,hdr,hevc,mta';

const UHD_PLAYREADY_PROFILES = [
  {
    id: 'androidtv-4k',
    DrmType: 'PLAYREADY',
    Platform: 'androidtv',
    PlayerId: '@dazn/peng-html5-core/androidtv/androidtv',
    Model: 'SHIELD Android TV',
    Manufacturer: 'NVIDIA',
    PlayReadyInitiator: 'false',
    Capabilities: CAPS_4K,
  },
  {
    id: 'appletv-4k',
    DrmType: 'PLAYREADY',
    Platform: 'appletv',
    PlayerId: '@dazn/peng-html5-core/appletv/appletv',
    Model: 'Apple TV 4K',
    Manufacturer: 'Apple',
    PlayReadyInitiator: 'false',
    Capabilities: CAPS_4K,
  },
  {
    id: 'chromecast-4k',
    DrmType: 'PLAYREADY',
    Platform: 'chromecast',
    PlayerId: '@dazn/peng-html5-core/chromecast/chromecast',
    Model: 'Chromecast with Google TV 4K',
    Manufacturer: 'Google',
    PlayReadyInitiator: 'false',
    Capabilities: CAPS_4K,
  },
  {
    id: 'hisense-vidaa-sl3000',
    DrmType: 'PLAYREADY',
    Platform: 'vidaa',
    PlayerId: '@dazn/peng-html5-core/vidaa/vidaa',
    Model: '43A6101EU',
    Manufacturer: 'Hisense',
    PlayReadyInitiator: 'true',
    Capabilities: '4k,hdr,hevc,mta',
  },
  {
    id: 'webos-lg-4k',
    DrmType: 'PLAYREADY',
    Platform: 'webos',
    PlayerId: '@dazn/peng-html5-core/tv-next/tv',
    Model: '43UR8050PSB',
    Manufacturer: 'lg',
    PlayReadyInitiator: 'false',
    Capabilities: CAPS_4K,
  },
  {
    id: 'ps5-playready',
    DrmType: 'PLAYREADY',
    Platform: 'ps5',
    PlayerId: '@dazn/peng-html5-core/ps5/ps5',
    Model: 'PlayStation 5',
    Manufacturer: 'Sony',
    PlayReadyInitiator: 'false',
    Capabilities: CAPS_4K,
  },
  {
    id: 'tizen-samsung-4k',
    DrmType: 'PLAYREADY',
    Platform: 'tizen',
    PlayerId: '@dazn/peng-html5-core/tizen/tizen',
    Model: 'QN55Q80AAU',
    Manufacturer: 'samsung',
    PlayReadyInitiator: 'false',
    Capabilities: CAPS_4K,
  },
  {
    id: 'sony-androidtv-4k',
    DrmType: 'PLAYREADY',
    Platform: 'androidtv',
    PlayerId: '@dazn/peng-html5-core/androidtv/androidtv',
    Model: 'BRAVIA 4K GB',
    Manufacturer: 'Sony',
    PlayReadyInitiator: 'false',
    Capabilities: CAPS_4K,
  },
  {
    id: 'firetv-4k',
    DrmType: 'PLAYREADY',
    Platform: 'firetv',
    PlayerId: '@dazn/peng-html5-core/firetv/firetv',
    Model: 'AFTKA',
    Manufacturer: 'Amazon',
    PlayReadyInitiator: 'false',
    Capabilities: CAPS_4K,
  },
  {
    id: 'xbox-playready',
    DrmType: 'PLAYREADY',
    Platform: 'xboxone',
    PlayerId: '@dazn/peng-html5-core/xbox/xbox',
    Model: 'Xbox Series X',
    Manufacturer: 'Microsoft',
    PlayReadyInitiator: 'false',
    Capabilities: CAPS_4K,
  },
  {
    id: 'web-playready-4k-cap',
    DrmType: 'PLAYREADY',
    Platform: 'web',
    PlayerId: '@dazn/peng-html5-core/web/web',
    Model: 'Chrome',
    Manufacturer: 'google',
    PlayReadyInitiator: 'false',
    Capabilities: CAPS_4K,
  },
];

function buildProfilePlaybackParams(profile, assetId, sessionIdSuffix) {
  return {
    AppVersion: APP_VERSION,
    Format: 'MPEG-DASH',
    Secure: 'true',
    AssetId: assetId,
    MtaLanguageCode: '',
    LanguageCode: 'en',
    SessionId: sessionIdSuffix,
    ...profile,
  };
}

module.exports = {
  APP_VERSION,
  CAPS_4K,
  UHD_PLAYREADY_PROFILES,
  buildProfilePlaybackParams,
};
