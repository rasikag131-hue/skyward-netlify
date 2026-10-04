import { twoline2satrec } from './assets/satellite.es.js';
import { satelliteLook, solarContext, observerSunElevation, nextPass } from './orbit-math.js';

let records = [];
let recordLookup = new Map();
let observer = { lat: 6.9271, lng: 79.8612, altitude: 0 };
let filter = 'all';
let selected = null;
let minElevation = 0;
let paused = false;
let timer = null;
let passCache = null;
let passCacheTime = 0;

function match(record) {
  if (filter === 'stations') return record.kind === 'station';
  if (filter === 'starlink') return record.kind === 'starlink';
  if (filter === 'highlights') return record.highlight;
  return true;
}

function compute() {
  if (!records.length || paused) return;
  const started = performance.now();
  const date = new Date();
  const context = solarContext(date);
  let aboveTotal = 0, count = 0;
  const above = [];
  let chosen = null;
  for (const record of records) {
    try {
      const item = satelliteLook(record, date, observer, context);
      if (!item || item.altitude < 80 || item.elementAgeDays > 30) continue;
      count++;
      if (item.elevation > minElevation) {
        aboveTotal++;
        if (match(record)) above.push(item);
      }
      if (record.norad === selected) chosen = item;
    } catch {}
  }
  above.sort((a, b) => {
    const priority = item => (item.kind === 'station' ? 160 : item.highlight ? 90 : 0) + item.elevation + (item.sunlit ? 8 : 0);
    return priority(b) - priority(a);
  });
  const list = above.slice(0, 100);
  const inView = above;
  const nextDate = new Date(date.getTime() + 2000);
  const nextContext = solarContext(nextDate);
  const included = new Map(inView.map(item => [item.norad, item]));
  if (chosen) included.set(chosen.norad, chosen);
  for (const item of included.values()) {
    const record = recordLookup.get(item.norad);
    try { item.nextVector = satelliteLook(record, nextDate, observer, nextContext)?.vector || item.vector; } catch { item.nextVector = item.vector; }
  }
  let trail = [];
  let pass = null;
  if (chosen) {
    const record = recordLookup.get(selected);
    for (let seconds = -90; seconds <= 180; seconds += 10) {
      const point = satelliteLook(record, new Date(date.getTime() + seconds * 1000), observer);
      if (point && point.elevation > -5) trail.push({ vector: point.vector, seconds });
    }
    if (passCache?.norad !== selected || passCache?.above !== (chosen.elevation >= 0) || Date.now() - passCacheTime > 60000) {
      passCache = { norad: selected, above: chosen.elevation >= 0, result: nextPass(record, date, observer) };
      passCacheTime = Date.now();
    }
    pass = passCache.result;
  }
  self.postMessage({
    type: 'positions', timestamp: date.getTime(), count, aboveTotal, filteredCount: above.length,
    list, objects: [...included.values()], selected: chosen, trail, pass,
    sunElevation: observerSunElevation(date, observer, context), elapsedMs: Math.round(performance.now() - started),
  });
}

self.onmessage = event => {
  const message = event.data;
  if (message.type === 'init') {
    records = message.satellites.map(record => {
      try { return { ...record, satrec: twoline2satrec(record.line1, record.line2) }; } catch { return null; }
    }).filter(Boolean);
    recordLookup = new Map(records.map(record => [record.norad, record]));
    if (timer) clearInterval(timer);
    timer = setInterval(compute, 1200);
    self.postMessage({ type: 'ready', total: records.length });
    compute();
  } else if (message.type === 'settings') {
    observer = message.observer || observer;
    filter = message.filter || filter;
    selected = message.selected === undefined ? selected : message.selected;
    minElevation = message.minElevation ?? minElevation;
    if (message.observer) passCache = null;
    compute();
  } else if (message.type === 'pause') {
    paused = message.paused;
    if (!paused) compute();
  }
};
