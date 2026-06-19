'use strict';

const SPORT_NAV_IDS = {
  Cricket: 'e1u2wdsz3x3ejd1wnn91n8efk',
  'Australian Rules Football': 'pxf4y47kwth2g64m7wzo209y',
  Motorsport: '133bpwlb1r12vgyqtkruxq0z7',
};

const CRICKET_RAIL_IDS = {
  'Latest Replays': '99a5e510-6a1e-4ce9-b8bd-44cda9ed21b9',
  'Latest Minis': '16c59b80-8d78-47ca-85c3-8da8fe9c9bf8',
  'Latest Test Cricket Replays': 'd7b07219-28fa-4f53-96d1-fa8c4828719d',
  'Latest T20 Replays': '6b3a2f6a-6a3f-47b5-94f1-066b0f68172b',
  'Latest ODI Replays': '5d10f16e-fd64-414a-9223-22c06386010f',
  "Latest Women's International Replays": '1f4afe83-0db9-49aa-9c52-e8053697f9f9',
  'Latest Bites': 'ef5e2760-8315-4a07-8ca5-951320446ec2',
  'Inside the Game': '2d644b69-0a05-4811-b977-fba86589858f',
  'Kayo Shorts': 'e43df4ff-8622-477f-9a8a-8ac38c614d18',
  'Shane Warne Legacy': '34aa5a33-9301-4057-83fe-ac95dc11180a',
  'Cricket World Series Classics': '6307b271-ffad-4a75-a257-a713d15487ae',
  'Classics Collection': '72e3c625-8582-408b-b287-5bc4f185f86d',
  Shows: '12355c93-c974-4d28-8d85-8203af311226',
};

function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeLabel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeType(value) {
  return String(value || '').toLowerCase();
}

function tileMatchesFilter(tile, filter) {
  if (!filter) return true;
  const type = normalizeType(tile.type || tile.rawType);
  const displayType = normalizeType(tile.displayType);
  const competition = String(tile.competition || '').toLowerCase();
  const title = String(tile.title || '').toLowerCase();
  const label = String(tile.label || '').toLowerCase();
  const haystack = `${title} ${label} ${competition}`;

  if (filter.types?.length && !filter.types.includes(type)) return false;
  if (filter.displayType && !filter.displayType.test(displayType)) return false;
  if (filter.competition && !filter.competition.test(competition)) return false;
  if (filter.text && !filter.text.test(haystack)) return false;
  if (filter.uhdOnly && tile.quality !== 'UHD') return false;
  if (filter.replayOnly) {
    if (type === 'live' || tile.isLinear) return false;
    if (type !== 'catchup' && tile.quality !== 'UHD' && tile.status !== 'Catchup') return false;
  }
  if (filter.excludeLive && (type === 'live' || tile.isLinear)) return false;
  return true;
}

function cricketSubcategoryDefs() {
  return [
    { label: 'All Cricket Replays', filter: { replayOnly: true } },
    { label: '4K UHD Cricket', filter: { uhdOnly: true, excludeLive: true } },
    { label: 'Latest Replays', filter: { types: ['catchup'], excludeLive: true } },
    { label: 'Latest Minis', filter: { types: ['highlights'], displayType: /mini/i } },
    { label: 'Latest Test Cricket Replays', filter: { types: ['catchup'], competition: /test/i } },
    {
      label: 'Latest T20 Replays',
      filter: {
        types: ['catchup'],
        text: /t20|twenty20|t20i|1st t20|2nd t20|3rd t20|blast|ipl|bbl|big bash|vitality blast|pakistan v australia g[123]|australia v pakistan g[123]/i,
      },
    },
    {
      label: 'Latest ODI Replays',
      filter: { types: ['catchup'], competition: /odi|one.day|one-day|internationals 2026/i },
    },
    {
      label: "Latest Women's International Replays",
      filter: { types: ['catchup'], competition: /women|womens/i },
    },
    { label: 'Latest Bites', filter: { displayType: /bite/i } },
    { label: 'Inside the Game', filter: { text: /inside the game/i } },
    { label: 'Kayo Shorts', filter: { text: /kayo shorts|shorts/i } },
    { label: 'Shane Warne Legacy', filter: { text: /shane warne|warne legacy/i } },
    { label: 'Cricket World Series Classics', filter: { text: /world series classic|cricket world series/i } },
    { label: 'Classics Collection', filter: { text: /classics collection|classic collection/i } },
    { label: 'Shows', filter: { text: /show|podcast|documentary/i } },
  ];
}

function genericSubcategoryDefs(sportTitle) {
  return [
    { label: 'Latest Replays', filter: { types: ['catchup'], excludeLive: true } },
    { label: 'Latest Minis & Highlights', filter: { displayType: /mini|highlight/i } },
    { label: 'Latest Bites', filter: { displayType: /bite/i } },
    { label: `All ${sportTitle}`, filter: null },
  ];
}

function sortByRecent(items) {
  return [...items].sort((a, b) => {
    const ta = a.start ? new Date(a.start).getTime() : 0;
    const tb = b.start ? new Date(b.start).getTime() : 0;
    return tb - ta;
  });
}

function sportPageParams(navId) {
  return `PageType:Sport;ContentType:Sport;ContentId:${navId};OpenBrowse:True`;
}

function resolveRailId(label, titleToId) {
  if (titleToId[label]) return titleToId[label];
  if (CRICKET_RAIL_IDS[label]) return CRICKET_RAIL_IDS[label];

  const norm = normalizeLabel(label);
  for (const [title, id] of Object.entries(titleToId)) {
    if (normalizeLabel(title) === norm) return id;
  }
  for (const [title, id] of Object.entries(titleToId)) {
    const titleNorm = normalizeLabel(title);
    if (titleNorm.includes(norm) || norm.includes(titleNorm)) return id;
  }
  return null;
}

function buildSubcategoryFetch(def, sportTitle, navId, titleToId, fetchEpgTiles, fetchRail, getSportPool) {
  return async (token) => {
    const railId = resolveRailId(def.label, titleToId);
    const pageParams = navId ? sportPageParams(navId) : null;
    let items = [];

    if (railId && token) {
      try {
        const railItems = await fetchRail(railId, token, { pageParams });
        if (railItems.length) items = railItems;
      } catch { /* merge from full pool below */ }
    }

    if (getSportPool) {
      const pool = await getSportPool(token);
      items = mergeByAssetId(items, pool);
    } else {
      const epgItems = await fetchEpgTiles({
        sportTitleExact: sportTitle,
        catchupOnly: true,
        daysBack: 365,
        daysForward: 0,
      });
      items = mergeByAssetId(items, epgItems);
    }

    const filtered = def.filter ? items.filter((item) => tileMatchesFilter(item, def.filter)) : items;
    return sortByRecent(filtered);
  };
}

function mergeByAssetId(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list || []) {
      if (!item?.assetId || seen.has(item.assetId)) continue;
      seen.add(item.assetId);
      out.push(item);
    }
  }
  return out;
}

function buildSubcategoriesFromDefs(defs, sportTitle, navId, titleToId, fetchEpgTiles, fetchRail, getSportPool) {
  return defs.map((def) => ({
    key: slugify(def.label),
    label: def.label,
    fetch: buildSubcategoryFetch(def, sportTitle, navId, titleToId, fetchEpgTiles, fetchRail, getSportPool),
  }));
}

function extractRailIdsFromCatalog(data) {
  return (data?.Rails || data?.rails || [])
    .map((rail) => (typeof rail === 'string' ? rail : (rail.Id || rail.id)))
    .filter((id) => /^[0-9a-f-]{36}$/i.test(String(id)));
}

async function fetchSportRailCatalog(navId, token, requestJson, kayoHeaders, fetchRailTitle) {
  const params = encodeURIComponent(`PageType:Sport;ContentType:Sport;ContentId:${navId}`);
  const url = `https://rails.discovery.indazn.com/jp/v9/rails?groupId=sport&country=au&params=${params}&openBrowse=true&brand=kayo`;
  try {
    const data = await requestJson(url, { headers: kayoHeaders(token), useProxy: true });
    const ids = extractRailIdsFromCatalog(data);
    if (!ids.length) return {};

    const pageParams = sportPageParams(navId);
    const entries = await Promise.all(ids.map(async (id) => {
      try {
        const title = await fetchRailTitle(id, token, { pageParams });
        return title ? [title, id] : null;
      } catch {
        return null;
      }
    }));

    const titleToId = {};
    for (const entry of entries) {
      if (!entry) continue;
      const [title, id] = entry;
      if (!titleToId[title]) titleToId[title] = id;
    }
    return titleToId;
  } catch {
    return {};
  }
}

async function loadSportSubcategories(sportTitle, deps) {
  const {
    token,
    requestJson,
    kayoHeaders,
    fetchRail,
    fetchRailTitle,
    fetchEpgTiles,
    fetchSportReplayPool,
  } = deps;

  const defs = sportTitle === 'Cricket'
    ? cricketSubcategoryDefs()
    : genericSubcategoryDefs(sportTitle);

  const navId = SPORT_NAV_IDS[sportTitle] || null;
  let titleToId = { ...CRICKET_RAIL_IDS };

  if (navId && token) {
    const discovered = await fetchSportRailCatalog(
      navId,
      token,
      requestJson,
      kayoHeaders,
      fetchRailTitle,
    );
    titleToId = { ...titleToId, ...discovered };
  }

  let poolPromise = null;
  const getSportPool = fetchSportReplayPool
    ? (authToken) => {
      if (!poolPromise) poolPromise = fetchSportReplayPool(sportTitle, authToken);
      return poolPromise;
    }
    : null;

  return buildSubcategoriesFromDefs(
    defs,
    sportTitle,
    navId,
    titleToId,
    fetchEpgTiles,
    fetchRail,
    getSportPool,
  );
}

module.exports = {
  SPORT_NAV_IDS,
  CRICKET_RAIL_IDS,
  loadSportSubcategories,
  tileMatchesFilter,
  slugify,
};
