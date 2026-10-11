'use strict';

/** @returns {'nm3u8dl'|'python'|'unidl'|'unshackle'} */
function getDownloaderMode() {
  const mode = String(process.env.KAYO_DOWNLOADER || 'nm3u8dl').trim().toLowerCase();
  if (mode === 'python' || mode === 'unidl' || mode === 'unshackle') return mode;
  return 'nm3u8dl';
}

function usesBuiltInNm3u8OrPythonCommand() {
  return getDownloaderMode() !== 'unidl' && getDownloaderMode() !== 'unshackle';
}

/** Live TV “Record live” (not catchup clip, not replay-on-live-CDN). */
function isLiveRecordStream(stream) {
  if (!stream?.isLiveCdn) return false;
  if (stream.liveClip) return false;
  if (stream.catchupReplay) return false;
  return true;
}

/** UniDL for VOD/clips; N_m3u8DL-RE for live record on Windows (pipe-mux). Override: KAYO_LIVE_DOWNLOADER=unidl */
function liveRecordDownloader() {
  const mode = String(process.env.KAYO_LIVE_DOWNLOADER || 'nm3u8dl').trim().toLowerCase();
  if (mode === 'unidl' || mode === 'python' || mode === 'unshackle') return mode;
  return 'nm3u8dl';
}

function shouldLaunchNm3u8ForStream(stream) {
  const mode = getDownloaderMode();
  if (mode === 'nm3u8dl' || mode === 'python') return true;
  if (mode === 'unshackle') return false;
  if (mode === 'unidl' && isLiveRecordStream(stream)) {
    return liveRecordDownloader() === 'nm3u8dl';
  }
  return mode !== 'unidl';
}

module.exports = {
  getDownloaderMode,
  usesBuiltInNm3u8OrPythonCommand,
  isLiveRecordStream,
  liveRecordDownloader,
  shouldLaunchNm3u8ForStream,
};
