const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 60_000;

const groups = [
  ['visual', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle'],
  ['stations', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle'],
  ['starlink', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle'],
  ['science', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=science&FORMAT=tle'],
];

// Netlify Functions have an ephemeral filesystem. Keep a two-hour warm-instance
// cache here and let Netlify's durable CDN cache share the public catalog globally.
let cached = null;
let pending = null;
let lastAttempt = 0;
let lastError = null;

export function parseTLE(text, group = '') {
  const lines = text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());
  const records = [];
  for (let i = 0; i < lines.length - 1; i++) {
    let name, line1, line2;
    if (lines[i].startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      line1 = lines[i]; line2 = lines[++i]; name = `SAT ${line1.slice(2, 7).trim()}`;
    } else if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      name = lines[i].replace(/^0\s+/, '').trim(); line1 = lines[++i]; line2 = lines[++i];
    } else continue;
    if (line1.length < 60 || line2.length < 60) continue;
    records.push({ name, line1, line2, norad: line1.slice(2, 7).trim(), group });
  }
  return records;
}

async function upstream(url, json = false) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(18_000),
    headers: {
      'User-Agent': 'Skyward/1.0 (educational satellite sky tracker)',
      Accept: json ? 'application/json' : '*/*',
    },
  });
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);
  return json ? response.json() : response.text();
}

function classify(record, enrichment) {
  const name = record.name.toUpperCase();
  let kind = 'satellite';
  if (/ISS|TIANGONG|CSS \(|ZARYA/.test(name)) kind = 'station';
  else if (name.includes('STARLINK')) kind = 'starlink';
  else if (/R\/B|ROCKET|CENTAUR|AGENA/.test(name)) kind = 'rocket';
  else if (/DEB(RIS)?/.test(name)) kind = 'debris';
  const labels = {
    station: 'Space station', starlink: 'Communications', rocket: 'Rocket body',
    debris: 'Orbital debris', satellite: 'Satellite',
  };
  return {
    ...record,
    kind,
    mission: enrichment?.mission && enrichment.mission !== 'Unknown' ? enrichment.mission : labels[kind],
    highlight: record.group === 'visual' || kind === 'station',
  };
}

async function fetchCatalog() {
  const enrichmentTask = upstream('https://osirisai.live/api/satellites', true)
    .catch(error => ({ error: error.message }));
  const results = await Promise.all(groups.map(async ([group, url]) => {
    try {
      return { group, records: parseTLE(await upstream(url), group) };
    } catch (error) {
      console.warn(`CelesTrak ${group}: ${error.message}`);
      return { group, records: [], error: error.message };
    }
  }));

  let records = results.flatMap(result => result.records);
  let orbitalSources = results.filter(result => result.records.length).map(result => `CelesTrak · ${result.group}`);
  if (!records.length) {
    try {
      const fallback = await upstream('https://db.satnogs.org/api/tle/?format=json', true);
      records = fallback.filter(item => item.tle1 && item.tle2).map(item => ({
        name: (item.tle0 || '').replace(/^0\s+/, '').trim(),
        line1: item.tle1,
        line2: item.tle2,
        norad: item.tle1.slice(2, 7).trim(),
        group: 'satnogs',
      }));
      orbitalSources = ['SatNOGS · public TLE catalog'];
    } catch (error) {
      console.warn(`SatNOGS: ${error.message}`);
    }
  }

  const osiris = await enrichmentTask;
  if (!records.length) throw new Error('Live orbital elements are temporarily unavailable. Please try again later.');
  const enrichments = new Map((osiris.satellites || []).map(item => [
    String(item.noradId).replace(/^0+/, ''), item,
  ]));
  const unique = new Map();
  for (const record of records) {
    if (!unique.has(record.norad)) {
      unique.set(record.norad, classify(record, enrichments.get(record.norad.replace(/^0+/, ''))));
    }
  }
  return {
    version: 1,
    fetchedAt: new Date().toISOString(),
    satellites: [...unique.values()],
    total: unique.size,
    sources: {
      orbital: orbitalSources,
      enrichment: osiris.satellites ? 'OSIRIS' : null,
      osirisCatalogCount: osiris.total || 0,
      osirisTimestamp: osiris.timestamp || null,
    },
    failedGroups: results.filter(item => !item.records.length).map(item => item.group),
  };
}

async function refreshCatalog() {
  if (pending) return pending;
  if (!cached && lastError && Date.now() - lastAttempt < RETRY_DELAY_MS) throw lastError;
  lastAttempt = Date.now();
  const request = fetchCatalog();
  pending = request;
  try {
    cached = await request;
    lastError = null;
    return cached;
  } catch (error) {
    lastError = error;
    throw error;
  } finally {
    if (pending === request) pending = null;
  }
}

async function getCatalog() {
  const now = Date.now();
  if (cached) {
    const age = Math.max(0, now - Date.parse(cached.fetchedAt));
    if (age <= CACHE_TTL_MS) {
      return { ...cached, stale: false, cacheAgeSeconds: Math.round(age / 1000) };
    }
    try {
      const fresh = await refreshCatalog();
      return { ...fresh, stale: false, cacheAgeSeconds: 0 };
    } catch {
      // If an upstream feed is temporarily unavailable, keep showing the last real catalog.
      return { ...cached, stale: true, cacheAgeSeconds: Math.round(age / 1000) };
    }
  }
  const fresh = await refreshCatalog();
  return { ...fresh, stale: false, cacheAgeSeconds: 0 };
}

function jsonResponse(value, { status = 200, cacheable = false } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  };
  if (cacheable) {
    // Catalog results are identical for all visitors: share them via Netlify CDN,
    // but let each browser refresh its copy sooner than the CDN does.
    headers['Cache-Control'] = 'public, max-age=300';
    headers['Netlify-CDN-Cache-Control'] = 'public, durable, max-age=7200';
  } else {
    headers['Cache-Control'] = 'no-store';
    headers['Netlify-CDN-Cache-Control'] = 'no-store';
  }
  return new Response(value === null ? null : JSON.stringify(value), { status, headers });
}

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  try {
    const result = await getCatalog();
    if (request.method === 'HEAD') return jsonResponse(null, { cacheable: true });
    return jsonResponse(result, { cacheable: true });
  } catch {
    const body = { error: 'Live orbital elements are temporarily unavailable. Please try again later.' };
    if (request.method === 'HEAD') return jsonResponse(null, { status: 503 });
    return jsonResponse(body, { status: 503 });
  }
}

export const config = { path: '/api/catalog' };
