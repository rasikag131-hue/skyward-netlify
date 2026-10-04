import { propagate, gstime, eciToEcf, ecfToLookAngles, eciToGeodetic, jday, sunPos } from './assets/satellite.es.js';

export const RAD = Math.PI / 180;
export const DEG = 180 / Math.PI;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const wrap = value => ((value % 360) + 360) % 360;
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const unit = value => {
  const size = Math.hypot(value.x, value.y, value.z) || 1;
  return { x: value.x / size, y: value.y / size, z: value.z / size };
};

export function lookVector(azimuth, elevation) {
  const a = azimuth * RAD, e = elevation * RAD;
  return { x: Math.sin(a) * Math.cos(e), y: Math.cos(a) * Math.cos(e), z: Math.sin(e) };
}

export function manualBasis(heading, elevation, roll = 0) {
  const h = heading * RAD, p = elevation * RAD, r = roll * RAD;
  const right = { x: Math.cos(h), y: -Math.sin(h), z: 0 };
  const up = { x: -Math.sin(h) * Math.sin(p), y: -Math.cos(h) * Math.sin(p), z: Math.cos(p) };
  return {
    forward: lookVector(heading, elevation),
    right: { x: right.x * Math.cos(r) + up.x * Math.sin(r), y: right.y * Math.cos(r) + up.y * Math.sin(r), z: up.z * Math.sin(r) },
    up: { x: up.x * Math.cos(r) - right.x * Math.sin(r), y: up.y * Math.cos(r) - right.y * Math.sin(r), z: up.z * Math.cos(r) },
  };
}

function rotateHeading(v, offset) {
  const c = Math.cos(offset * RAD), s = Math.sin(offset * RAD);
  return { x: v.x * c + v.y * s, y: -v.x * s + v.y * c, z: v.z };
}

// W3C intrinsic Z-X-Y rotation, in the east/north/up frame. The rear camera looks down device -Z.
// iOS supplies a magnetic compass heading; Android normally supplies deviceorientationabsolute.
export function deviceBasis(event, screenAngle = 0, headingOffset = 0) {
  const hasCompass = Number.isFinite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0;
  const alpha = (hasCompass ? -event.webkitCompassHeading : (event.alpha ?? 0)) * RAD;
  const beta = (event.beta ?? 90) * RAD, gamma = (event.gamma ?? 0) * RAD;
  const ca = Math.cos(alpha), sa = Math.sin(alpha), cb = Math.cos(beta), sb = Math.sin(beta), cg = Math.cos(gamma), sg = Math.sin(gamma);
  const r = { x: ca * cg - sa * sb * sg, y: sa * cg + ca * sb * sg, z: -cb * sg };
  const u = { x: -sa * cb, y: ca * cb, z: sb };
  const forward = { x: -(ca * sg + sa * sb * cg), y: -(sa * sg - ca * sb * cg), z: -cb * cg };
  const theta = screenAngle * RAD, c = Math.cos(theta), s = Math.sin(theta);
  return {
    right: rotateHeading({ x: r.x * c - u.x * s, y: r.y * c - u.y * s, z: r.z * c - u.z * s }, headingOffset),
    up: rotateHeading({ x: r.x * s + u.x * c, y: r.y * s + u.y * c, z: r.z * s + u.z * c }, headingOffset),
    forward: rotateHeading(forward, headingOffset),
  };
}

export function basisLook(basis) {
  return { heading: wrap(Math.atan2(basis.forward.x, basis.forward.y) * DEG), elevation: Math.asin(clamp(basis.forward.z, -1, 1)) * DEG };
}

export function project(vector, basis, width, height, verticalFov = 62) {
  const depth = dot(vector, basis.forward);
  if (depth <= 0.03) return null;
  const focal = height / (2 * Math.tan(verticalFov * RAD / 2));
  const x = width / 2 + dot(vector, basis.right) / depth * focal;
  const y = height / 2 - dot(vector, basis.up) / depth * focal;
  return { x, y, onScreen: x >= 30 && x <= width - 30 && y >= 60 && y <= height - 45, depth };
}

export function solarContext(date) {
  const jd = jday(date);
  const sun = sunPos(jd).rsun;
  const vector = unit({ x: sun[0], y: sun[1], z: sun[2] });
  return { jd, gmst: gstime(date), vector };
}

// Cylindrical shadow approximation, not a prediction of apparent brightness.
export function inSunlight(position, sunDirection) {
  const along = dot(position, sunDirection);
  if (along >= 0) return true;
  const perpendicularSq = dot(position, position) - along * along;
  return perpendicularSq > 6378.137 ** 2;
}

export function observerRadians(observer) {
  return { latitude: observer.lat * RAD, longitude: observer.lng * RAD, height: (observer.altitude || 0) / 1000 };
}

export function satelliteLook(record, date, observer, context = solarContext(date)) {
  const propagated = propagate(record.satrec, date);
  if (!propagated?.position || !propagated?.velocity || record.satrec.error) return null;
  const position = propagated.position;
  if (!Number.isFinite(position.x + position.y + position.z)) return null;
  const ecf = eciToEcf(position, context.gmst);
  const look = ecfToLookAngles(observerRadians(observer), ecf);
  const geo = eciToGeodetic(position, context.gmst);
  const azimuth = wrap(look.azimuth * DEG), elevation = look.elevation * DEG;
  const velocity = propagated.velocity;
  return {
    norad: record.norad, name: record.name, kind: record.kind, mission: record.mission, highlight: record.highlight,
    azimuth, elevation, range: look.rangeSat, altitude: geo.height,
    latitude: geo.latitude * DEG, longitude: geo.longitude * DEG,
    speed: Math.hypot(velocity.x, velocity.y, velocity.z),
    sunlit: inSunlight(position, context.vector),
    elementAgeDays: context.jd - record.satrec.jdsatepoch,
    vector: lookVector(azimuth, elevation),
  };
}

export function observerSunElevation(date, observer, context = solarContext(date)) {
  const sunEcf = eciToEcf({ x: context.vector.x * 149597870.7, y: context.vector.y * 149597870.7, z: context.vector.z * 149597870.7 }, context.gmst);
  return ecfToLookAngles(observerRadians(observer), sunEcf).elevation * DEG;
}

export function nextPass(record, date, observer, hours = 6) {
  const start = date.getTime();
  let previous = satelliteLook(record, date, observer);
  if (!previous) return null;
  const currentlyAbove = previous.elevation >= 0;
  let riseAt = currentlyAbove ? start : null;
  let maxElevation = currentlyAbove ? previous.elevation : 0;
  let peakAt = start;
  for (let offset = 30000; offset <= hours * 3600000; offset += 30000) {
    const at = start + offset;
    const current = satelliteLook(record, new Date(at), observer);
    if (!current) continue;
    if (riseAt === null && previous.elevation < 0 && current.elevation >= 0) {
      riseAt = at - 30000 + 30000 * (-previous.elevation / (current.elevation - previous.elevation));
      maxElevation = current.elevation; peakAt = at;
    }
    if (riseAt !== null) {
      if (current.elevation > maxElevation) { maxElevation = current.elevation; peakAt = at; }
      if (current.elevation < 0) {
        const setAt = at - 30000 + 30000 * (previous.elevation / (previous.elevation - current.elevation));
        return { currentlyAbove, riseAt, setAt, peakAt, maxElevation };
      }
    }
    previous = current;
  }
  if (currentlyAbove) return { currentlyAbove: true, riseAt: start, setAt: null, peakAt, maxElevation };
  return null;
}

export function direction(azimuth) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(wrap(azimuth) / 45) % 8];
}
