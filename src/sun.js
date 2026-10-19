// Approximate solar position for Stockholm (59.33°N, 18.07°E).
const LAT = 59.33, LON = 18.07
const rad = Math.PI / 180

// Returns { elevation, azimuth } in degrees. Azimuth: from north, clockwise.
export function solarPosition(date, hourLocal) {
  const start = new Date(date.getFullYear(), 0, 0)
  const N = Math.floor((date - start) / 86400000)
  // Swedish DST, roughly last Sunday of March → last Sunday of October
  const dst = N >= 87 && N <= 300
  const tz = dst ? 2 : 1
  const B = (360 / 365) * (N - 81) * rad
  const decl = 23.44 * Math.sin(B) * rad
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B)
  const solar = hourLocal + (4 * (LON - 15 * tz) + eot) / 60
  const H = 15 * (solar - 12) * rad
  const phi = LAT * rad
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H)
  const el = Math.asin(sinEl)
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI
  return { elevation: el / rad, azimuth: (az / rad + 360) % 360 }
}

// Compass azimuth that world +z (down on the plan) faces — set per apartment from the spec.
export let FACADE_AZIMUTH = 225
export function setFacadeAzimuth(a) { FACADE_AZIMUTH = a }

// Unit vector pointing *toward* the sun in world coordinates.
export function sunVector(elevationDeg, azimuthDeg, out) {
  const rel = (azimuthDeg - FACADE_AZIMUTH) * rad
  const el = elevationDeg * rad
  const h = Math.cos(el)
  out.set(-Math.sin(rel) * h, Math.sin(el), Math.cos(rel) * h)
  return out
}

// World-space direction of north (for the compass)
export function northVector(out) {
  return sunVector(0, 0, out)
}
