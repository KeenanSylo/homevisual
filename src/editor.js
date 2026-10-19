// 2D floor-plan editor: upload a plan, set the scale, detect / draw walls, openings, rooms, kitchen and
// fixtures, then open it as a 3D apartment. Everything is stored as the same JSON spec the 3D app builds from.
import { hydrateIcons } from './icons.js'
import { detectWalls, detectOpenings, detectRooms, pruneWalls, gapAt, wallBounds, snapWalls } from './detect.js'
import { userGet, userPut, userDelete, slug, isPrivate, describe } from './store.js'

hydrateIcons()
const $ = (id) => document.getElementById(id)
const cv = $('cv'), ctx = cv.getContext('2d')
const r2 = (v) => Math.round(v * 100) / 100

// ------------------------------------------------------------------ state
const normalize = (s) => { s.kitchens = s.kitchens || (s.kitchen ? [s.kitchen] : []); delete s.kitchen; s.soffits ||= []; s.fixtures ||= []; s.lights ||= []; s.openings ||= []; s.rooms ||= []; s.walls ||= []; return s }
const blank = () => ({
  version: 1, id: '', name: '', address: '', summary: '', rooms_count: 1, area: 0, floor: 1, facadeAzimuth: 225, ceiling: 2.5,
  floorplan: { src: '', pxPerM: 0, origin: [0, 0] },
  walls: [], openings: [], rooms: [], soffits: [], balcony: null, kitchens: [], fixtures: [], lights: [], layouts: {},
})
let spec = blank()
let img = null, imgBlob = null
const view = { s: 1, ox: 0, oy: 0 }
let tool = 'select', sel = null, hover = null
let drag = null // { kind: 'pan'|'draw'|'move'|'resize'|'calib', … }
let calib = null // { a: [px,py], b }
const undoStack = [], redoStack = []
let dirty = false

const FIX = {
  toilet: { w: 0.4, d: 0.68, label: 'WC' }, basin: { w: 0.6, d: 0.45, label: 'Basin' }, shower: { w: 0.8, d: 0.8, corner: true, label: 'Shower' },
  washer: { w: 0.6, d: 0.6, label: 'Washer' }, towelRail: { w: 0.5, d: 0.1, label: 'Towel' }, wardrobe: { w: 0.8, d: 0.6, label: 'Wardrobe' },
  panel: { w: 0.3, d: 0.03, label: 'LC' }, stool: { w: 0.34, d: 0.34, center: true, label: 'Stool' },
}
const KITCHEN_LABEL = { fridge: 'K/F', oven: 'Oven', sink: 'Sink', dishwasher: 'DW', drawers: 'Drw', cabinet: 'Cab', pullout: '', tall: 'Tall' }

// ------------------------------------------------------------------ coordinates
const ppm = () => spec.floorplan.pxPerM || 100
const m2px = (x, z) => [spec.floorplan.origin[0] + x * ppm(), spec.floorplan.origin[1] + z * ppm()]
const px2m = (px, py) => [(px - spec.floorplan.origin[0]) / ppm(), (py - spec.floorplan.origin[1]) / ppm()]
const toScreen = (x, z) => { const [px, py] = m2px(x, z); return [view.ox + px * view.s, view.oy + py * view.s] }
const fromScreen = (sx, sy) => px2m((sx - view.ox) / view.s, (sy - view.oy) / view.s)
const mPerScreenPx = () => 1 / (ppm() * view.s)
const theta = (n) => Math.atan2(n[0], n[1])
const toWorld = (o, th, lx, lz) => [o[0] + lx * Math.cos(th) + lz * Math.sin(th), o[1] - lx * Math.sin(th) + lz * Math.cos(th)]
const aabb = (pts) => { const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] }

// footprint of anything, as an axis-aligned rect in metres
function footprint(cat, o) {
  if (cat === 'wall' || cat === 'soffit') return o.slice(0, 4)
  if (cat === 'room') return o.rect
  if (cat === 'opening') return o.slot
  if (cat === 'balcony') return o.rect
  if (cat === 'light') return [o.x - 0.12, o.z - 0.12, o.x + 0.12, o.z + 0.12]
  if (cat === 'kitchen') {
    const L = o.items.reduce((a, i) => a + i.w, 0), th = theta(o.n)
    return aabb([toWorld([o.x, o.z], th, 0, 0), toWorld([o.x, o.z], th, L, o.depth || 0.6)])
  }
  if (cat === 'fixture') {
    const f = FIX[o.type] || { w: 0.5, d: 0.5 }, w = o.w || f.w, d = o.d || f.d, th = theta(o.n || [0, 1])
    const xa = f.corner ? 0 : -w / 2, xb = f.corner ? w : w / 2, za = f.center ? -d / 2 : 0, zb = f.center ? d / 2 : d
    return aabb([toWorld([o.x, o.z], th, xa, za), toWorld([o.x, o.z], th, xb, zb)])
  }
  return null
}
function allItems() {
  const L = []
  for (const o of spec.lights) L.push({ cat: 'light', o })
  for (const o of spec.fixtures) L.push({ cat: 'fixture', o })
  for (const o of spec.kitchens) L.push({ cat: 'kitchen', o })
  for (const o of spec.openings) L.push({ cat: 'opening', o })
  for (const o of spec.walls) L.push({ cat: 'wall', o })
  if (spec.balcony) L.push({ cat: 'balcony', o: spec.balcony })
  for (const o of spec.soffits) L.push({ cat: 'soffit', o })
  for (const o of spec.rooms.filter((r) => r.type !== 'balcony')) L.push({ cat: 'room', o })
  return L
}
function pick(x, z) {
  const tol = 4 * mPerScreenPx()
  for (const it of allItems()) {
    const r = footprint(it.cat, it.o)
    if (r && x >= r[0] - tol && x <= r[2] + tol && z >= r[1] - tol && z <= r[3] + tol) return it
  }
  return null
}

// ------------------------------------------------------------------ history
const snap = () => JSON.stringify(spec)
function commit() { undoStack.push(snap()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; dirty = true }
function restore(j) { spec = JSON.parse(j); sel = null; refreshAll() }
function undo() { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()) }
function redo() { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()) }

// ------------------------------------------------------------------ image loading
async function setImage(blob, { keepSpec = false } = {}) {
  imgBlob = blob
  img = await createImageBitmap(blob)
  if (!keepSpec) { spec = blank(); sel = null }
  fit(); refreshAll()
}
function fit() {
  if (!img) return
  const r = cv.getBoundingClientRect()
  let bx = [0, 0, img.width, img.height]
  if (spec.walls.length) { // zoom to the apartment
    const b = wallBounds(spec.walls), p1 = m2px(b.x1 - 2, b.z1 - 2), p2 = m2px(b.x2 + 2, b.z2 + 2)
    bx = [p1[0], p1[1], p2[0], p2[1]]
  }
  view.s = Math.min(r.width / (bx[2] - bx[0]), r.height / (bx[3] - bx[1])) * 0.92
  view.ox = r.width / 2 - ((bx[0] + bx[2]) / 2) * view.s
  view.oy = r.height / 2 - ((bx[1] + bx[3]) / 2) * view.s
}
$('file').onchange = (e) => { const f = e.target.files[0]; if (f) newPlan(f); e.target.value = '' }
async function newPlan(f) {
  if (img && (spec.walls.length || spec.rooms.length) && !confirm('Replace the current plan? Your drawing will be cleared.')) return
  await setImage(f); undoStack.length = 0; status('Now set the scale: click Measure and click both ends of the scale bar.')
}
addEventListener('paste', (e) => { const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/')); if (it) newPlan(it.getAsFile()) })
const stage = $('stage')
stage.addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('active') })
stage.addEventListener('dragleave', () => $('drop').classList.remove('active'))
stage.addEventListener('drop', (e) => { e.preventDefault(); $('drop').classList.remove('active'); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) newPlan(f) })

// rotate the image (and everything drawn on it) by 90°
async function rotate(dir) {
  if (!img) return
  commit()
  const W = img.width, H = img.height
  const c = new OffscreenCanvas(H, W), g = c.getContext('2d')
  g.translate(H / 2, W / 2); g.rotate(dir * Math.PI / 2); g.drawImage(img, -W / 2, -H / 2)
  const blob = await c.convertToBlob({ type: 'image/png' })
  // dir = +1 (clockwise): (px, py) → (H − py, px); dir = −1: (px, py) → (py, W − px)
  const rp = ([px, py]) => (dir > 0 ? [H - py, px] : [py, W - px])
  const o = spec.floorplan.origin
  const newOrigin = rp(o)
  const vec = (d) => (dir > 0 ? [-d[1], d[0]] : [d[1], -d[0]]).map((v) => v + 0)
  // convert with the old origin, then shift into the new origin
  const S = spec
  const conv = (x, z) => { const p = rp(m2px(x, z)); return [(p[0] - newOrigin[0]) / ppm(), (p[1] - newOrigin[1]) / ppm()] }
  const convRect = (r) => { const a = conv(r[0], r[1]), b = conv(r[2], r[3]); return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].map(r2).concat(r.slice(4)) }
  S.walls = S.walls.map(convRect)
  S.soffits = S.soffits.map(convRect)
  for (const o2 of S.openings) { o2.slot = convRect(o2.slot); if (o2.out) o2.out = vec(o2.out); if (o2.swing) o2.swing = vec(o2.swing) }
  for (const r of S.rooms) { r.rect = convRect(r.rect); if (r.labelRect) r.labelRect = convRect(r.labelRect) }
  if (S.balcony) { S.balcony.rect = convRect(S.balcony.rect); S.balcony.out = vec(S.balcony.out) }
  for (const K of S.kitchens) { const p = conv(K.x, K.z); K.x = r2(p[0]); K.z = r2(p[1]); K.n = vec(K.n) }
  for (const f of S.fixtures) { const p = conv(f.x, f.z); f.x = r2(p[0]); f.z = r2(p[1]); f.n = vec(f.n || [0, 1]) }
  for (const l of S.lights) { const p = conv(l.x, l.z); l.x = r2(p[0]); l.z = r2(p[1]) }
  S.floorplan.origin = newOrigin
  S.facadeAzimuth = (((S.facadeAzimuth + (dir > 0 ? -90 : 90)) % 360) + 360) % 360
  imgBlob = blob; img = await createImageBitmap(blob)
  fit(); refreshAll()
}
$('rotL').onclick = () => rotate(-1)
$('rotR').onclick = () => rotate(1)

// ------------------------------------------------------------------ drawing
function resize() {
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1
  cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d)
  draw()
}
addEventListener('resize', resize)
const COL = {
  // recognised walls are highlighted like the flat on a listing's key plan; rooms get faint washes
  wall: 'rgba(244,196,48,0.78)', room: { living: 'rgba(244,196,48,0.13)', hall: 'rgba(104,112,105,0.12)', entry: 'rgba(104,112,105,0.12)', bath: 'rgba(61,126,166,0.14)', bedroom: 'rgba(244,196,48,0.2)', storage: 'rgba(104,112,105,0.2)', room: 'rgba(244,196,48,0.13)' },
  opening: { window: '#3d7ea6', balconyDoor: '#2c7a6b', door: '#4d7c2f', entrance: '#a4421b' },
}
function draw() {
  const d = devicePixelRatio || 1
  ctx.setTransform(d, 0, 0, d, 0, 0)
  const W = cv.width / d, H = cv.height / d
  ctx.clearRect(0, 0, W, H)
  if (!img) { $('drop').classList.remove('hidden'); return }
  $('drop').classList.add('hidden')
  ctx.save(); ctx.translate(view.ox, view.oy); ctx.scale(view.s, view.s)
  if (isPrivate() && spec.walls.length && spec.floorplan.pxPerM) {
    // only the drawing around the flat: the sheet's corner text has the address
    const b = wallBounds(spec.walls), p1 = m2px(b.x1 - 2, b.z1 - 2), p2 = m2px(b.x2 + 2, b.z2 + 2)
    ctx.beginPath(); ctx.rect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]); ctx.clip()
  }
  ctx.globalAlpha = 0.85; ctx.drawImage(img, 0, 0); ctx.globalAlpha = 1
  ctx.restore()
  const R = (r) => { const a = toScreen(r[0], r[1]), b = toScreen(r[2], r[3]); return [a[0], a[1], b[0] - a[0], b[1] - a[1]] }
  const font = (px, w = 600) => { ctx.font = `${w} ${px}px 'Schibsted Grotesk Variable', -apple-system, sans-serif` }
  // rooms
  for (const r of spec.rooms) {
    const [x, y, w, h] = R(r.rect)
    ctx.fillStyle = r.type === 'balcony' ? 'rgba(0,0,0,0)' : COL.room[r.type] || COL.room.room
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.setLineDash([4, 4]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([])
  }
  for (const s of spec.soffits) { const [x, y, w, h] = R(s); ctx.strokeStyle = 'rgba(120,60,200,0.6)'; ctx.setLineDash([8, 3, 2, 3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]) }
  // balcony
  if (spec.balcony) {
    const [x, y, w, h] = R(spec.balcony.rect)
    ctx.fillStyle = 'rgba(140,110,90,0.15)'; ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = '#8c6e5a'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h); ctx.lineWidth = 1
    arrow((spec.balcony.rect[0] + spec.balcony.rect[2]) / 2, (spec.balcony.rect[1] + spec.balcony.rect[3]) / 2, spec.balcony.out, 0.5, '#8c6e5a')
  }
  // walls
  ctx.fillStyle = COL.wall
  for (const w of spec.walls) { const [x, y, ww, hh] = R(w); ctx.fillRect(x, y, ww, hh) }
  // openings
  for (const o of spec.openings) {
    const [x, y, w, h] = R(o.slot), c = COL.opening[o.kind] || '#555'
    ctx.fillStyle = c + '55'; ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h); ctx.lineWidth = 1
    const cx = (o.slot[0] + o.slot[2]) / 2, cz = (o.slot[1] + o.slot[3]) / 2
    arrow(cx, cz, o.out || o.swing || [0, 1], 0.45, c)
    if (o.kind !== 'window') { // hinge dot
      const along = Math.abs((o.out || o.swing)[1]) > 0.5, n = o.out || o.swing
      const th = theta(n), ax = [Math.cos(th), -Math.sin(th)]
      const sx = ax[0] > 0 ? o.slot[0] : ax[0] < 0 ? o.slot[2] : cx, sz = ax[1] > 0 ? o.slot[1] : ax[1] < 0 ? o.slot[3] : cz
      const L = along ? o.slot[2] - o.slot[0] : o.slot[3] - o.slot[1]
      const hx = o.hinge === 1 ? sx + ax[0] * L : sx, hz = o.hinge === 1 ? sz + ax[1] * L : sz
      const [px, py] = toScreen(along ? hx : cx, along ? cz : hz)
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill()
    }
  }
  // kitchen
  for (const K of spec.kitchens) {
    const th = theta(K.n), dp = K.depth || 0.6
    let a = 0
    for (const it of K.items) {
      const r = aabb([toWorld([K.x, K.z], th, a, 0), toWorld([K.x, K.z], th, a + it.w, dp)])
      const [x, y, w, h] = R(r)
      ctx.fillStyle = it.type === 'fridge' || it.type === 'tall' ? 'rgba(40,90,200,0.35)' : 'rgba(40,90,200,0.2)'; ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = '#3d5a80'; ctx.strokeRect(x, y, w, h)
      font(10); ctx.fillStyle = '#1b3f8f'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      if (Math.min(Math.abs(w), Math.abs(h)) > 14) ctx.fillText(KITCHEN_LABEL[it.type] ?? it.type, x + w / 2, y + h / 2)
      a += it.w
    }
    const s = toWorld([K.x, K.z], th, 0, 0), [px, py] = toScreen(s[0], s[1])
    ctx.fillStyle = '#3d5a80'; ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill()
  }
  // fixtures
  for (const f of spec.fixtures) {
    const r = footprint('fixture', f), [x, y, w, h] = R(r)
    ctx.fillStyle = 'rgba(109,76,138,0.18)'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#6d4c8a'; ctx.strokeRect(x, y, w, h)
    font(10); ctx.fillStyle = '#5d1f8f'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(FIX[f.type]?.label || f.type, x + w / 2, y + h / 2)
    const [px, py] = toScreen(f.x, f.z); ctx.fillStyle = '#6d4c8a'; ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill()
  }
  // lights
  for (const l of spec.lights) {
    const [px, py] = toScreen(l.x, l.z)
    ctx.fillStyle = '#f4c430'; ctx.strokeStyle = '#1f2421'; ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
  }
  // room labels on top
  for (const r of spec.rooms) {
    if (r.label === false || !r.name) continue
    const [x1, z1, x2, z2] = r.labelRect || r.rect, [cx, cy] = toScreen((x1 + x2) / 2, (z1 + z2) / 2)
    font(12, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; const tw = ctx.measureText(r.name).width
    ctx.fillRect(cx - tw / 2 - 5, cy - 16, tw + 10, 32)
    ctx.fillStyle = '#1f2124'; ctx.fillText(r.name, cx, cy - 6)
    font(10.5, 500); ctx.fillStyle = '#555'
    ctx.fillText(`${((x2 - x1) * (z2 - z1)).toFixed(1)} m²${r.type === 'balcony' ? '' : ', ceiling ' + (r.ceiling ?? spec.ceiling) + ' m'}`, cx, cy + 8)
  }
  // selection
  const hl = (it, color, handles) => {
    const r = footprint(it.cat, it.o); if (!r) return
    const [x, y, w, h] = R(r)
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x - 2, y - 2, w + 4, h + 4); ctx.lineWidth = 1
    if (handles && resizable(it.cat)) for (const [hx, hy] of handlePts(r)) { const [px, py] = toScreen(hx, hy); ctx.fillStyle = '#f4c430'; ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke() }
    // dimensions
    font(11, 600); ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
    ctx.fillText(`${Math.round((r[2] - r[0]) * 100)} cm`, x + w / 2, y - 6)
    ctx.save(); ctx.translate(x - 6, y + h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(`${Math.round((r[3] - r[1]) * 100)} cm`, 0, 0); ctx.restore()
  }
  if (hover && (!sel || hover.o !== sel.o)) hl(hover, 'rgba(31,36,33,0.45)', false)
  if (sel) hl(sel, '#1f2421', true)
  // in-progress rectangle / calibration
  if (drag?.kind === 'draw') {
    const r = normRect(drag.a, drag.b), [x, y, w, h] = R(r)
    ctx.strokeStyle = '#1f2421'; ctx.setLineDash([5, 4]); ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h); ctx.setLineDash([]); ctx.lineWidth = 1
    font(11, 600); ctx.fillStyle = '#1f2421'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    ctx.fillText(`${Math.round((r[2] - r[0]) * 100)} × ${Math.round((r[3] - r[1]) * 100)} cm`, x + w + 6, y + h + 4)
  }
  if (calib?.a) {
    const a = [view.ox + calib.a[0] * view.s, view.oy + calib.a[1] * view.s], b = calib.b ? [view.ox + calib.b[0] * view.s, view.oy + calib.b[1] * view.s] : a
    ctx.strokeStyle = '#1f2421'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); ctx.lineWidth = 1
    for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, Math.PI * 2); ctx.fillStyle = '#1f2421'; ctx.fill() }
  }
  function arrow(x, z, dir, len, color) {
    const [ax, ay] = toScreen(x, z), [bx, by] = toScreen(x + dir[0] * len, z + dir[1] * len)
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
    const ang = Math.atan2(by - ay, bx - ax)
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - 8 * Math.cos(ang - 0.5), by - 8 * Math.sin(ang - 0.5)); ctx.lineTo(bx - 8 * Math.cos(ang + 0.5), by - 8 * Math.sin(ang + 0.5)); ctx.fill()
    ctx.lineWidth = 1
  }
}
let raf = 0
const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw() }) }
const resizable = (cat) => ['wall', 'room', 'opening', 'balcony', 'soffit'].includes(cat)
const handlePts = (r) => [[(r[0] + r[2]) / 2, r[1]], [r[2], (r[1] + r[3]) / 2], [(r[0] + r[2]) / 2, r[3]], [r[0], (r[1] + r[3]) / 2]]
const normRect = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].map(r2)

// ------------------------------------------------------------------ snapping
function snapVal(v, axis, exclude) {
  const tol = 7 * mPerScreenPx()
  let best = v, bd = tol
  const cand = []
  for (const w of spec.walls) if (w !== exclude) cand.push(...(axis === 'x' ? [w[0], w[2]] : [w[1], w[3]]))
  for (const r of spec.rooms) if (r.rect !== exclude && r !== exclude) cand.push(...(axis === 'x' ? [r.rect[0], r.rect[2]] : [r.rect[1], r.rect[3]]))
  for (const c of cand) { const d = Math.abs(c - v); if (d < bd) { bd = d; best = c } }
  return r2(best)
}

// ------------------------------------------------------------------ geometry helpers for placing things
// nearest wall face to a point: { n (into the room), along axis, line coordinate, face span, dist }
function nearestFace(x, z, maxD = 1.2, accept = () => true) {
  let best = null
  for (const w of spec.walls) {
    const faces = [
      { n: [0, 1], line: w[3], a1: w[0], a2: w[2], d: z - w[3], ax: 'x' }, { n: [0, -1], line: w[1], a1: w[0], a2: w[2], d: w[1] - z, ax: 'x' },
      { n: [1, 0], line: w[2], a1: w[1], a2: w[3], d: x - w[2], ax: 'z' }, { n: [-1, 0], line: w[0], a1: w[1], a2: w[3], d: w[0] - x, ax: 'z' },
    ]
    for (const f of faces) {
      const a = f.ax === 'x' ? x : z
      if (f.d < -0.02 || f.d > maxD || a < f.a1 - 0.05 || a > f.a2 + 0.05 || !accept(f)) continue
      if (!best || f.d < best.d) best = { ...f, wall: w }
    }
  }
  return best
}
const insideRoom = (x, z) => spec.rooms.find((r) => r.type !== 'balcony' && x > r.rect[0] && x < r.rect[2] && z > r.rect[1] && z < r.rect[3])
const insideWall = (x, z) => spec.walls.some((w) => x > w[0] && x < w[2] && z > w[1] && z < w[3])

function openingDir(kind, slot) {
  const alongX = slot[2] - slot[0] >= slot[3] - slot[1]
  const cx = (slot[0] + slot[2]) / 2, cz = (slot[1] + slot[3]) / 2, T = alongX ? slot[3] - slot[1] : slot[2] - slot[0]
  const dirs = alongX ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]]
  const probe = (d) => [cx + d[0] * (T / 2 + 0.35), cz + d[1] * (T / 2 + 0.35)]
  if (kind === 'door') {
    // swing into the hall / bigger room, never into the bathroom
    const score = (d) => { const r = insideRoom(...probe(d)); return !r ? -1 : r.type === 'bath' || r.type === 'storage' ? 0 : r.type === 'hall' || r.type === 'entry' ? 3 : 2 }
    return score(dirs[0]) >= score(dirs[1]) ? dirs[0] : dirs[1]
  }
  // outward: the side that isn't inside any room (or farther from the apartment's middle)
  const inA = !!insideRoom(...probe(dirs[0])), inB = !!insideRoom(...probe(dirs[1]))
  if (spec.rooms.length && inA !== inB) return inA ? dirs[1] : dirs[0]
  const b = spec.walls.length ? wallBounds(spec.walls) : { x1: cx, x2: cx, z1: cz, z2: cz }
  const mid = [(b.x1 + b.x2) / 2, (b.z1 + b.z2) / 2]
  const pa = probe(dirs[0]), pb = probe(dirs[1])
  return Math.hypot(pa[0] - mid[0], pa[1] - mid[1]) > Math.hypot(pb[0] - mid[0], pb[1] - mid[1]) ? dirs[0] : dirs[1]
}
function makeOpening(kind, slot) {
  const o = { kind, slot }
  const d = openingDir(kind, slot)
  const L = Math.max(slot[2] - slot[0], slot[3] - slot[1])
  if (kind === 'door') Object.assign(o, { name: 'Dörr', swing: d, head: 2.1, hinge: 0 })
  else if (kind === 'entrance') Object.assign(o, { out: d, head: 2.1, hinge: 0 })
  else if (kind === 'balconyDoor') Object.assign(o, { out: d, head: 2.35, hinge: 0 })
  else Object.assign(o, { out: d, sill: 0.7, head: 2.35, sashes: L > 1.3 ? 2 : 1 })
  return o
}
function kitchenItems(L) {
  const items = []
  let rest = L
  const take = (type, w) => { if (rest >= w - 1e-6) { items.push({ type, w: r2(w) }); rest = r2(rest - w) } }
  if (L >= 1.8) take('fridge', 0.6)
  take('oven', 0.6)
  const tail = []
  if (rest >= 1.2 + (L >= 3 ? 0.6 : 0)) { tail.push({ type: 'sink', w: 0.6 }); rest -= 0.6 }
  if (rest >= 1.2 && L >= 3) { tail.push({ type: 'dishwasher', w: 0.6 }); rest -= 0.6 }
  if (!tail.length && rest >= 0.6) { tail.push({ type: 'sink', w: 0.6 }); rest -= 0.6 }
  rest = r2(rest)
  if (rest > 1.0) { items.push({ type: 'drawers', w: 0.6 }); items.push({ type: 'cabinet', w: r2(rest - 0.6) }) } else if (rest >= 0.15) items.push({ type: rest < 0.3 ? 'pullout' : 'drawers', w: rest })
  return [...items, ...tail]
}
function makeKitchen(r) {
  // the long edge that's against a wall becomes the back; the run starts at one end of it
  const cx = (r[0] + r[2]) / 2, cz = (r[1] + r[3]) / 2, horiz = r[2] - r[0] >= r[3] - r[1]
  const edges = horiz ? [{ n: [0, 1], p: [cx, r[1]] }, { n: [0, -1], p: [cx, r[3]] }] : [{ n: [1, 0], p: [r[0], cz] }, { n: [-1, 0], p: [r[2], cz] }]
  const same = (e) => (f) => f.n[0] === e.n[0] && f.n[1] === e.n[1]
  const dist = (e) => { const f = nearestFace(e.p[0] + e.n[0] * 0.05, e.p[1] + e.n[1] * 0.05, 0.6, same(e)); return f ? f.d : 9 }
  const e = dist(edges[0]) <= dist(edges[1]) ? edges[0] : edges[1]
  const th = theta(e.n), ax = [Math.cos(th), -Math.sin(th)]
  const L = r2(horiz ? r[2] - r[0] : r[3] - r[1])
  const start = horiz ? [ax[0] > 0 ? r[0] : r[2], e.p[1]] : [e.p[0], ax[1] > 0 ? r[1] : r[3]]
  const f = nearestFace(start[0] + e.n[0] * 0.05, start[1] + e.n[1] * 0.05, 0.6, same(e))
  if (f) { if (horiz) start[1] = f.line; else start[0] = f.line }
  return { x: r2(start[0]), z: r2(start[1]), n: e.n, depth: 0.6, items: kitchenItems(L) }
}
function makeFixture(type, x, z) {
  const f = FIX[type], face = nearestFace(x, z, 1.5)
  if (!face) return { type, x: r2(x), z: r2(z), n: [0, 1], ...(f.corner ? { w: f.w, d: f.d } : {}) }
  let px = face.ax === 'x' ? x : face.line, pz = face.ax === 'x' ? face.line : z, n = face.n
  if (f.corner) {
    // tuck into the nearest corner: the run goes away from the perpendicular wall
    // probe just inside the room, along the wall, for the perpendicular wall closest to the click
    const ix = px + face.n[0] * 0.1, iz = pz + face.n[1] * 0.1
    const other = nearestFace(ix, iz, 3, (g) => g.ax !== face.ax)
    if (other) {
      const corner = face.ax === 'x' ? [other.line, face.line] : [face.line, other.line]
      const axOf = (nn) => { const th = theta(nn); return [Math.cos(th), -Math.sin(th)] }
      const a1 = axOf(face.n)
      n = a1[0] * other.n[0] + a1[1] * other.n[1] > 0 ? face.n : other.n
      px = corner[0]; pz = corner[1]
    }
    return { type, x: r2(px), z: r2(pz), n, w: f.w, d: f.d }
  }
  if (f.center) return { type, x: r2(x), z: r2(z), n }
  const o = { type, x: r2(px), z: r2(pz), n }
  if (type === 'wardrobe') Object.assign(o, { w: f.w, d: f.d, style: 'hinged', doors: 2 })
  if (type === 'washer') o.w = f.w
  return o
}

// ------------------------------------------------------------------ pointer interaction
let space = false
cv.addEventListener('pointerdown', (e) => {
  if (!img) return
  cv.setPointerCapture(e.pointerId)
  const rect = cv.getBoundingClientRect(), sx = e.clientX - rect.left, sy = e.clientY - rect.top
  const m = fromScreen(sx, sy)
  if (e.button === 1 || e.button === 2 || space || tool === 'pan') { drag = { kind: 'pan', sx, sy, ox: view.ox, oy: view.oy }; return }
  if (tool === 'calib') {
    const p = [(sx - view.ox) / view.s, (sy - view.oy) / view.s]
    if (!calib || calib.b) calib = { a: p, b: null }
    else { calib.b = p; finishCalib() }
    redraw(); return
  }
  if (!spec.floorplan.pxPerM) { status('Set the scale first (step 2).'); return }
  if (tool === 'select') {
    // handle?
    if (sel && resizable(sel.cat)) {
      const r = footprint(sel.cat, sel.o)
      const hi = handlePts(r).findIndex(([hx, hz]) => { const [px, py] = toScreen(hx, hz); return Math.hypot(px - sx, py - sy) < 9 })
      if (hi >= 0) { commit(); drag = { kind: 'resize', edge: hi, it: sel }; return }
    }
    const it = pick(m[0], m[1])
    select(it)
    if (it) { commit(); drag = { kind: 'move', it, start: m, orig: JSON.parse(JSON.stringify(it.o)), moved: false } }
    else drag = { kind: 'pan', sx, sy, ox: view.ox, oy: view.oy }
    return
  }
  if (tool === 'light') { commit(); const l = { x: r2(m[0]), z: r2(m[1]), kind: 'spot' }; spec.lights.push(l); select({ cat: 'light', o: l }); refreshAll(); return }
  if (tool === 'fixture') { commit(); const f = makeFixture($('fixType').value, m[0], m[1]); spec.fixtures.push(f); select({ cat: 'fixture', o: f }); refreshAll(); return }
  drag = { kind: 'draw', a: [snapVal(m[0], 'x'), snapVal(m[1], 'z')], b: [snapVal(m[0], 'x'), snapVal(m[1], 'z')], sx, sy }
})
cv.addEventListener('pointermove', (e) => {
  const rect = cv.getBoundingClientRect(), sx = e.clientX - rect.left, sy = e.clientY - rect.top
  const m = fromScreen(sx, sy)
  $('hud').textContent = img && spec.floorplan.pxPerM ? `${m[0].toFixed(2)}, ${m[1].toFixed(2)} m` : ''
  if (!drag) {
    if (tool === 'select' && img) { const h = pick(m[0], m[1]); if (h?.o !== hover?.o) { hover = h; redraw() } }
    if (tool === 'calib' && calib?.a && !calib.b) { calib.tmp = [(sx - view.ox) / view.s, (sy - view.oy) / view.s]; calib.b = null; drawCalibPreview(calib.tmp) }
    return
  }
  if (drag.kind === 'pan') { view.ox = drag.ox + sx - drag.sx; view.oy = drag.oy + sy - drag.sy; redraw(); return }
  if (drag.kind === 'draw') { drag.b = [snapVal(m[0], 'x'), snapVal(m[1], 'z')]; redraw(); return }
  if (drag.kind === 'move') {
    const dx = m[0] - drag.start[0], dz = m[1] - drag.start[1]
    if (!drag.moved && Math.hypot(dx, dz) < 3 * mPerScreenPx()) return
    drag.moved = true
    moveItem(drag.it, drag.orig, dx, dz); redraw(); renderProps(); return
  }
  if (drag.kind === 'resize') {
    const r = footprint(drag.it.cat, drag.it.o).slice(), k = drag.edge
    if (k === 0) r[1] = Math.min(snapVal(m[1], 'z', drag.it.o), r[3] - 0.02)
    if (k === 2) r[3] = Math.max(snapVal(m[1], 'z', drag.it.o), r[1] + 0.02)
    if (k === 3) r[0] = Math.min(snapVal(m[0], 'x', drag.it.o), r[2] - 0.02)
    if (k === 1) r[2] = Math.max(snapVal(m[0], 'x', drag.it.o), r[0] + 0.02)
    setRect(drag.it, r); redraw(); renderProps()
  }
})
function drawCalibPreview(p) { draw(); const a = [view.ox + calib.a[0] * view.s, view.oy + calib.a[1] * view.s], b = [view.ox + p[0] * view.s, view.oy + p[1] * view.s]; ctx.strokeStyle = '#1f2421'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); ctx.setLineDash([]) }
cv.addEventListener('pointerup', (e) => {
  if (!drag) return
  const d = drag; drag = null
  if (d.kind === 'move' && !d.moved) undoStack.pop()
  if (d.kind === 'draw') {
    const r = normRect(d.a, d.b), small = Math.hypot(e.offsetX - d.sx, e.offsetY - d.sy) < 6
    const isOpening = ['window', 'balconyDoor', 'door', 'entrance'].includes(tool)
    if (isOpening) {
      const slot = small ? gapAt(spec.walls, d.a[0], d.a[1]) : r
      if (!slot) { status('No gap in a wall there. Click right inside the opening between two walls, or drag its outline.'); redraw(); return }
      commit(); const o = makeOpening(tool, slot.map(r2)); spec.openings.push(o); select({ cat: 'opening', o })
    } else if (!small) {
      commit()
      if (tool === 'wall') { const w = r; spec.walls.push(w); select({ cat: 'wall', o: w }) }
      else if (tool === 'room') { const o = { id: 'room' + Date.now().toString(36), name: 'Rum', type: 'room', rect: r, floor: 'parquet', ceiling: spec.ceiling }; spec.rooms.push(o); select({ cat: 'room', o }) }
      else if (tool === 'balcony') {
        const b = spec.walls.length ? wallBounds(spec.walls) : null
        const out = !b ? [0, 1] : r[1] >= b.z2 - 0.1 ? [0, 1] : r[3] <= b.z1 + 0.1 ? [0, -1] : r[0] >= b.x2 - 0.1 ? [1, 0] : [-1, 0]
        spec.balcony = { rect: r, out, sideWall: 'none', floorY: -0.05 }; select({ cat: 'balcony', o: spec.balcony })
      } else if (tool === 'kitchen') { const k = makeKitchen(r); spec.kitchens.push(k); select({ cat: 'kitchen', o: k }) }
      else if (tool === 'soffit') { const s = [...r, 2.3]; spec.soffits.push(s); select({ cat: 'soffit', o: s }) }
    }
    refreshAll()
  }
  redraw()
})
cv.addEventListener('contextmenu', (e) => e.preventDefault())
cv.addEventListener('wheel', (e) => {
  e.preventDefault()
  const rect = cv.getBoundingClientRect(), sx = e.clientX - rect.left, sy = e.clientY - rect.top
  if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 40 && e.deltaMode === 0 && !e.deltaX && Number.isInteger(e.deltaY)) {
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))
    view.ox = sx - (sx - view.ox) * k; view.oy = sy - (sy - view.oy) * k; view.s *= k
  } else { view.ox -= e.deltaX; view.oy -= e.deltaY }
  redraw()
}, { passive: false })

function moveItem(it, orig, dx, dz) {
  const sx = (v) => r2(v + dx), sz = (v) => r2(v + dz)
  const o = it.o
  if (it.cat === 'wall' || it.cat === 'soffit') { o[0] = sx(orig[0]); o[1] = sz(orig[1]); o[2] = sx(orig[2]); o[3] = sz(orig[3]) }
  else if (it.cat === 'room' || it.cat === 'balcony') o.rect = [sx(orig.rect[0]), sz(orig.rect[1]), sx(orig.rect[2]), sz(orig.rect[3])]
  else if (it.cat === 'opening') o.slot = [sx(orig.slot[0]), sz(orig.slot[1]), sx(orig.slot[2]), sz(orig.slot[3])]
  else { o.x = sx(orig.x); o.z = sz(orig.z) }
}
function setRect(it, r) {
  r = r.map(r2)
  if (it.cat === 'wall' || it.cat === 'soffit') { for (let i = 0; i < 4; i++) it.o[i] = r[i] }
  else if (it.cat === 'room' || it.cat === 'balcony') it.o.rect = r
  else if (it.cat === 'opening') it.o.slot = r
}

// ------------------------------------------------------------------ keyboard
addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return
  if (e.code === 'Space') { space = true; cv.style.cursor = 'grab'; e.preventDefault() }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
  if (e.key === 'Delete' || e.key === 'Backspace') { removeSel(); e.preventDefault() }
  if (e.key === 'Escape') { calib = null; select(null); setTool('select') }
  const keys = { v: 'select', w: 'wall', o: 'window', d: 'door', r: 'room', k: 'kitchen', f: 'fixture', l: 'light', b: 'balcony' }
  if (!e.metaKey && !e.ctrlKey && keys[e.key]) setTool(keys[e.key])
})
addEventListener('keyup', (e) => { if (e.code === 'Space') { space = false; cv.style.cursor = '' } })

// ------------------------------------------------------------------ tools & panels
const TIPS = {
  select: 'Click anything to select it. Drag to move, drag the dots to resize, Delete to remove. Drag empty space to pan, scroll to zoom.',
  pan: 'Drag to move around, scroll / pinch to zoom.',
  wall: 'Drag a rectangle over a wall in the drawing. Edges snap to other walls.',
  window: 'Click inside a window gap in the wall (or drag its outline). The arrow points outside.',
  balconyDoor: 'Click inside the balcony-door gap. The arrow points outside.',
  door: 'Click inside an inner door gap. The arrow shows which way it swings; flip it in the panel.',
  entrance: 'Click inside the front-door gap. The arrow points out to the stairwell.',
  room: 'Drag a rectangle for a room (L-shaped rooms = two rectangles; name only one).',
  balcony: 'Drag the balcony outline.',
  kitchen: 'Drag over the kitchen counter, along its wall. The fridge goes at the end with the dot. Reverse it in the panel.',
  fixture: 'Pick a type, then click right next to the wall it stands against.',
  light: 'Click where a ceiling lamp should go.',
  calib: 'Click both ends of the scale bar (or any known length).',
}
function setTool(t) {
  tool = t
  document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t))
  $('calib').classList.toggle('on', t === 'calib')
  $('toolTip').textContent = TIPS[t] || ''
  cv.style.cursor = t === 'select' ? '' : t === 'pan' ? 'grab' : 'crosshair'
  hover = null; redraw()
}
document.querySelectorAll('#tools button').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)))
$('fixType').onchange = () => setTool('fixture')
$('calib').onclick = () => { if (!img) return status('Upload a plan first.'); calib = null; setTool('calib'); status('Click one end of the scale bar…') }
function finishCalib() {
  const px = Math.hypot(calib.b[0] - calib.a[0], calib.b[1] - calib.a[1])
  const v = prompt('How long is that in metres? (e.g. 5 for the 0–5 m scale bar)', '5')
  const m = parseFloat((v || '').replace(',', '.'))
  if (!(m > 0)) { calib = null; redraw(); return }
  commit()
  const old = spec.floorplan.pxPerM
  spec.floorplan.pxPerM = Math.round((px / m) * 100) / 100
  if (old && old !== spec.floorplan.pxPerM) rescale(old / spec.floorplan.pxPerM)
  calib = null; setTool('select'); refreshAll()
  status(`Scale set: ${spec.floorplan.pxPerM} px per metre. Now press “Detect automatically”.`)
}
// keep drawn things on the drawing when the scale changes
function rescale(k) {
  const R = (r) => r.map((v, i) => (i < 4 ? r2(v * k) : v))
  spec.walls = spec.walls.map(R); spec.soffits = spec.soffits.map(R)
  for (const o of spec.openings) o.slot = R(o.slot)
  for (const r of spec.rooms) r.rect = R(r.rect)
  if (spec.balcony) spec.balcony.rect = R(spec.balcony.rect)
  for (const p of [...spec.fixtures, ...spec.lights, ...spec.kitchens]) { p.x = r2(p.x * k); p.z = r2(p.z * k) }
  for (const K of spec.kitchens) for (const i of K.items) i.w = r2(i.w * k)
}

$('auto').onclick = async () => {
  if (!img) return status('Upload a plan first.')
  if (!spec.floorplan.pxPerM) return status('Set the scale first (step 2). Detection needs to know how big a metre is.')
  if ((spec.walls.length || spec.rooms.length) && !confirm('Replace walls, openings and rooms with the detected ones?')) return
  status('Detecting…'); await new Promise((r) => setTimeout(r, 30))
  commit()
  const t0 = performance.now()
  const res = autoDetect()
  status(`Found ${res.walls} walls, ${res.openings} openings, ${res.rooms} rooms in ${Math.round(performance.now() - t0)} ms. Check the arrows & names, then add the kitchen and bathroom fixtures.`)
  fit(); refreshAll()
}
function imageData() {
  const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d')
  g.fillStyle = '#fff'; g.fillRect(0, 0, img.width, img.height); g.drawImage(img, 0, 0)
  return g.getImageData(0, 0, img.width, img.height)
}
function autoDetect() {
  const o = spec.floorplan.origin, k = ppm()
  const walls = detectWalls(imageData(), k).map((w) => [r2(w[0] - o[0] / k), r2(w[1] - o[1] / k), r2(w[2] - o[0] / k), r2(w[3] - o[1] / k)])
  spec.walls = snapWalls(walls)
  spec.openings = detectOpenings(spec.walls)
  spec.walls = pruneWalls(spec.walls, spec.openings)
  const rooms = detectRooms(spec.walls, spec.openings, { ceiling: spec.ceiling })
  spec.rooms = [...rooms]
  spec.walls.push(...rooms.shafts)
  // re-aim windows/doors now that rooms exist (balcony doors: an exterior gap next to the balcony)
  for (const op of spec.openings) {
    const d = openingDir(op.kind, op.slot)
    if (op.kind === 'door') op.swing = d; else op.out = d
  }
  syncBalconyRoom()
  return { walls: spec.walls.length, openings: spec.openings.length, rooms: spec.rooms.filter((r) => r.label !== false).length }
}
function syncBalconyRoom() {
  spec.rooms = spec.rooms.filter((r) => r.type !== 'balcony')
  if (spec.balcony) spec.rooms.push({ id: 'balcony', name: 'Balkong', type: 'balcony', rect: spec.balcony.rect.slice(), floor: 'none' })
}

function select(it) { sel = it; renderProps(); redraw() }
function removeSel() {
  if (!sel) return
  commit()
  const { cat, o } = sel
  if (cat === 'wall') spec.walls = spec.walls.filter((x) => x !== o)
  if (cat === 'soffit') spec.soffits = spec.soffits.filter((x) => x !== o)
  if (cat === 'room') spec.rooms = spec.rooms.filter((x) => x !== o)
  if (cat === 'opening') spec.openings = spec.openings.filter((x) => x !== o)
  if (cat === 'fixture') spec.fixtures = spec.fixtures.filter((x) => x !== o)
  if (cat === 'light') spec.lights = spec.lights.filter((x) => x !== o)
  if (cat === 'kitchen') spec.kitchens = spec.kitchens.filter((x) => x !== o)
  if (cat === 'balcony') spec.balcony = null
  select(null); refreshAll()
}
$('del').onclick = removeSel
$('dup').onclick = () => {
  if (!sel || sel.cat === 'balcony') return
  commit()
  const c = JSON.parse(JSON.stringify(sel.o))
  moveItem({ cat: sel.cat, o: c }, JSON.parse(JSON.stringify(c)), 0.3, 0.3)
  const arr = { wall: spec.walls, soffit: spec.soffits, room: spec.rooms, opening: spec.openings, fixture: spec.fixtures, light: spec.lights, kitchen: spec.kitchens }[sel.cat]
  arr.push(c); select({ cat: sel.cat, o: c }); refreshAll()
}

// properties form for the selection
function renderProps() {
  const box = $('props'), body = $('propsBody')
  if (!sel) { box.classList.add('hidden'); return }
  box.classList.remove('hidden')
  const { cat, o } = sel
  const T = { wall: 'Wall', room: 'Room', opening: 'Opening', fixture: 'Fixture', kitchen: 'Kitchen', light: 'Ceiling lamp', balcony: 'Balcony', soffit: 'Lowered ceiling' }
  $('propsTitle').textContent = cat === 'opening' ? { window: 'Window', balconyDoor: 'Balcony door', door: 'Door', entrance: 'Front door' }[o.kind] : cat === 'fixture' ? (FIX[o.type]?.label || o.type) : T[cat]
  const f = []
  const num = (key, label, step = 0.01, get = () => o[key], set = (v) => (o[key] = v)) => f.push({ html: `<label class="col">${label}<input type="number" step="${step}" data-k="${key}" value="${get()}"></label>`, key, set })
  const sel_ = (key, label, opts, get = () => o[key], set = (v) => (o[key] = v)) => f.push({ html: `<label class="col">${label}<select data-k="${key}">${opts.map(([v, t]) => `<option value="${v}" ${String(get()) === String(v) ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`, key, set, select: true })
  const txt = (key, label, get = () => o[key] ?? '', set = (v) => (o[key] = v)) => f.push({ html: `<label class="col">${label}<input type="text" data-k="${key}" value="${String(get()).replace(/"/g, '&quot;')}"></label>`, key, set, text: true })
  const btns = []
  const btn = (label, fn) => btns.push({ label, fn })
  if (cat === 'wall' || cat === 'soffit') {
    ;['x1', 'z1', 'x2', 'z2'].forEach((k, i) => num(k, `${k} m`, 0.01, () => o[i], (v) => (o[i] = v)))
    if (cat === 'soffit') num('h', 'Ceiling here m', 0.05, () => o[4], (v) => (o[4] = v))
  }
  if (cat === 'room') {
    txt('name', 'Name')
    sel_('type', 'Type', [['living', 'Living / kitchen'], ['bedroom', 'Bedroom'], ['hall', 'Hall'], ['entry', 'Entry'], ['bath', 'Bathroom'], ['storage', 'Storage'], ['room', 'Other room']])
    sel_('floor', 'Floor', [['parquet', 'Parquet'], ['tile', 'Tiles'], ['bath', 'Bathroom tiles']])
    num('ceiling', 'Ceiling height m', 0.05, () => o.ceiling ?? spec.ceiling)
    sel_('label', 'Show label', [['true', 'Yes'], ['false', 'No (part of another room)']], () => o.label !== false, (v) => (o.label = v === 'true'))
  }
  if (cat === 'opening') {
    sel_('kind', 'Kind', [['window', 'Window'], ['balconyDoor', 'Balcony door'], ['door', 'Inner door'], ['entrance', 'Front door']], () => o.kind, (v) => {
      const n = makeOpening(v, o.slot); for (const k of Object.keys(o)) delete o[k]; Object.assign(o, n)
    })
    if (o.kind === 'window') { num('sill', 'Sill height m (BH)', 0.05); num('head', 'Top m', 0.05); sel_('sashes', 'Panes', [[1, '1'], [2, '2'], [3, '3']], () => o.sashes, (v) => (o.sashes = +v)) }
    else { num('head', 'Height m', 0.05) }
    if (o.kind === 'door') { txt('name', 'Name'); sel_('open', 'Starts', [['false', 'Closed'], ['true', 'Open']], () => !!o.open, (v) => (o.open = v === 'true')) }
    btn(o.kind === 'door' ? 'Swing other way' : 'Flip in/out', () => { if (o.swing) o.swing = o.swing.map((v) => -v); if (o.out) o.out = o.out.map((v) => -v) })
    if (o.kind !== 'window') btn('Hinge other side', () => (o.hinge = o.hinge === 1 ? 0 : 1))
  }
  if (cat === 'fixture') {
    sel_('type', 'Type', Object.entries(FIX).map(([k, v]) => [k, v.label]))
    if (['shower', 'wardrobe', 'washer'].includes(o.type)) num('w', 'Width m', 0.01, () => o.w ?? FIX[o.type].w)
    if (['shower', 'wardrobe'].includes(o.type)) num('d', 'Depth m', 0.01, () => o.d ?? FIX[o.type].d)
    if (o.type === 'wardrobe') { sel_('style', 'Doors', [['hinged', 'Hinged'], ['sliding', 'Sliding'], ['tall', 'Single tall']]); num('doors', 'Number of doors', 1, () => o.doors ?? 2) }
    btn('Turn 90°', () => { const n = o.n || [0, 1]; o.n = [n[1], -n[0]] })
  }
  if (cat === 'kitchen') {
    txt('items', 'Units in order (type width), from the dot', () => o.items.map((i) => `${i.type} ${i.w}`).join(', '), (v) => {
      const items = v.split(',').map((s) => s.trim().split(/\s+/)).filter((p) => p[0]).map(([t, w]) => ({ type: t, w: parseFloat(w) || 0.6 }))
      if (items.length) o.items = items
    })
    num('depth', 'Depth m', 0.01, () => o.depth ?? 0.6)
    btn('Reverse order', () => {
      const L = o.items.reduce((a, i) => a + i.w, 0), th = theta(o.n), end = toWorld([o.x, o.z], th, L, 0)
      o.x = r2(end[0]); o.z = r2(end[1]); o.n = [-o.n[0], -o.n[1]]
      // keep the back against the same wall: shift to the opposite side of the footprint
      const back = toWorld([o.x, o.z], theta(o.n), 0, -(o.depth || 0.6)); o.x = r2(back[0]); o.z = r2(back[1])
      o.items.reverse()
    })
    btn('Refill for this length', () => { o.items = kitchenItems(o.items.reduce((a, i) => a + i.w, 0)) })
  }
  if (cat === 'light') sel_('kind', 'Kind', [['spot', 'Ceiling spot'], ['pendant', 'Pendant (over a table)'], ['dome', 'Dome (bathroom)']])
  if (cat === 'balcony') {
    // 'left' / 'right' in the spec = start / end of the balcony along the façade; name them by plan direction
    const th = theta(o.out), ax = [Math.round(Math.cos(th)), Math.round(-Math.sin(th))]
    const dirName = (d) => (d[0] < 0 ? 'left' : d[0] > 0 ? 'right' : d[1] < 0 ? 'top' : 'bottom') + ' on the plan'
    sel_('sideWall', 'Solid side wall', [['none', 'None (railings)'], ['left', `On the ${dirName([-ax[0], -ax[1]])}`], ['right', `On the ${dirName(ax)}`], ['both', 'Both sides']])
    btn('Flip outward side', () => { o.out = o.out.map((v) => -v) })
  }
  body.innerHTML = f.map((x) => x.html).join('') + (btns.length ? `<div class="row wrap">${btns.map((b, i) => `<button data-b="${i}">${b.label}</button>`).join('')}</div>` : '')
  for (const x of f) {
    const el = body.querySelector(`[data-k="${x.key}"]`)
    el.addEventListener('change', () => {
      commit()
      const v = x.select || x.text ? el.value : parseFloat(el.value)
      if (!x.select && !x.text && !Number.isFinite(v)) return
      x.set(v)
      if (cat === 'room' && x.key === 'type') { o.floor = v === 'bath' ? 'bath' : v === 'entry' ? 'tile' : o.floor === 'bath' ? 'parquet' : o.floor; if (v === 'bath') o.ceiling = Math.min(o.ceiling ?? spec.ceiling, 2.3) }
      if (cat === 'balcony') syncBalconyRoom()
      refreshAll(); renderProps()
    })
  }
  body.querySelectorAll('[data-b]').forEach((b) => (b.onclick = () => { commit(); btns[+b.dataset.b].fn(); refreshAll(); renderProps() }))
}

// ------------------------------------------------------------------ meta + save
function computeSummary() {
  const indoor = spec.rooms.filter((r) => r.type !== 'balcony')
  const area = indoor.reduce((a, r) => a + (r.rect[2] - r.rect[0]) * (r.rect[3] - r.rect[1]), 0)
  const rooms = Math.max(1, spec.rooms.filter((r) => ['living', 'bedroom', 'room'].includes(r.type) && r.label !== false).length)
  spec.area = Math.round(area * 10) / 10; spec.rooms_count = rooms
  spec.summary = `${rooms} rok, ${spec.area} m², ${spec.floor ? 'floor ' + spec.floor : 'ground floor'}`
}
function refreshAll() {
  computeSummary()
  $('title').textContent = isPrivate() && spec.name ? describe(spec).title : spec.name || 'New apartment'
  document.body.classList.toggle('address-hidden', isPrivate())
  $('mName').value = spec.name; $('mAddr').value = spec.address || ''
  $('mFloor').value = spec.floor ?? 1; $('mCeil').value = spec.ceiling
  $('mFacing').value = String(((Math.round(spec.facadeAzimuth / 45) * 45) % 360 + 360) % 360)
  $('scaleInfo').textContent = spec.floorplan.pxPerM ? `${spec.floorplan.pxPerM} px / m` : 'not set'
  const done = { 1: !!img, 2: !!spec.floorplan.pxPerM, 3: spec.walls.length > 0, 4: spec.rooms.length > 0, 5: !!spec.name }
  document.querySelectorAll('#steps section[data-step]').forEach((s) => s.classList.toggle('done', !!done[s.dataset.step]))
  redraw()
}
$('mName').onchange = (e) => { commit(); spec.name = e.target.value.trim(); refreshAll() }
$('mAddr').onchange = (e) => { commit(); spec.address = e.target.value.trim() }
$('mFloor').onchange = (e) => { commit(); spec.floor = Math.max(0, parseInt(e.target.value) || 0); refreshAll() }
$('mCeil').onchange = (e) => {
  commit(); const old = spec.ceiling; spec.ceiling = parseFloat(e.target.value) || 2.5
  for (const r of spec.rooms) if (r.ceiling === old || r.ceiling == null) r.ceiling = r.type === 'bath' ? Math.min(2.3, spec.ceiling) : spec.ceiling
  refreshAll()
}
$('mFacing').onchange = (e) => { commit(); spec.facadeAzimuth = parseInt(e.target.value) }
$('undo').onclick = undo
$('redo').onclick = redo
function status(t) { $('status').textContent = t }

function problems() {
  const p = []
  if (!img) p.push('upload a floor plan')
  if (!spec.floorplan.pxPerM) p.push('set the scale')
  if (!spec.walls.length) p.push('add walls')
  if (!spec.rooms.filter((r) => r.type !== 'balcony').length) p.push('add at least one room')
  return p
}
async function save() {
  const p = problems()
  if (p.length) { status('Before saving: ' + p.join(', ') + '.'); return null }
  if (!spec.name) { const n = prompt('Name this apartment', 'My apartment'); if (!n) return null; spec.name = n.trim() }
  computeSummary(); syncBalconyRoom()
  if (!spec.id) spec.id = slug(spec.name) + '-' + Date.now().toString(36).slice(-4)
  const out = structuredClone(spec); delete out.kitchen
  out.floorplan.src = '' // the image is stored next to it
  await userPut({ id: spec.id, spec: out, plan: imgBlob })
  dirty = false
  history.replaceState(null, '', `?apt=${encodeURIComponent(spec.id)}`)
  status('Saved.'); refreshAll()
  return spec.id
}
$('save').onclick = save
$('open3d').onclick = async () => { const id = await save(); if (id) location.href = `/app.html?apt=${encodeURIComponent(id)}` }
$('export').onclick = () => {
  computeSummary()
  const out = structuredClone(spec); delete out.kitchen; out.floorplan.src = 'plan.png'
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }))
  a.download = `${spec.id || slug(spec.name || 'apartment')}.json`; a.click()
}
addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = '' } })

// ------------------------------------------------------------------ start: ?apt=id edits an existing apartment
async function boot() {
  resize(); setTool('select')
  const q = new URLSearchParams(location.search), id = q.get('apt')
  if (q.get('pending')) { // a plan dropped on the home page
    const pend = await userGet('__pending').catch(() => null)
    history.replaceState(null, '', location.pathname)
    if (pend?.plan) { await userDelete('__pending'); await setImage(pend.plan); status('Now set the scale: click Measure, then both ends of the scale bar.'); return }
  }
  if (!id) { refreshAll(); return }
  const u = await userGet(id).catch(() => null)
  if (u) { spec = normalize({ ...blank(), ...structuredClone(u.spec) }); await setImage(u.plan, { keepSpec: true }); return status('Editing your saved apartment.') }
  const r = await fetch(`/apartments/${id}/spec.json`)
  if (!r.ok) return status('Apartment not found.')
  const s = await r.json()
  const blob = await fetch(s.floorplan.src).then((x) => x.blob())
  spec = normalize({ ...blank(), ...s })
  await setImage(blob, { keepSpec: true })
  status('Editing a built-in apartment. Saving makes your own copy.')
}
addEventListener('hemma-private', () => refreshAll())
boot()
// debug / automation handle
window.__ed = { get spec() { return spec }, set spec(v) { spec = normalize(v); refreshAll() }, setImage, autoDetect, makeOpening, makeKitchen, makeFixture, gapAt: (x, z) => gapAt(spec.walls, x, z), save, refreshAll, fit, view, commit, syncBalconyRoom }
