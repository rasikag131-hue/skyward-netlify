import { manualBasis, deviceBasis, basisLook, project, direction, wrap, clamp, unit } from './orbit-math.js';

const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = text => String(text ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const number = value => Math.round(value).toLocaleString();
const state = {
  observer: { lat: 6.9271, lng: 79.8612, altitude: 0 }, locationType: 'preview', locationLabel: 'Colombo, Sri Lanka',
  heading: 0, elevation: 35, fov: 62, headingOffset: 0, minElevation: 0, manualAim: true, userManual: false,
  filter: 'all', query: '', catalog: null, positions: null, selectedId: null, wantCenter: false,
  loading: false, cameraStream: null, cameraPending: false, orientation: null, orientationAt: 0,
  motionRequested: false, orientationInstalled: false, labels: true, immersive: false, initialAim: false,
};
const stage = $('camera-stage');
const canvas = $('orbit-canvas');
const ctx = canvas.getContext('2d');
const worker = new Worker('/orbit-worker.js', { type: 'module' });
const markerNodes = new Map();
let catalogLookup = new Map();
let watchId = null;
let stageWidth = 800, stageHeight = 483, pixelRatio = 1;
let lastReadout = 0;
let lastMarkerText = 0;
let lastListRender = 0;
let toastTimer = null;
let toastPriority = 0;
let toastUntil = 0;
let smoothBasis = null;
let wasSensorAiming = false;
let hasAbsoluteEvent = false;

function toast(message, duration = 6500, priority = 0) {
  if (Date.now() < toastUntil && priority < toastPriority) return;
  toastPriority = priority; toastUntil = Date.now() + duration;
  clearTimeout(toastTimer);
  $('toast-region').innerHTML = `<div class="toast">${icon('info')}<span>${escape(message)}</span></div>`;
  toastTimer = setTimeout(() => { $('toast-region').innerHTML = ''; toastPriority = 0; toastUntil = 0; }, duration);
}

function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}

document.querySelectorAll('[data-dialog]').forEach(button => button.addEventListener('click', () => openDialog(button.dataset.dialog)));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));

function postSettings(extra = {}) {
  worker.postMessage({ type: 'settings', filter: state.filter, selected: state.selectedId, minElevation: state.minElevation, ...extra });
}

async function loadCatalog(showToast = false) {
  if (state.loading) return;
  state.loading = true;
  $('refresh-data').disabled = true;
  if (!state.catalog) $('data-indicator').innerHTML = '<span class="status-dot connecting"></span><span>Connecting to orbit</span>';
  try {
    const response = await fetch('/api/catalog', { cache: showToast ? 'reload' : 'default', signal: AbortSignal.timeout(45000) });
    const data = await response.json();
    if (!response.ok || !data.satellites?.length) throw new Error(data.error || 'No orbital elements were returned.');
    state.catalog = data;
    catalogLookup = new Map(data.satellites.map(record => [record.norad, record]));
    worker.postMessage({ type: 'init', satellites: data.satellites });
    postSettings({ observer: state.observer });
    $('data-indicator').innerHTML = `<span class="status-dot ${data.stale ? 'error' : ''}"></span><span>${data.stale ? 'Cached orbital elements' : 'Live orbit predictions'}</span>`;
    $('catalog-count').textContent = `${data.total.toLocaleString()} catalog objects`;
    if (showToast) toast(data.stale ? 'Using cached orbital elements while the source refreshes. Positions are still recalculated locally.' : 'Catalog checked. Satellite positions are recalculated on your device.');
    updateDiagnostics();
  } catch (error) {
    if (!state.catalog) {
      $('data-indicator').innerHTML = '<span class="status-dot error"></span><span>Orbital feed unavailable</span>';
      $('loading-sky').innerHTML = `${icon('orbit')}<span>We couldn't connect to orbit.</span><small>${escape(error.message)}</small><button class="button button-secondary" id="retry-catalog">Try again ${icon('refresh')}</button>`;
      $('retry-catalog').addEventListener('click', () => loadCatalog());
      $('object-list').innerHTML = `<div class="list-empty">${icon('satellite')}<span>Orbital data is unavailable.</span><small>No simulated objects are shown as live.</small></div>`;
      $('catalog-count').textContent = 'Waiting for public orbital data';
      $('data-diagnostics').textContent = `Source unavailable: ${error.message}`;
    }
    toast(`Orbital data: ${error.message}`, 8500);
  } finally {
    state.loading = false;
    $('refresh-data').disabled = false;
  }
}

function chooseInitial(list) {
  return list.find(item => item.kind === 'station') || list.find(item => item.kind === 'satellite' && item.highlight) || list.find(item => item.kind === 'satellite') || list.find(item => item.kind === 'starlink') || list[0];
}

worker.onmessage = event => {
  const message = event.data;
  if (message.type !== 'positions') return;
  state.positions = message;
  $('loading-sky').hidden = true;
  $('above-count').innerHTML = `${message.aboveTotal.toLocaleString()} <span>objects</span>`;
  const night = message.sunElevation < -6;
  const twilight = message.sunElevation >= -6 && message.sunElevation < 0;
  $('conditions-readout').innerHTML = night ? 'Night <span>look for sunlit</span>' : twilight ? 'Twilight <span>look up</span>' : 'Daytime <span>best after dusk</span>';
  $('conditions-icon').innerHTML = icon(night || twilight ? 'moon' : 'sun');
  if (!state.selectedId) {
    const first = chooseInitial(message.list);
    if (first) selectObject(first.norad, true);
    else {
      const station = state.catalog?.satellites.find(item => item.kind === 'station');
      if (station) selectObject(station.norad);
    }
  }
  if (state.wantCenter && message.selected) {
    if (!state.cameraStream || state.manualAim) {
      state.heading = message.selected.azimuth;
      state.elevation = clamp(message.selected.elevation, -10, 85);
      state.manualAim = true;
      syncSettings();
    } else updateTargetGuide();
    state.wantCenter = false;
    state.initialAim = true;
  }
  if (Date.now() - lastListRender > 700) { renderList(); lastListRender = Date.now(); }
  renderSelected();
  updateDiagnostics();
};
worker.onerror = () => {
  $('data-indicator').innerHTML = '<span class="status-dot error"></span><span>Tracker could not start</span>';
  toast('The orbital worker could not start. Try a current Safari or Chrome browser and reload the page.');
};

function kindIcon(kind) { return kind === 'station' ? 'station' : 'satellite'; }

function selectObject(norad, center = false) {
  state.selectedId = norad;
  state.wantCenter = center;
  const record = catalogLookup.get(norad);
  if (record) {
    $('selected-name').textContent = record.name;
    $('selected-mission').textContent = `${record.mission} · NORAD ${record.norad.replace(/^0+/, '')}`;
    $('selected-icon').innerHTML = icon(kindIcon(record.kind));
  }
  $('locate-button').disabled = true;
  $('pass-summary').textContent = 'Calculating position and next pass…';
  postSettings();
  renderList();
}

function renderList() {
  if (!state.catalog || !state.positions) return;
  const lookups = new Map([...state.positions.list, ...state.positions.objects].map(item => [item.norad, item]));
  let items;
  let total;
  const query = state.query.toLowerCase().trim();
  if (query) {
    items = state.catalog.satellites.filter(item => item.name.toLowerCase().includes(query) || item.norad.replace(/^0+/, '').includes(query));
    items.sort((a, b) => (lookups.get(b.norad)?.elevation || -90) - (lookups.get(a.norad)?.elevation || -90));
    total = items.length;
    items = items.slice(0, 30).map(item => ({ ...item, ...lookups.get(item.norad), known: lookups.has(item.norad) }));
    document.querySelector('.panel-heading h2').textContent = 'Catalog matches';
  } else {
    items = state.positions.list.map(item => ({ ...item, known: true }));
    total = state.positions.filteredCount;
    document.querySelector('.panel-heading h2').textContent = 'Above the horizon';
  }
  $('list-count').textContent = total.toLocaleString();
  const list = $('object-list');
  const scroll = list.scrollTop;
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.norad : null;
  if (!items.length) {
    list.innerHTML = `<div class="list-empty">${icon('compass')}<span>${query ? 'No matching objects.' : 'Nothing in this group above your horizon.'}</span><small>${query ? 'Try a name like ISS or a NORAD number.' : 'Try All, a different location, or return later.'}</small></div>`;
  } else {
    list.innerHTML = items.map(item => {
      const known = item.known;
      const lit = known ? item.sunlit ? 'Sunlit' : "Earth's shadow" : item.mission;
      const status = known ? `${lit} · ${item.range > 0 ? number(item.range) + ' km away' : item.mission}` : `NORAD ${item.norad.replace(/^0+/, '')} · select to calculate`;
      const elevation = known ? `${Math.round(item.elevation)}°` : '—';
      return `<button class="object-row ${item.norad === state.selectedId ? 'selected' : ''}" data-norad="${escape(item.norad)}" aria-pressed="${item.norad === state.selectedId}"><span class="object-row-icon ${item.kind === 'station' ? 'station' : ''}">${icon(kindIcon(item.kind))}</span><span class="object-row-copy"><strong>${escape(item.name)}</strong><small>${known ? `<i class="${item.sunlit ? 'sun-dot' : 'shadow-dot'}"></i>` : ''}${escape(status)}</small></span><span class="object-row-stats"><strong>${elevation}</strong><small>${known ? item.elevation < 0 ? 'BELOW' : direction(item.azimuth) : 'CATALOG'}</small></span></button>`;
    }).join('');
  }
  list.scrollTop = scroll;
  if (focusedId) list.querySelector(`[data-norad="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
}

$('object-list').addEventListener('click', event => {
  const button = event.target.closest('[data-norad]');
  if (button) selectObject(button.dataset.norad);
});
$('satellite-search').addEventListener('input', event => {
  state.query = event.target.value;
  $('clear-search').hidden = !state.query;
  document.querySelector('.search-field kbd').hidden = !!state.query;
  renderList();
});
$('clear-search').addEventListener('click', () => {
  state.query = ''; $('satellite-search').value = ''; $('clear-search').hidden = true;
  document.querySelector('.search-field kbd').hidden = false; renderList(); $('satellite-search').focus();
});
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
  postSettings();
}));

function renderSelected() {
  const selected = state.positions?.selected;
  if (!selected || selected.norad !== state.selectedId) return;
  $('selected-name').textContent = selected.name;
  $('selected-mission').textContent = `${selected.mission} · NORAD ${selected.norad.replace(/^0+/, '')}`;
  $('selected-icon').innerHTML = icon(kindIcon(selected.kind));
  const old = selected.elementAgeDays > 7;
  $('selected-light').textContent = old ? 'OLDER ELEMENTS' : selected.sunlit ? 'SUNLIT · EST.' : "EARTH'S SHADOW";
  $('selected-light').className = `light-badge ${old ? 'old' : selected.sunlit ? '' : 'shadow'}`;
  $('selected-altitude').innerHTML = `${number(selected.altitude)} <small>km</small>`;
  $('selected-elevation').innerHTML = `${selected.elevation.toFixed(1)}<small>°</small>`;
  $('selected-speed').innerHTML = `${selected.speed.toFixed(2)} <small>km/s</small>`;
  $('selected-range').innerHTML = `${number(selected.range)} <small>km</small>`;
  $('locate-button').disabled = false;
  $('locate-button').querySelector('span').textContent = state.cameraStream && !state.manualAim ? 'Guide me to it' : 'Locate in sky';
  updatePassSummary();
}

function duration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function updatePassSummary() {
  const selected = state.positions?.selected;
  if (!selected || selected.norad !== state.selectedId) return;
  const pass = state.positions.pass;
  if (selected.elevation >= 0) {
    $('pass-summary').textContent = pass?.setAt ? `Above now · sets in ${duration(pass.setAt - Date.now())}` : 'Above now · remains up for over 6 hours';
  } else if (pass?.riseAt > Date.now()) {
    const time = new Date(pass.riseAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('pass-summary').textContent = `Next rise ${time} local · ${Math.round(pass.maxElevation)}° peak`;
  } else $('pass-summary').textContent = 'Below horizon · no pass found in the next 6 hours';
}

$('locate-button').addEventListener('click', () => {
  const item = state.positions?.selected;
  if (!item) return;
  if (state.cameraStream && !state.manualAim) {
    updateTargetGuide(true);
    toast(item.elevation < 0 ? `${item.name} is below your horizon right now. Its next pass is shown in the details.` : 'Follow the direction guide. Markers are approximate; adjust compass correction if needed.', 4500);
  } else {
    state.heading = item.azimuth;
    state.elevation = clamp(item.elevation, -10, 85);
    state.manualAim = true;
    syncSettings();
    if (item.elevation < 0) toast(`${item.name} is below your horizon. Wait for its next pass to observe it.`);
  }
});

function updateDiagnostics() {
  if (!state.catalog) return;
  const { sources, fetchedAt, stale, failedGroups } = state.catalog;
  const selected = state.positions?.selected;
  $('data-diagnostics').innerHTML = `<div><strong>Orbital source:</strong> ${escape(sources.orbital.join(', '))}</div><div><strong>OSIRIS enrichment:</strong> ${sources.enrichment ? `${number(sources.osirisCatalogCount)} objects available` : 'Unavailable; orbital tracking still works'}</div><div><strong>Elements fetched:</strong> ${escape(new Date(fetchedAt).toLocaleString())}${stale ? ' · stale cache, refreshing' : ''}</div><div><strong>Propagated successfully:</strong> ${number(state.positions?.count || 0)} objects</div>${selected ? `<div><strong>Selected elements age:</strong> ${Math.max(0, selected.elementAgeDays).toFixed(1)} days</div>` : ''}${failedGroups?.length ? `<div><strong>Unavailable groups:</strong> ${escape(failedGroups.join(', '))}</div>` : ''}<div><strong>Location:</strong> ${state.locationType === 'preview' ? 'Preview coordinates, not GPS' : state.locationType === 'gps' ? 'GPS · processed only on this device' : 'Manual coordinates'}</div>`;
}

function updateLocation() {
  const confirmed = state.locationType !== 'preview';
  $('location-name').innerHTML = `${escape(state.locationLabel)} <span class="preview-badge ${confirmed ? 'gps-badge' : ''}">${state.locationType === 'gps' ? 'GPS' : confirmed ? 'MANUAL' : 'PREVIEW'}</span>`;
  $('location-coords').textContent = `${Math.abs(state.observer.lat).toFixed(4)}° ${state.observer.lat >= 0 ? 'N' : 'S'}   ${Math.abs(state.observer.lng).toFixed(4)}° ${state.observer.lng >= 0 ? 'E' : 'W'}`;
  $('latitude-input').value = state.observer.lat.toFixed(6);
  $('longitude-input').value = state.observer.lng.toFixed(6);
  $('location-status').textContent = state.locationType === 'preview' ? 'Using a preview location, not your GPS.' : state.locationType === 'gps' ? `GPS acquired${state.observer.accuracy ? ` · ±${Math.round(state.observer.accuracy)} m` : ''}. Coordinates stay on this device.` : 'Using your manually entered coordinates.';
  postSettings({ observer: state.observer });
  updateViewMode(); updateDiagnostics();
}

function usePosition(position) {
  state.observer = { lat: position.coords.latitude, lng: position.coords.longitude, altitude: Number.isFinite(position.coords.altitude) ? position.coords.altitude : 0, accuracy: position.coords.accuracy };
  state.locationType = 'gps';
  state.locationLabel = 'Your current location';
  updateLocation();
  beginGPSWatch();
}

function beginGPSWatch() {
  if (!state.cameraStream || state.locationType !== 'gps' || watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(position => {
    if (Math.abs(position.coords.latitude - state.observer.lat) + Math.abs(position.coords.longitude - state.observer.lng) > 0.00015) usePosition(position);
  }, () => {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
}

function requestGPS(quiet = false) {
  $('gps-button').disabled = true;
  $('location-status').textContent = 'Waiting for location permission…';
  return new Promise(resolve => {
    if (!navigator.geolocation) {
      $('gps-button').disabled = false;
      $('location-status').textContent = 'GPS is unavailable. Enter coordinates manually.';
      if (!quiet) toast('GPS is unavailable in this browser. Enter your location manually in Settings.');
      resolve(false); return;
    }
    navigator.geolocation.getCurrentPosition(position => {
      usePosition(position);
      $('gps-button').disabled = false;
      if (!quiet) toast('Location acquired. Your coordinates are only used on your device.');
      resolve(true);
    }, error => {
      $('gps-button').disabled = false;
      $('location-status').textContent = error.code === 1 ? 'Location permission denied. Enter your coordinates manually.' : 'Could not get a GPS fix. Try again outdoors or enter coordinates manually.';
      if (state.locationType === 'preview') toast('No GPS fix. Markers still use the labeled Colombo preview location. Enter your location in Settings before aligning them.', 8500, quiet ? 1 : 0);
      else if (!quiet) toast('No new GPS fix. Your previously selected location is still in use.');
      resolve(false);
    }, { enableHighAccuracy: true, timeout: 18000, maximumAge: 60000 });
  });
}

$('gps-button').addEventListener('click', () => requestGPS());
$('location-form').addEventListener('submit', event => {
  event.preventDefault();
  const lat = Number($('latitude-input').value), lng = Number($('longitude-input').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    toast('Enter a latitude from −90 to 90 and longitude from −180 to 180.'); return;
  }
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  state.observer = { lat, lng, altitude: 0 }; state.locationType = 'manual'; state.locationLabel = 'Your selected location';
  updateLocation(); toast('Manual location saved. Satellite positions are being recalculated.');
});

function onOrientation(event) {
  if (!state.motionRequested || event.alpha === null || event.beta === null) return;
  const iosCompass = Number.isFinite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0;
  const absolute = event.type === 'deviceorientationabsolute' || event.absolute === true || iosCompass;
  if (!absolute) return; // Relative alpha is not a usable north reference.
  if (event.type === 'deviceorientationabsolute') hasAbsoluteEvent = true;
  if (hasAbsoluteEvent && event.type === 'deviceorientation' && !iosCompass) return;
  state.orientation = { alpha: event.alpha, beta: event.beta, gamma: event.gamma, absolute: true, webkitCompassHeading: event.webkitCompassHeading, webkitCompassAccuracy: event.webkitCompassAccuracy };
  state.orientationAt = Date.now();
  if (!state.userManual) state.manualAim = false;
  $('motion-button').textContent = 'Phone compass connected';
  $('manual-aim-toggle').checked = state.manualAim;
}

function installOrientation() {
  if (state.orientationInstalled) return;
  window.addEventListener('deviceorientationabsolute', onOrientation);
  window.addEventListener('deviceorientation', onOrientation);
  state.orientationInstalled = true;
}

async function enableOrientation(announce = true) {
  state.motionRequested = true;
  state.userManual = false;
  installOrientation();
  try {
    if (typeof DeviceOrientationEvent === 'undefined') throw new Error('This browser does not offer phone orientation.');
    // Invoked directly from the click handler, before awaiting camera or GPS, for iOS user activation.
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') throw new Error('Motion permission was not granted.');
    }
    $('motion-button').textContent = 'Waiting for phone compass…';
    setTimeout(() => {
      if (!state.orientation && state.motionRequested) {
        state.manualAim = true; syncSettings();
        $('motion-button').textContent = 'Try enabling phone compass';
        if (announce || state.cameraStream) toast('No absolute compass signal yet. Manual aiming is available in Settings. On a phone, open the site in its own HTTPS tab.', 7500);
      }
    }, 6000);
    if (announce) toast('Motion enabled. Waiting for an absolute compass reading; turn your phone gently.');
  } catch (error) {
    state.manualAim = true;
    $('motion-button').textContent = 'Try enabling phone compass';
    syncSettings();
    if (announce) toast(`${error.message} Use manual aiming instead.`);
  }
}

$('motion-button').addEventListener('click', () => enableOrientation());

function updateCameraButtons() {
  document.querySelectorAll('[data-camera]').forEach(button => {
    if (!button.dataset.original) button.dataset.original = button.innerHTML;
    button.disabled = state.cameraPending;
    if (state.cameraPending) button.innerHTML = `${icon('camera')}<span>Opening…</span>`;
    else if (state.cameraStream) button.innerHTML = `${icon('check')}<span>Camera is on</span>`;
    else button.innerHTML = button.dataset.original;
  });
}

function updateViewMode() {
  const active = !!state.cameraStream;
  stage.classList.toggle('camera-running', active);
  document.body.classList.toggle('camera-active', active);
  $('preview-tab').classList.toggle('active', !active);
  $('camera-tab').classList.toggle('active', active);
  $('camera-invite').hidden = active;
  $('stop-camera').hidden = !active;
  $('mode-badge').classList.toggle('camera-badge', active);
  $('mode-badge').innerHTML = `<span></span>${active ? 'CAMERA · PREDICTED OVERLAY' : 'ILLUSTRATIVE SKY'}`;
  $('stage-caption').textContent = active ? state.locationType === 'preview' ? 'PREVIEW LOCATION — set yours in Settings.' : 'Approximate positions, aligned by your phone.' : 'Real orbital positions. A preview of your view.';
  $('stage-caption').classList.toggle('location-warning', active && state.locationType === 'preview');
  $('drag-hint').textContent = state.manualAim ? window.innerWidth < 540 ? 'Swipe to explore' : 'Drag to explore' : 'Point your phone at the sky';
  updateCameraButtons();
}

async function startCamera() {
  if (state.cameraPending) return;
  if (state.cameraStream) { toast('Your camera is already on. Use Stop camera to release it.'); return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    toast('Camera access requires HTTPS and a supported browser. Open the live site in a new Safari or Chrome tab on your phone.', 8500); return;
  }
  state.cameraPending = true; toastUntil = 0; updateCameraButtons();
  const mediaPromise = navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  // Start permission requests in the same user gesture. None are requested on page load.
  void enableOrientation(false);
  void requestGPS(true);
  try {
    const stream = await mediaPromise;
    state.cameraStream = stream;
    $('camera-video').srcObject = stream;
    updateViewMode();
    await $('camera-video').play();
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => {
      if (state.cameraStream === stream) { stopCamera(); toast('Camera access ended. You are back in sky preview.'); }
    });
    beginGPSWatch();
    toast('Camera on. Point upward. Markers are calculated overlays; compass alignment may need a small adjustment.', 6500);
  } catch (error) {
    stopCamera();
    const message = error.name === 'NotAllowedError' || error.name === 'SecurityError' ? 'Camera permission was blocked. Allow it in site settings. If this is an embedded preview, open the live site in a new browser tab on your phone.' : error.name === 'NotFoundError' ? 'No camera was found. You can explore the sky preview instead, or open this site on your phone.' : `Could not open the camera: ${error.message}. Sky preview still works.`;
    toast(message, 9500, 2);
  } finally {
    state.cameraPending = false; updateCameraButtons();
  }
}

function stopCamera() {
  const stream = state.cameraStream;
  state.cameraStream = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  $('camera-video').pause(); $('camera-video').srcObject = null;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  state.manualAim = true; state.userManual = false; state.motionRequested = false;
  state.orientation = null; smoothBasis = null; hasAbsoluteEvent = false;
  if (state.orientationInstalled) {
    window.removeEventListener('deviceorientationabsolute', onOrientation);
    window.removeEventListener('deviceorientation', onOrientation);
    state.orientationInstalled = false;
  }
  $('motion-button').textContent = 'Enable phone compass';
  $('target-guide').hidden = true;
  syncSettings(); updateViewMode();
}

document.querySelectorAll('[data-camera]').forEach(button => button.addEventListener('click', startCamera));
$('camera-tab').addEventListener('click', startCamera);
$('preview-tab').addEventListener('click', () => { if (state.cameraStream) stopCamera(); });
$('stop-camera').addEventListener('click', () => { stopCamera(); toast('Camera stopped. Video was not recorded or uploaded.'); });

function syncSettings() {
  $('manual-aim-toggle').checked = state.manualAim;
  $('manual-heading').value = wrap(state.heading);
  $('manual-heading-value').textContent = `${Math.round(wrap(state.heading))}°`;
  $('manual-elevation').value = state.elevation;
  $('manual-elevation-value').textContent = `${Math.round(state.elevation)}°`;
  $('heading-offset').value = state.headingOffset;
  $('heading-offset-value').textContent = `${state.headingOffset > 0 ? '+' : ''}${state.headingOffset}°`;
  $('fov-input').value = state.fov; $('fov-value').textContent = `${state.fov}°`;
  $('min-elevation-input').value = state.minElevation; $('min-elevation-value').textContent = `${state.minElevation}°`;
  updateViewMode();
}

$('manual-aim-toggle').addEventListener('change', event => {
  state.manualAim = event.target.checked; state.userManual = state.manualAim;
  if (!state.manualAim && !state.orientation) void enableOrientation();
  smoothBasis = null; updateViewMode();
});
$('manual-heading').addEventListener('input', event => { state.heading = Number(event.target.value); state.manualAim = true; state.userManual = true; syncSettings(); });
$('manual-elevation').addEventListener('input', event => { state.elevation = Number(event.target.value); state.manualAim = true; state.userManual = true; syncSettings(); });
$('heading-offset').addEventListener('input', event => { state.headingOffset = Number(event.target.value); $('heading-offset-value').textContent = `${state.headingOffset > 0 ? '+' : ''}${state.headingOffset}°`; });
$('fov-input').addEventListener('input', event => { state.fov = Number(event.target.value); $('fov-value').textContent = `${state.fov}°`; });
$('min-elevation-input').addEventListener('input', event => { state.minElevation = Number(event.target.value); $('min-elevation-value').textContent = `${state.minElevation}°`; postSettings(); });
$('grid-toggle').addEventListener('change', event => { $('sky-grid').hidden = !event.target.checked; });
$('reset-view').addEventListener('click', () => {
  state.manualAim = true; state.userManual = true; state.fov = 62; state.headingOffset = 0;
  const selected = state.positions?.selected;
  state.heading = selected?.elevation >= 0 ? selected.azimuth : 0;
  state.elevation = selected?.elevation >= 0 ? clamp(selected.elevation, 5, 80) : 35;
  syncSettings(); toast('View reset. You can drag to explore again.');
});
$('alignment-button').addEventListener('click', () => openDialog('settings-dialog'));
$('labels-button').addEventListener('click', () => {
  state.labels = !state.labels;
  $('marker-layer').classList.toggle('labels-hidden', !state.labels);
  $('labels-button').classList.toggle('active', state.labels);
  $('labels-button').setAttribute('aria-pressed', String(state.labels));
  $('labels-button').setAttribute('aria-label', state.labels ? 'Hide satellite labels' : 'Show satellite labels');
});

function toggleImmersive(force) {
  state.immersive = force === undefined ? !state.immersive : force;
  document.body.classList.toggle('immersive', state.immersive);
  document.body.style.overflow = state.immersive ? 'hidden' : '';
  $('exit-immersive').hidden = !state.immersive;
  $('fullscreen-button').setAttribute('aria-label', state.immersive ? 'Exit full-screen view' : 'Enter full-screen view');
  $('fullscreen-button').setAttribute('aria-pressed', String(state.immersive));
  if (state.immersive) stage.focus({ preventScroll: true });
}
$('fullscreen-button').addEventListener('click', () => toggleImmersive());
$('exit-immersive').addEventListener('click', () => toggleImmersive(false));
$('refresh-data').addEventListener('click', () => loadCatalog(true));

let drag = null;
stage.addEventListener('pointerdown', event => {
  if (event.target.closest('button') || event.target.closest('input') || (state.cameraStream && !state.manualAim)) return;
  drag = { x: event.clientX, y: event.clientY, heading: state.heading, elevation: state.elevation };
  stage.setPointerCapture(event.pointerId); stage.classList.add('dragging');
  state.manualAim = true; state.userManual = true;
});
stage.addEventListener('pointermove', event => {
  if (!drag) return;
  state.heading = wrap(drag.heading - (event.clientX - drag.x) * 0.13);
  state.elevation = clamp(drag.elevation + (event.clientY - drag.y) * 0.13, -10, 85);
});
function endDrag() { if (!drag) return; drag = null; stage.classList.remove('dragging'); syncSettings(); }
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('wheel', event => {
  if (!event.ctrlKey && !event.shiftKey) return;
  event.preventDefault(); state.fov = clamp(state.fov + Math.sign(event.deltaY) * 3, 35, 100); syncSettings();
}, { passive: false });

window.addEventListener('keydown', event => {
  const editing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName);
  const modal = document.querySelector('dialog[open]');
  if (event.key === 'Escape' && !modal && state.immersive) { toggleImmersive(false); return; }
  if (editing || modal) return;
  if (event.key === '/') { event.preventDefault(); $('satellite-search').focus(); return; }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && (!state.cameraStream || state.manualAim)) {
    event.preventDefault(); state.manualAim = true; state.userManual = true;
    if (event.key === 'ArrowLeft') state.heading = wrap(state.heading - 3);
    if (event.key === 'ArrowRight') state.heading = wrap(state.heading + 3);
    if (event.key === 'ArrowUp') state.elevation = clamp(state.elevation + 3, -10, 85);
    if (event.key === 'ArrowDown') state.elevation = clamp(state.elevation - 3, -10, 85);
    syncSettings();
  }
});

function currentBasis() {
  const fresh = state.orientation && Date.now() - state.orientationAt < 7000;
  const sensorAiming = !state.manualAim && fresh;
  if (!sensorAiming) { smoothBasis = null; wasSensorAiming = false; return manualBasis(state.heading, state.elevation); }
  const angle = screen.orientation?.angle ?? window.orientation ?? 0;
  const target = deviceBasis(state.orientation, angle, state.headingOffset);
  if (!smoothBasis || !wasSensorAiming) smoothBasis = target;
  else {
    for (const key of ['right', 'up', 'forward']) {
      smoothBasis[key] = unit({ x: smoothBasis[key].x * 0.75 + target[key].x * 0.25, y: smoothBasis[key].y * 0.75 + target[key].y * 0.25, z: smoothBasis[key].z * 0.75 + target[key].z * 0.25 });
    }
  }
  wasSensorAiming = true;
  const look = basisLook(smoothBasis);
  state.heading = look.heading; state.elevation = look.elevation;
  return smoothBasis;
}

function resizeStage() {
  const rect = stage.getBoundingClientRect();
  stageWidth = rect.width; stageHeight = rect.height; pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(stageWidth * pixelRatio); canvas.height = Math.round(stageHeight * pixelRatio);
  canvas.style.width = `${stageWidth}px`; canvas.style.height = `${stageHeight}px`;
}
new ResizeObserver(resizeStage).observe(stage);

function filtered(item) {
  if (item.norad === state.selectedId) return true;
  if (state.filter === 'stations') return item.kind === 'station';
  if (state.filter === 'starlink') return item.kind === 'starlink';
  if (state.filter === 'highlights') return item.highlight;
  return true;
}

function interpolatedVector(item) {
  const elapsed = clamp((Date.now() - state.positions.timestamp) / 2000, 0, 1.1);
  const next = item.nextVector || item.vector;
  return unit({ x: item.vector.x + (next.x - item.vector.x) * elapsed, y: item.vector.y + (next.y - item.vector.y) * elapsed, z: item.vector.z + (next.z - item.vector.z) * elapsed });
}

function markerFor(item) {
  if (markerNodes.has(item.norad)) return markerNodes.get(item.norad);
  const button = document.createElement('button');
  button.className = 'satellite-marker';
  button.innerHTML = `<span class="marker-symbol">${icon(kindIcon(item.kind))}</span><span class="marker-info"><strong></strong><small></small></span>`;
  button.addEventListener('click', () => selectObject(item.norad));
  $('marker-layer').appendChild(button);
  markerNodes.set(item.norad, button);
  return button;
}

function drawTrail(basis) {
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, stageWidth, stageHeight);
  const trail = state.positions?.trail;
  if (!trail?.length || !state.positions.selected || state.positions.selected.elevation < -2) return;
  ctx.save();
  ctx.strokeStyle = '#c8b9faaa'; ctx.lineWidth = 1; ctx.setLineDash([3, 6]); ctx.beginPath();
  let connected = false;
  for (const point of trail) {
    const position = project(point.vector, basis, stageWidth, stageHeight, state.fov);
    if (!position || position.x < -100 || position.x > stageWidth + 100 || position.y < -100 || position.y > stageHeight + 100) { connected = false; continue; }
    if (!connected) { ctx.moveTo(position.x, position.y); connected = true; } else ctx.lineTo(position.x, position.y);
  }
  ctx.stroke(); ctx.restore();
}

function updateTargetGuide(force = false) {
  const selected = state.positions?.selected;
  if (!state.cameraStream || state.manualAim || !selected) { $('target-guide').hidden = true; return; }
  const basis = currentBasis();
  const pos = project(selected.vector, basis, stageWidth, stageHeight, state.fov);
  if (pos?.onScreen && !force) { $('target-guide').hidden = true; return; }
  const look = basisLook(basis);
  const az = ((selected.azimuth - look.heading + 540) % 360) - 180;
  const el = selected.elevation - look.elevation;
  $('target-guide').hidden = false;
  if (selected.elevation < 0) $('target-guide').textContent = `${selected.name} is below the horizon (${selected.elevation.toFixed(0)}°).`;
  else if (pos?.onScreen) $('target-guide').textContent = `${selected.name} is in your view. Alignment is approximate.`;
  else $('target-guide').textContent = `${az >= 0 ? 'Turn right' : 'Turn left'} ${Math.round(Math.abs(az))}° · ${el >= 0 ? 'tilt up' : 'tilt down'} ${Math.round(Math.abs(el))}° to ${selected.name}`;
}

function draw(now) {
  const basis = currentBasis();
  const look = basisLook(basis);
  if (now - lastReadout > 130) {
    const heading = Math.round(look.heading) % 360;
    $('heading-readout').innerHTML = `${direction(heading)} <span>${String(heading).padStart(3, '0')}°</span>`;
    $('stage-azimuth').textContent = `${String(heading).padStart(3, '0')}°`;
    $('stage-elevation').textContent = `${look.elevation >= 0 ? '+' : ''}${Math.round(look.elevation)}°`;
    $('orientation-status').textContent = !state.manualAim && state.orientation && Date.now() - state.orientationAt < 7000 ? 'Phone compass · est.' : state.cameraStream ? 'Manual aim · set alignment' : 'Manual aim';
    if (!state.cameraStream) $('preview-sky').style.backgroundPosition = `${48 + Math.sin(look.heading * Math.PI / 180) * 3}% ${70 - look.elevation * 0.2}%`;
    lastReadout = now;
    updateTargetGuide();
  }
  drawTrail(basis);
  const candidates = [];
  if (state.positions) {
    for (const item of state.positions.objects) {
      if (item.elevation < state.minElevation || !filtered(item)) continue;
      const point = project(interpolatedVector(item), basis, stageWidth, stageHeight, state.fov);
      if (!point?.onScreen || point.y > stageHeight - (state.cameraStream ? 62 : window.innerWidth < 540 ? 125 : 97)) continue;
      const score = (item.norad === state.selectedId ? 100000 : item.kind === 'station' ? 10000 : item.highlight ? 5000 : 0) - Math.hypot(point.x - stageWidth / 2, point.y - stageHeight / 2);
      candidates.push({ item, point, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const shown = [];
  const maxMarkers = stageWidth < 450 ? 6 : 10;
  const seen = new Set();
  for (const { item, point } of candidates) {
    if (shown.length >= maxMarkers) break;
    if (shown.some(other => Math.abs(other.y - point.y) < 31 && Math.abs(other.x - point.x) < (state.labels ? 145 : 32))) continue;
    shown.push(point); seen.add(item.norad);
    const node = markerFor(item);
    node.style.display = 'flex';
    node.style.left = `${point.x.toFixed(1)}px`; node.style.top = `${point.y.toFixed(1)}px`;
    const selected = item.norad === state.selectedId;
    node.className = `satellite-marker ${selected ? 'selected' : ''} ${point.x > stageWidth - 160 ? 'flipped' : ''}`;
    node.setAttribute('aria-label', `${item.name}, predicted elevation ${item.elevation.toFixed(0)} degrees, ${item.sunlit ? 'sunlit estimate' : "in Earth's shadow"}`);
    node.setAttribute('aria-pressed', String(selected));
    if (now - lastMarkerText > 600 || !node.dataset.textReady) {
      node.querySelector('strong').textContent = item.name;
      node.querySelector('small').textContent = `${item.kind === 'station' ? 'Space station' : item.kind === 'rocket' ? 'Rocket body' : item.kind === 'starlink' ? 'Communications' : 'Satellite'} · ${Math.round(item.elevation)}° above`;
      node.dataset.textReady = 'true';
    }
  }
  for (const [id, node] of markerNodes) if (!seen.has(id)) node.style.display = 'none';
  if (now - lastMarkerText > 600) lastMarkerText = now;
  $('empty-view').hidden = !state.positions || shown.length > 0;
  if (state.positions && !shown.length && state.positions.selected?.elevation < 0) {
    $('empty-view').querySelector('span').textContent = 'Your selected object is below the horizon.';
    $('empty-view').querySelector('small').textContent = 'Choose an object above you or wait for its next pass.';
  } else if (state.positions && !shown.length) {
    $('empty-view').querySelector('span').textContent = "There's more sky to explore.";
    $('empty-view').querySelector('small').textContent = 'Try another direction or select an object.';
  }
  requestAnimationFrame(draw);
}

function updateClock() {
  $('utc-time').textContent = new Date().toISOString().slice(11, 19);
  updatePassSummary();
}
updateClock(); setInterval(updateClock, 1000);
setInterval(() => loadCatalog(), 20 * 60 * 1000);
document.addEventListener('visibilitychange', () => worker.postMessage({ type: 'pause', paused: document.hidden }));
window.addEventListener('pagehide', () => { stopCamera(); worker.postMessage({ type: 'pause', paused: true }); });
window.addEventListener('pageshow', () => worker.postMessage({ type: 'pause', paused: false }));
window.addEventListener('beforeunload', () => { if (state.cameraStream) state.cameraStream.getTracks().forEach(track => track.stop()); });

resizeStage(); syncSettings(); requestAnimationFrame(draw); loadCatalog();

// Read-only diagnostics are useful for checking projection and permission flows without fabricating live objects.
window.skywardDiagnostics = () => ({
  catalogCount: state.catalog?.total || 0, propagatedCount: state.positions?.count || 0,
  aboveHorizon: state.positions?.aboveTotal || 0, selected: state.positions?.selected || null,
  observer: { ...state.observer }, locationType: state.locationType, cameraActive: !!state.cameraStream,
  manualAim: state.manualAim, orientationAvailable: !!state.orientation,
  heading: state.heading, elevation: state.elevation, fov: state.fov, workerMs: state.positions?.elapsedMs,
});
