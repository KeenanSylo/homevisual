// Apartment spec adapter. The app is built entirely from a JSON spec (see public/apartments/*/spec.json):
//   walls      [x1,z1,x2,z2] solid blocks (metres; x right, z down on the plan; y up)
//   openings   windows / balconyDoor / entrance / door: wall slot rect + direction
//   rooms      rects with floor type & ceiling height (floors, labels, tile walls, soffits)
//   kitchen    run along a wall: origin, into-room normal n, ordered items
//   fixtures   toilet, shower, basin, washer, towelRail, wardrobe, panel, stool …
//   balcony, lights, layouts, floorplan (image + scale) …
// boot.js loads the spec and sets window.__SPEC before main.js is imported.

const S = (typeof window !== 'undefined' && window.__SPEC) || null
if (!S) throw new Error('No apartment spec loaded')

export const SPEC = S
export const ID = S.id
export const CEILING = S.ceiling || 2.5
export const WALLS = S.walls || []
export const OPENINGS = (S.openings || []).map((o) => normOpening(o))
export const WINDOWS = OPENINGS.filter((o) => o.kind === 'window')
export const BALCONY_DOORS = OPENINGS.filter((o) => o.kind === 'balconyDoor')
export const ENTRANCE = OPENINGS.find((o) => o.kind === 'entrance') || null
export const DOORS = OPENINGS.filter((o) => o.kind === 'door')
export const ROOMS = (S.rooms || []).map((r) => ({ ceiling: CEILING, floor: 'parquet', label: true, ...r }))
export const INDOOR_ROOMS = ROOMS.filter((r) => r.type !== 'balcony')
export const SOFFITS = S.soffits || []
export const BALCONY = S.balcony ? { floorY: -0.05, ...S.balcony } : null
// kitchen runs (a run = cabinets along one wall); KITCHEN = the main (longest) one
export const KITCHENS = S.kitchens || (S.kitchen ? [S.kitchen] : [])
const runLen = (k) => k.items.reduce((a, i) => a + i.w, 0)
export const KITCHEN = [...KITCHENS].sort((a, b) => runLen(b) - runLen(a))[0] || null
export const FIXTURES = S.fixtures || []
export const LIGHTS = (S.lights || []).map((l) => ({ ...l, y: l.y ?? roomAt(l.x, l.z)?.ceiling ?? CEILING }))
export const LAYOUTS = S.layouts || {}
export const SAMPLE_FURNITURE = Object.values(LAYOUTS)[0]?.items || []
export const FACADE_AZIMUTH = S.facadeAzimuth ?? 180
export const FLOORPLAN = S.floorplan || null

// overall bounds (walls + balcony), used for cameras, the walk grid and the surrounding building
export const BOUNDS = (() => {
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity
  for (const w of WALLS) { x1 = Math.min(x1, w[0], w[2]); x2 = Math.max(x2, w[0], w[2]); z1 = Math.min(z1, w[1], w[3]); z2 = Math.max(z2, w[1], w[3]) }
  for (const r of ROOMS) { x1 = Math.min(x1, r.rect[0]); z1 = Math.min(z1, r.rect[1]); x2 = Math.max(x2, r.rect[2]); z2 = Math.max(z2, r.rect[3]) }
  if (!isFinite(x1)) return { x1: 0, z1: 0, x2: 6, z2: 6, cx: 3, cz: 3, w: 6, d: 6 }
  return { x1, z1, x2, z2, cx: (x1 + x2) / 2, cz: (z1 + z2) / 2, w: x2 - x1, d: z2 - z1 }
})()
export const INDOOR_BOUNDS = (() => {
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity
  for (const w of WALLS) { x1 = Math.min(x1, w[0], w[2]); x2 = Math.max(x2, w[0], w[2]); z1 = Math.min(z1, w[1], w[3]); z2 = Math.max(z2, w[1], w[3]) }
  if (!isFinite(x1)) return BOUNDS
  return { x1, z1, x2, z2, cx: (x1 + x2) / 2, cz: (z1 + z2) / 2, w: x2 - x1, d: z2 - z1 }
})()

export function roomAt(x, z, pad = 0) {
  return (S.rooms || []).map((r) => ({ ceiling: CEILING, ...r })).find((r) => x >= r.rect[0] - pad && x <= r.rect[2] + pad && z >= r.rect[1] - pad && z <= r.rect[3] + pad) || null
}
export const LIVING = ROOMS.find((r) => r.type === 'living') || [...INDOOR_ROOMS].sort((a, b) => area(b) - area(a))[0]
export const BATHROOM = ROOMS.find((r) => r.type === 'bath') || null
export function area(r) { return (r.rect[2] - r.rect[0]) * (r.rect[3] - r.rect[1]) }

// openings: derive axis, length, thickness and a local frame
//   along = unit vector along the wall, out = unit vector to the outside (windows/balcony/entrance)
//   or swing side (interior doors). frame origin = interior-face point where "along" starts.
function normOpening(o) {
  const [x1, z1, x2, z2] = o.slot
  const d = o.out || o.swing
  const alongX = d ? Math.abs(d[1]) > Math.abs(d[0]) : x2 - x1 >= z2 - z1
  const n = d || (alongX ? [0, 1] : [1, 0])
  const out = alongX ? [0, Math.sign(n[1]) || 1] : [Math.sign(n[0]) || 1, 0]
  const L = alongX ? x2 - x1 : z2 - z1, T = alongX ? z2 - z1 : x2 - x1
  // native frame: x along the wall, +z = "out", interior face at z = 0 (for windows); y up
  const theta = Math.atan2(out[0], out[1])
  const ax = [Math.cos(theta), -Math.sin(theta)] // world dir of native +x
  // interior face = side opposite to `out`
  const fx = out[0] > 0 ? x1 : out[0] < 0 ? x2 : null, fz = out[1] > 0 ? z1 : out[1] < 0 ? z2 : null
  const startX = ax[0] > 0 ? x1 : ax[0] < 0 ? x2 : fx, startZ = ax[1] > 0 ? z1 : ax[1] < 0 ? z2 : fz
  const origin = [fx ?? startX, fz ?? startZ]
  const center = [(x1 + x2) / 2, (z1 + z2) / 2]
  return { head: o.kind === 'door' || o.kind === 'entrance' ? 2.1 : 2.35, sill: 0.7, sashes: L > 1.3 ? 2 : 1, hinge: 0, ...o, x1, z1, x2, z2, alongX, out, L, T, theta, ax, origin, center }
}
// frame for any rect against a wall (balcony): x along the wall, +z outward from the wall face
export function rectFrame(rect, out) { return normOpening({ slot: rect, out }) }
// native (lx, lz) in an opening/fixture frame → world [x, z]
export function toWorld(origin, theta, lx, lz) {
  return [origin[0] + lx * Math.cos(theta) + lz * Math.sin(theta), origin[1] - lx * Math.sin(theta) + lz * Math.cos(theta)]
}
// fixture frame: back to a wall, native +z = into the room (n), native +x along the wall
export function fixtureTheta(n) { return Math.atan2(n[0], n[1]) }
