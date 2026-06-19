#!/usr/bin/env node
'use strict';

const readline = require('readline');
const {
  loadEnv,
  authenticate,
  loadCategories,
  getCategories,
  loadReplaySubcategories,
  fetchSearch,
  formatLocalTime,
  hydrateUhdFromDisk,
  refreshDiscoveryCaches,
  getDiscoveryCacheInfo,
  formatCacheAge,
} = require('./lib/kayo-api');
const { renderTable } = require('./lib/table');
const { resolvePlaybackProxied } = require('./lib/playback');
const { appendStreamHeader, appendSingleStream } = require('./lib/key-store');
const { promptLiveRange: promptLiveRangeInput } = require('./lib/live-range-prompt');
const {
  printBanner,
  logInfo,
  logOk,
  logWarn,
  logErr,
  prompt,
  kayo,
  divider,
  C,
  colorEnabled,
} = require('./lib/ui');

function ask(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt(promptText), (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

function categoryMenuRows() {
  return getCategories().map((c, i) => ({
    Idx: String(i + 1),
    Category: c.label,
    sport: c.sportTitle || c.label,
  }));
}

function itemMenuRows(items) {
  return items.map((item, i) => ({
    Idx: String(i + 1),
    Status: item.status || '',
    Quality: item.quality || 'HD',
    Channel: item.channel || 'Kayo',
    sport: item.sport || item.channel,
    Title: item.title,
    'Local Time': formatLocalTime(item.start),
    'Asset ID': item.assetId,
  }));
}

function logCacheHint(label, entry) {
  if (!entry?.fresh) return;
  logInfo(`${label}: using cache (${entry.count} items, updated ${formatCacheAge(entry.updated)})`);
}

async function pickCategory() {
  console.log('');
  console.log(renderTable('Select Category', ['Idx', 'Category'], [
    ...categoryMenuRows(),
    { Idx: 'r', Category: 'Refresh all caches (UHD + EPG + replays)', sport: '' },
    { Idx: 'q', Category: 'Quit', sport: '' },
  ]));
  console.log('');
  const choice = await ask('Select: ');
  if (choice.toLowerCase() === 'q') return null;
  if (choice.toLowerCase() === 'r') return { isRefresh: true };
  const idx = Number(choice);
  const categories = getCategories();
  if (!Number.isInteger(idx) || idx < 1 || idx > categories.length) {
    logErr('Invalid selection');
    return pickCategory();
  }
  return categories[idx - 1];
}

async function pickItem(items) {
  console.log('');
  console.log(renderTable('Channels / Events', ['Idx', 'Status', 'Quality', 'Channel', 'Title', 'Local Time', 'Asset ID'], [
    ...itemMenuRows(items),
    { Idx: 'b', Status: '', Quality: '', Channel: '', sport: '', Title: 'Back to categories', 'Local Time': '', 'Asset ID': '' },
    { Idx: 'q', Status: '', Quality: '', Channel: '', sport: '', Title: 'Quit', 'Local Time': '', 'Asset ID': '' },
  ]));
  console.log('');
  const choice = await ask('Select: ');
  if (choice.toLowerCase() === 'q') return 'quit';
  if (choice.toLowerCase() === 'b') return 'back';
  const idx = Number(choice);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    logErr('Invalid selection');
    return pickItem(items);
  }
  return items[idx - 1];
}

function needsLiveRangePrompt(item) {
  if (!item) return false;
  if (item.isLinear) return true;
  return /^(Live|Upcoming)$/i.test(String(item.status || ''));
}

async function promptLiveRange(item) {
  return promptLiveRangeInput(item, (text) => ask(text));
}

function printStream(s, index) {
  const { isLikely4kStream } = require('./lib/mpd-formatter');
  const maxQ = s.maxQuality || 'unknown';
  const uhdHint = s.uhdAvailable || isLikely4kStream(s.cdnName, s.keys, s.maxHeight)
    ? ' · UHD ladder'
    : '';
  const recHint = s.recommended ? ' · recommended' : '';
  const segHint = s.segmentCount ? ` · ${s.segmentCount} segs` : '';
  console.log(divider(`Stream ${index} · ${s.cdnName} · max ${maxQ}${uhdHint}${recHint}${segHint}`));
  if (s.error) {
    logWarn(`Unavailable: ${s.error}`);
    console.log('');
    return;
  }
  console.log(colorEnabled() ? `${C.bold}${s.isLiveCdn ? 'Formatted MPD URL' : 'MPD URL'}${C.reset}` : (s.isLiveCdn ? 'Formatted MPD URL' : 'MPD URL'));
  console.log(colorEnabled() ? `${C.dim}${s.manifestUrl}${C.reset}` : s.manifestUrl);
  if (s.liveRangePreview) {
    logInfo(`Australian URL window: start=${s.liveRangePreview.startAu}  end=${s.liveRangePreview.endAu}`);
  }
  console.log(colorEnabled() ? `${C.bold}License URL${C.reset}` : 'License URL');
  console.log(colorEnabled() ? `${C.dim}${s.licenseUrl || ''}${C.reset}` : (s.licenseUrl || ''));
  console.log('');
  if (s.keys?.length) {
    if (s.isLiveCdn && s.maxHeight && s.maxHeight < 2160) {
      logInfo(`Manifest max video is ${s.maxQuality}. Start/end clips the live window only — it does not add 4K.`);
    } else if (s.uhdAvailable) {
      logInfo('2160p or multi-key UHD ladder detected — use this stream for 4K.');
    }
    logOk('Decryption Keys Found');
    for (const k of s.keys) {
      console.log(colorEnabled()
        ? `  ${kayo('--key')} ${C.brightWhite}${k.kid}${C.reset}:${C.brightGreen}${k.key}${C.reset}`
        : `--key ${k.kid}:${k.key}`);
    }
    if (s.cmd) {
      console.log('');
      console.log(colorEnabled() ? `${C.bold}${kayo('N_m3u8DL-RE command')}${C.reset}` : 'N_m3u8DL-RE command:');
      console.log(colorEnabled() ? `${C.gray}${s.cmd}${C.reset}` : s.cmd);
    }
  } else {
    logWarn('No keys for this CDN');
  }
  console.log('');
}

async function fetchStream(assetId, title, token, { item = null } = {}) {
  logInfo(`Fetching playback for ${colorEnabled() ? kayo(title || assetId) : (title || assetId)}...`);

  let liveRange = null;
  if (needsLiveRangePrompt(item)) {
    liveRange = await promptLiveRange(item);
  }

  let keyFile = null;
  let headerWritten = false;
  let anyKeys = false;

  const result = await resolvePlaybackProxied({
    assetId,
    authToken: token,
    liveRange,
    onStatus: (msg) => logInfo(msg),
    onStream: ({ index, stream, title: streamTitle, failed }) => {
      if (!headerWritten) {
        console.log('');
        logOk(`Title: ${streamTitle}`);
        console.log('');
        keyFile = appendStreamHeader({ title: streamTitle });
        headerWritten = true;
      }
      printStream(stream, index);
      if (!failed && stream.keys?.length) {
        anyKeys = true;
        appendSingleStream({ stream, index });
        logOk(`Saved stream ${index} keys to ${keyFile}`);
      }
    },
  });

  if (!headerWritten) {
    console.log('');
    logOk(`Title: ${result.title}`);
    console.log('');
  }

  if (!anyKeys) {
    logWarn('No decryption keys found for any CDN');
  } else {
    const { downloadProxyLabel } = require('./lib/proxy-request');
    const proxyLabel = downloadProxyLabel();
    if (proxyLabel) {
      const tunnel = String(process.env.KAYO_PROXY_TUNNEL || '').trim();
      const mode = tunnel
        ? 'Clash tunnel (KAYO_PROXY_TUNNEL) — same AU egress as Webshare'
        : 'Webshare (KAYO_PROXY)';
      logInfo(`Download proxy: ${kayo(proxyLabel)} — ${mode}`);
    }
  }
  console.log('');
}

async function pickSubcategory(subcategories, sportLabel) {
  console.log('');
  console.log(renderTable(`${sportLabel} — Select Section`, ['Idx', 'Section'], [
    ...subcategories.map((sub, i) => ({
      Idx: String(i + 1),
      Section: sub.label,
    })),
    { Idx: 'b', Section: 'Back to categories' },
    { Idx: 'q', Section: 'Quit' },
  ]));
  console.log('');
  const choice = await ask('Select section: ');
  if (choice.toLowerCase() === 'q') return 'quit';
  if (choice.toLowerCase() === 'b') return 'back';
  const idx = Number(choice);
  if (!Number.isInteger(idx) || idx < 1 || idx > subcategories.length) {
    logErr('Invalid selection');
    return pickSubcategory(subcategories, sportLabel);
  }
  return subcategories[idx - 1];
}

async function browseSubcategoryItems(items, token, sectionLabel, sportLabel) {
  if (!items.length) {
    logWarn(`No items found in "${sectionLabel}".`);
    return;
  }
  logOk(`Found ${items.length} item(s) in ${sectionLabel}`);

  for (;;) {
    const picked = await pickItem(items);
    if (picked === 'back') return;
    if (picked === 'quit') process.exit(0);
    try {
      await fetchStream(picked.assetId, picked.title, token, { item: picked });
    } catch (e) {
      logErr(e.message || String(e));
      if (/401|expired|token/i.test(String(e.message))) {
        logWarn('Try restarting — token may have expired.');
      }
    }
    const again = await ask('Press Enter for list, or b=back, q=quit: ');
    if (again.toLowerCase() === 'q') process.exit(0);
    if (again.toLowerCase() === 'b') return;
  }
}

async function browseReplaySport(category, token) {
  logInfo(`Loading ${category.label} sections...`);
  let subcategories;
  try {
    subcategories = await loadReplaySubcategories(category.sportTitle, token);
  } catch (e) {
    logErr(e.message || String(e));
    return;
  }
  if (!subcategories.length) {
    logWarn('No sections found for this sport.');
    return;
  }

  for (;;) {
    const picked = await pickSubcategory(subcategories, category.label);
    if (picked === 'back') return;
    if (picked === 'quit') process.exit(0);

    logInfo(`Fetching ${picked.label}...`);
    const cacheInfo = getDiscoveryCacheInfo();
    if (picked.label === '4K UHD Cricket') {
      if (cacheInfo.cricketPool?.fresh) {
        logInfo(`Cricket pool: using cache (${cacheInfo.cricketPool.uhdCount} UHD / ${cacheInfo.cricketPool.count} replays, updated ${formatCacheAge(cacheInfo.cricketPool.updated)})`);
      } else if (!cacheInfo.cricketPool?.fresh) {
        logInfo('Building cricket pool (730 days EPG) — use r at main menu to pre-cache');
      }
    } else if (picked.label === 'All Cricket Replays') {
      logCacheHint('Cricket replays', cacheInfo.cricketPool);
    }
    let items;
    try {
      items = await picked.fetch(token);
    } catch (e) {
      logErr(e.message || String(e));
      continue;
    }
    await browseSubcategoryItems(items, token, picked.label, category.label);
  }
}

async function browseSearch(token) {
  for (;;) {
    console.log('');
    const query = await ask('Search Kayo (Enter = back to categories): ');
    if (!query) return;

    logInfo(`Searching "${query}"...`);
    let items;
    try {
      items = await fetchSearch(query, token);
    } catch (e) {
      logErr(e.message || String(e));
      continue;
    }
    if (!items.length) {
      logWarn('No results. Try e.g. "Australia Pakistan" or "Pakistan v Australia".');
      continue;
    }
    logOk(`Found ${items.length} result(s)`);
    await browseSubcategoryItems(items, token, `Search: ${query}`, 'Search');
  }
}

async function browseCategory(category, token) {
  if (category.isSearch) {
    return browseSearch(token);
  }
  if (category.hasSubcategories && category.sportTitle) {
    return browseReplaySport(category, token);
  }

  logInfo(`Fetching ${category.label}...`);
  const cacheInfo = getDiscoveryCacheInfo();
  if (category.key === 'uhd') {
    logCacheHint('4K UHD Events', cacheInfo.uhd);
    if (!cacheInfo.uhd?.fresh) {
      logInfo('Scanning home + sport rails for UHD (is4k)... first run may take several minutes.');
    }
  }
  if (category.key === 'epg') {
    logCacheHint('Live & Upcoming', cacheInfo.epgLive);
  }
  let items;
  try {
    items = await category.fetch(token);
  } catch (e) {
    logErr(e.message || String(e));
    return;
  }
  if (!items.length) {
    logWarn('No items found for this category.');
    return;
  }
  logOk(`Found ${items.length} item(s)`);

  for (;;) {
    const picked = await pickItem(items);
    if (picked === 'back') return;
    if (picked === 'quit') process.exit(0);
    try {
      await fetchStream(picked.assetId, picked.title, token, { item: picked });
    } catch (e) {
      logErr(e.message || String(e));
      if (/401|expired|token/i.test(String(e.message))) {
        logWarn('Try restarting — token may have expired.');
      }
    }
    const again = await ask('Press Enter for list, or b=back, q=quit: ');
    if (again.toLowerCase() === 'q') process.exit(0);
    if (again.toLowerCase() === 'b') return;
  }
}

async function main() {
  loadEnv();
  printBanner();
  logInfo('Authenticating with Kayo Servers...');
  let token;
  try {
    token = await authenticate((msg) => logInfo(msg));
    logOk('Successfully Authenticated!');
    const uhdDisk = hydrateUhdFromDisk();
    if (uhdDisk) {
      logInfo(`UHD cache loaded (${uhdDisk.items.length} items, updated ${formatCacheAge(uhdDisk.updated)})`);
    } else {
      logInfo('No fresh UHD cache — first 4K browse will scan Kayo rails (or press r to refresh now)');
    }
  } catch (e) {
    logErr(e.message || String(e));
    process.exit(1);
  }

  try {
    await loadCategories((msg) => logInfo(msg));
  } catch (e) {
    logWarn(`Could not load replay categories: ${e.message || e}`);
    logWarn('Showing base categories only (Live TV, EPG, 4K).');
  }

  for (;;) {
    const category = await pickCategory();
    if (!category) {
      console.log(colorEnabled() ? `\n${kayo('Bye.')}\n` : '\nBye.\n');
      break;
    }
    if (category.isRefresh) {
      try {
        await refreshDiscoveryCaches(token, (msg) => logInfo(msg));
        const info = getDiscoveryCacheInfo();
        logOk(`Caches refreshed — UHD: ${info.uhd?.count || 0}, Cricket UHD: ${info.cricketPool?.uhdCount || 0}, EPG: ${info.epgLive?.count || 0}`);
      } catch (e) {
        logErr(e.message || String(e));
      }
      continue;
    }
    await browseCategory(category, token);
  }
}

main().catch((e) => {
  logErr(e.message || String(e));
  process.exit(1);
});
