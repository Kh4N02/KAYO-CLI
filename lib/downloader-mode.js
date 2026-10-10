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

module.exports = { getDownloaderMode, usesBuiltInNm3u8OrPythonCommand };
