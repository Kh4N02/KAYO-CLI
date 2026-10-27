'use strict';

const {
  buildNm3u8DlCommand,
  buildUnidlDownloadCommand,
  normalizeDownloadBuild,
} = require('./mpd-formatter');
const {
  getDownloaderMode,
  isLiveRecordStream,
  liveRecordDownloader,
} = require('./downloader-mode');

function effectiveDownloaderForStream(stream) {
  const global = getDownloaderMode();
  if (global === 'unidl' || global === 'unshackle') return global;
  if (stream && isLiveRecordStream(stream)) {
    const live = liveRecordDownloader();
    if (live === 'unidl') return 'unidl';
  }
  if (global === 'python') return 'python';
  return 'nm3u8dl';
}

function buildStreamDownloadCommand(
  manifestUrl,
  keys,
  title,
  cdnName,
  headers,
  options = {},
) {
  const streamShape = {
    isLiveCdn: options.isLive,
    liveClip: options.liveClip,
    catchupReplay: options.livePerformAsVod,
  };
  const mode = effectiveDownloaderForStream(streamShape);

  if (mode === 'unidl') {
    return normalizeDownloadBuild(buildUnidlDownloadCommand(
      manifestUrl,
      keys,
      title,
      {
        cdnUpstreamBase: options.cdnUpstreamBase,
        manifestUrl: options.manifestUrl || manifestUrl,
        baseUrl: options.baseUrl,
        saveDir: options.saveDir,
        isLive: options.isLive,
        liveClip: options.liveClip,
        livePerformAsVod: options.livePerformAsVod,
        livePipeMux: options.livePipeMux,
        isUhd: options.isUhd,
        maxHeight: options.maxHeight,
      },
    ));
  }

  return normalizeDownloadBuild(buildNm3u8DlCommand(
    manifestUrl,
    keys,
    title,
    cdnName,
    headers,
    {
      isLive: options.isLive,
      liveClip: options.liveClip,
      livePerformAsVod: options.livePerformAsVod,
      isUhd: options.isUhd,
      maxHeight: options.maxHeight,
      baseUrl: options.baseUrl,
      manifestUrl: options.manifestUrl,
      skipAppendUrlParams: options.skipAppendUrlParams,
      saveDir: options.saveDir,
    },
  ));
}

module.exports = {
  effectiveDownloaderForStream,
  buildStreamDownloadCommand,
};
