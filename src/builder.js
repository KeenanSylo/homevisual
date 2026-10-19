import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import * as P from './plan.js'
import { tiles, speckle, heightToNormal, tex } from './textures.js'

// ---------------------------------------------------------------- materials
export function makeMaterials(maxAniso) {
  const std = (o) => new THREE.MeshStandardMaterial(o)
  // standard PBR everywhere (MeshPhysical costs ~2× per pixel for effects we don't use)
  const phys = (o) => { const { sheen, sheenRoughness, sheenColor, clearcoat, clearcoatRoughness, transmission, ...rest } = o; return new THREE.MeshStandardMaterial(rest) }
  const T = (p, o = {}) => tex(p, { aniso: maxAniso, ...o })
  const tileSet = (o) => { const t = tiles(o); return { map: t.map, normalMap: heightToNormal(t.bumpMap, 3) } }
  const bathWall = tileSet({ tw: 0.2, th: 0.4, nx: 5, ny: 3, base: [40, 6, 95], vary: 1, groutColor: '#d9d8d3' })
  const bathFloor = tileSet({ tw: 0.1, th: 0.1, nx: 10, ny: 10, base: [45, 3, 56], vary: 2.5, groutColor: '#b4b3ad', grout: 0.003 })
  const hallFloor = tileSet({ tw: 0.2, th: 0.4, nx: 5, ny: 3, base: [40, 4, 74], vary: 2, groutColor: '#9d9c97', grout: 0.003 })
  const splash = tileSet({ tw: 0.3, th: 0.6, nx: 4, ny: 2, base: [40, 4, 95], vary: 0.8, groutColor: '#dad9d4' })
  const radiator = tileSet({ tw: 1, th: 0.033, nx: 1, ny: 12, base: [40, 3, 95], vary: 0, groutColor: '#c9c9c5', grout: 0.006, ppm: 300 })
  const stone = speckle({ base: '#6d7579', dots: 'rgba(20,25,30,0.35)', metres: 0.5, ppm: 400, n: 9000 })
  const render = speckle({ base: '#dcc8b4', dots: 'rgba(80,50,30,0.06)', metres: 2, ppm: 128, n: 6000 })
  const plasterN = T('/tex/painted_plaster_wall_nor_gl_1k.jpg', { metres: [1.6, 1.6] })
  const plasterR = T('/tex/painted_plaster_wall_rough_1k.jpg', { metres: [1.6, 1.6] })
  const oakMap = T('/tex/oak_diffuse_1k.jpg', { srgb: true, metres: [0.5, 0.5] })
  const oakN = T('/tex/oak_nor_gl_1k.jpg', { metres: [0.5, 0.5] })
  const wallPaint = (color) => std({ color, roughness: 0.95, normalMap: plasterN, normalScale: new THREE.Vector2(0.12, 0.12), roughnessMap: plasterR })

  const M = {
    paint: wallPaint('#e6e3dc'), // NCS S 1002-Y
    white: wallPaint('#f3f3f1'), // NCS S 0500-N (ceiling)
    trim: std({ color: '#f6f6f4', roughness: 0.45 }),
    cabinet: phys({ color: '#f2f2ef', roughness: 0.42 }),
    counter: std({ color: '#eeede8', roughness: 0.5 }),
    plinth: std({ color: '#e9e9e5', roughness: 0.6 }),
    steel: std({ color: '#c9ccce', metalness: 1, roughness: 0.28 }),
    steelDark: std({ color: '#8b8f93', metalness: 1, roughness: 0.38 }),
    chrome: std({ color: '#ffffff', metalness: 1, roughness: 0.06 }),
    blackGlass: phys({ color: '#0c0c0e', roughness: 0.06 }),
    porcelain: phys({ color: '#fcfcfb', roughness: 0.12 }),
    glass: phys({ color: '#ffffff', roughness: 0.0, metalness: 0, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.6 }),
    mirror: std({ color: '#ffffff', metalness: 1, roughness: 0.02 }),
    cap: std({ color: '#2a2c30', roughness: 0.95 }),
    slab: std({ color: '#d9d6d0', roughness: 0.95 }),
    concrete: std({ color: '#a9a7a2', roughness: 0.95 }),
    door: phys({ color: '#f3f3f0', roughness: 0.35 }),
    entryDoor: std({ color: '#5f6366', roughness: 0.55 }),
    rubber: std({ color: '#222326', roughness: 0.8 }),
    parquet: phys({
      map: T('/tex/parquet_diff.jpg', { srgb: true, metres: [1.2, 2.4] }),
      normalMap: T('/tex/parquet_nor.jpg', { metres: [1.2, 2.4] }), normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: T('/tex/parquet_rough.jpg', { metres: [1.2, 2.4] }), roughness: 0.42,
    }),
    oak: phys({ map: oakMap, normalMap: oakN, roughness: 0.42 }),
    bathWall: phys({ ...bathWall, roughness: 0.1 }),
    bathFloor: std({ ...bathFloor, roughness: 0.55 }),
    hallFloor: std({ ...hallFloor, roughness: 0.45 }),
    splash: phys({ ...splash, roughness: 0.15 }),
    radiator: std({ ...radiator, roughness: 0.35 }),
    stone: std({ map: stone, roughness: 0.3 }),
    render: std({ map: render, roughness: 0.95 }),
    balcony: std({ color: '#cbb29e', roughness: 0.55, metalness: 0.2 }), // beige-pink panels
    deck: std({ color: '#9d9a95', roughness: 0.9 }),
    curtain: phys({
      color: '#f1ece3', map: T('/tex/rough_linen_gray.jpg', { srgb: true, metres: [0.27, 0.27] }),
      normalMap: T('/tex/rough_linen_nor_gl_1k.jpg', { metres: [0.27, 0.27] }), normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.95, sheen: 1, sheenRoughness: 0.7, sheenColor: new THREE.Color('#f3eee6'),
      side: THREE.DoubleSide, transparent: true, opacity: 0.86, emissive: new THREE.Color('#2a2622'),
    }),
    hidden: new THREE.MeshBasicMaterial({ visible: false }),
    sinkSteel: std({ color: '#d9dcde', metalness: 1, roughness: 0.22, side: THREE.DoubleSide }),
    fridgeSteel: std({ color: '#c8cbcd', metalness: 1, roughness: 0.34 }),
    ovenWindow: std({ color: '#18191b', roughness: 0.05, metalness: 0.3 }),
    hob: std({ map: hobTexture(), roughness: 0.06, metalness: 0.1 }),
    blackMatte: std({ color: '#151515', roughness: 0.45 }),
    amberGlass: phys({ color: '#c98a2a', roughness: 0.05, transparent: true, opacity: 0.8 }),
    ceramic: std({ color: '#ebe6dc', roughness: 0.35 }),
    apple: std({ color: '#7c9a3c', roughness: 0.4 }),
    appliance: std({ color: '#f7f7f6', roughness: 0.28 }),
    applianceGrey: std({ color: '#b9bcbf', roughness: 0.35, metalness: 0.4 }),
    washerGlass: phys({ color: '#2b3236', roughness: 0.05, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    drain: std({ map: drainTexture(), color: '#ffffff', metalness: 1, roughness: 0.3 }),
    towel: fabricMat(T, '#5f5a54', 'waffle_pique_cotton', 0.16),
    towelSmall: fabricMat(T, '#6c6964', 'waffle_pique_cotton', 0.12),
    towelWhite: fabricMat(T, '#f4f3f0', 'waffle_pique_cotton', 0.14),
    teaTowel: fabricMat(T, '#e8e3da', 'rough_linen', 0.16),
    led: new THREE.MeshStandardMaterial({ color: '#fff3e0', emissive: '#ffd9a8', emissiveIntensity: 0 }),
    lampShade: new THREE.MeshStandardMaterial({ color: '#f1efea', roughness: 0.6, emissive: '#ffd6a0', emissiveIntensity: 0, side: THREE.DoubleSide }),
    washerScreen: new THREE.MeshStandardMaterial({ color: '#1a2830', emissive: '#2a9bd6', emissiveIntensity: 0.6 }),
  }
  return M
}

function fabricMat(T, color, file, size) {
  const m = [size, size]
  const c = new THREE.Color(color)
  return new THREE.MeshStandardMaterial({
    color: c, map: T(`/tex/${file}_gray.jpg`, { srgb: true, metres: m }),
    normalMap: T(`/tex/${file}_nor_gl_1k.jpg`, { metres: m }), normalScale: new THREE.Vector2(1, 1),
    roughness: 0.95, side: THREE.DoubleSide,
  })
}
function hobTexture() {
  // black glass with faint printed cooking zones, 0.55 x 0.57 m
  const c = document.createElement('canvas'); c.width = 512; c.height = 512
  const g = c.getContext('2d')
  g.fillStyle = '#0b0b0c'; g.fillRect(0, 0, 512, 512)
  g.strokeStyle = 'rgba(160,160,160,0.35)'; g.lineWidth = 3
  for (const [x, y, r] of [[150, 150, 95], [370, 150, 75], [150, 370, 75], [370, 370, 95]]) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(x, y, r * 0.55, 0, Math.PI * 2); g.globalAlpha = 0.5; g.stroke(); g.globalAlpha = 1 }
  g.fillStyle = 'rgba(200,200,200,0.4)'
  for (let i = 0; i < 6; i++) g.fillRect(200 + i * 22, 486, 12, 4)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}
function drainTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256
  const g = c.getContext('2d')
  g.fillStyle = '#cfd2d4'; g.fillRect(0, 0, 256, 256)
  g.fillStyle = '#26282a'
  for (let y = 0; y < 13; y++) for (let x = 0; x < 13; x++) {
    const px = 22 + x * 17.7, py = 22 + y * 17.7
    if (Math.hypot(px - 128, py - 128) < 108) { g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2); g.fill() }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

// planar world UVs (1 unit = 1 m) by dominant normal
export function worldUV(geo) {
  const pos = geo.attributes.position, nor = geo.attributes.normal
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i))
    let u, v
    if (ax >= ay && ax >= az) { u = nor.getX(i) > 0 ? -z : z; v = y }
    else if (ay >= az) { u = x; v = z }
    else { u = nor.getZ(i) > 0 ? x : -x; v = y }
    uv[i * 2] = u; uv[i * 2 + 1] = v
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return geo
}

// --------------------------------------------------------------- builder
// Everything is generated from the apartment spec (plan.js). Fixtures and openings are modelled in a
// local "native" frame and placed with a rotation about y:
//   fixtures: back against a wall at z = 0, room toward +z, x along the wall
//   openings: x along the wall from the frame origin, interior face at z = 0, +z = outside / swing side
export function buildApartment(M, { cut = Infinity, ceilings = true, curtains = true } = {}) {
  const root = new THREE.Group(); root.name = 'apartment'
  const colliders = []
  const doors = []
  const anchors = {} // light positions etc. for main.js
  let parent = root
  // current frame (local → world): origin + rotation about y
  let T = { ox: 0, oz: 0, c: 1, s: 0 }
  const tw = (lx, lz) => [T.ox + lx * T.c + lz * T.s, T.oz - lx * T.s + lz * T.c]
  function pushCol(x1, z1, x2, z2) {
    const a = tw(x1, z1), b = tw(x2, z2)
    colliders.push({ x1: Math.min(a[0], b[0]), z1: Math.min(a[1], b[1]), x2: Math.max(a[0], b[0]), z2: Math.max(a[1], b[1]) })
  }
  function inFrame(origin, theta, fn) {
    const g = new THREE.Group(); g.position.set(origin[0], 0, origin[1]); g.rotation.y = theta; g.userData.frame = true
    root.add(g)
    const prevP = parent, prevT = T
    parent = g; T = { ox: origin[0], oz: origin[1], c: Math.cos(theta), s: Math.sin(theta) }
    try { fn() } finally { parent = prevP; T = prevT }
  }
  const ceilAt = (x, z) => P.roomAt(x, z)?.ceiling ?? P.CEILING

  const add = (mesh, { cast = true, receive = true } = {}) => {
    mesh.castShadow = cast; mesh.receiveShadow = receive; parent.add(mesh); return mesh
  }

  function box(x1, z1, x2, z2, y1, y2, mat, o = {}) {
    if (x1 > x2) [x1, x2] = [x2, x1]
    if (z1 > z2) [z1, z2] = [z2, z1]
    if (o.collide !== false && y1 < 1.6 && y2 > 0.25) pushCol(x1, z1, x2, z2)
    const top = Math.min(y2, cut)
    if (top - y1 < 0.0005) return null
    const g = new THREE.BoxGeometry(x2 - x1, top - y1, z2 - z1)
    g.translate((x1 + x2) / 2, (y1 + top) / 2, (z1 + z2) / 2)
    worldUV(g)
    const m = y2 > cut + 1e-4 && o.cap !== false ? [mat, mat, M.cap, mat, mat, mat] : mat
    return add(new THREE.Mesh(g, m), o)
  }

  function rbox(cx, cy, cz, w, h, d, r, mat, o = {}) {
    if (cy - h / 2 >= cut) return null
    const g = new RoundedBoxGeometry(w, h, d, 3, r)
    const m = new THREE.Mesh(g, mat); m.position.set(cx, cy, cz)
    if (o.rotY) m.rotation.y = o.rotY
    return add(m, o)
  }

  function cyl(cx, cy, cz, r1, r2, h, mat, o = {}) {
    if (cy - h / 2 >= cut) return null
    const g = new THREE.CylinderGeometry(r1, r2, h, o.seg || 24)
    const m = new THREE.Mesh(g, mat); m.position.set(cx, cy, cz)
    if (o.rx) m.rotation.x = o.rx
    if (o.rz) m.rotation.z = o.rz
    return add(m, o)
  }

  // axis-aligned quad: axis 'x' (plane x=c, spans z a1..a2), 'z' (plane z=c, spans x), 'y' (floor/ceiling)
  function quad(axis, c, a1, a2, b1, b2, dir, mat, o = {}) {
    if (axis !== 'y') { b2 = Math.min(b2, cut); if (b2 - b1 < 0.0005) return null }
    else if (c > cut) return null
    if (a2 - a1 < 0.0005 || b2 - b1 < 0.0005) return null
    const g = new THREE.PlaneGeometry(a2 - a1, b2 - b1)
    const m4 = new THREE.Matrix4()
    if (axis === 'x') m4.makeRotationY(dir > 0 ? Math.PI / 2 : -Math.PI / 2)
    else if (axis === 'z') m4.makeRotationY(dir > 0 ? 0 : Math.PI)
    else m4.makeRotationX(dir > 0 ? -Math.PI / 2 : Math.PI / 2)
    g.applyMatrix4(m4)
    const am = (a1 + a2) / 2, bm = (b1 + b2) / 2
    if (axis === 'x') g.translate(c, bm, am)
    else if (axis === 'z') g.translate(am, bm, c)
    else g.translate(am, c, bm)
    worldUV(g)
    return add(new THREE.Mesh(g, mat), { cast: false, ...o })
  }

  // --------------------------------------------------------------- shape helpers
  function tube(curveOrPts, r, mat, o = {}) {
    const curve = Array.isArray(curveOrPts) ? new THREE.CatmullRomCurve3(curveOrPts.map((p) => new THREE.Vector3(...p)), !!o.closed, 'centripetal') : curveOrPts
    const g = new THREE.TubeGeometry(curve, o.seg || 48, r, o.radial || 10, !!o.closed)
    const bb = new THREE.Box3().setFromBufferAttribute(g.attributes.position)
    if (bb.min.y >= cut) return null
    return add(new THREE.Mesh(g, mat), o)
  }
  // polyline with rounded corners (radius r) as a CurvePath
  function rounded(pts, r) {
    const V = pts.map((p) => new THREE.Vector3(...p))
    const path = new THREE.CurvePath()
    let start = V[0]
    for (let i = 1; i < V.length - 1; i++) {
      const a = V[i - 1], b = V[i], c = V[i + 1]
      const da = a.clone().sub(b), dc = c.clone().sub(b)
      const rr = Math.min(r, da.length() / 2, dc.length() / 2)
      const p1 = b.clone().add(da.normalize().multiplyScalar(rr)), p2 = b.clone().add(dc.normalize().multiplyScalar(rr))
      path.add(new THREE.LineCurve3(start, p1))
      path.add(new THREE.QuadraticBezierCurve3(p1, b, p2))
      start = p2
    }
    path.add(new THREE.LineCurve3(start, V[V.length - 1]))
    return path
  }
  function lathe(profile, x, y, z, mat, o = {}) {
    const g = new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), o.seg || 48)
    if (o.sx || o.sz) g.scale(o.sx || 1, 1, o.sz || 1)
    if (o.rx) g.rotateX(o.rx)
    if (o.rz) g.rotateZ(o.rz)
    g.translate(x, y, z)
    const bb = new THREE.Box3().setFromBufferAttribute(g.attributes.position)
    if (bb.min.y >= cut) return null
    return add(new THREE.Mesh(g, mat), o)
  }
  // bow ("bygel") handle on a front facing +x (along z) or facing +z (along x)
  function bowX(xf, zc, yc, len, vertical = false, mat = M.chrome) {
    const L = len / 2, d = 0.032
    const pts = vertical
      ? [[xf, yc - L, zc], [xf + d, yc - L, zc], [xf + d, yc + L, zc], [xf, yc + L, zc]]
      : [[xf, yc, zc - L], [xf + d, yc, zc - L], [xf + d, yc, zc + L], [xf, yc, zc + L]]
    return tube(rounded(pts, 0.012), 0.0055, mat, { seg: 40, radial: 8, cast: false })
  }
  function bowZ(zf, xc, yc, len, vertical = false, mat = M.chrome) {
    const L = len / 2, d = 0.032
    const pts = vertical
      ? [[xc, yc - L, zf], [xc, yc - L, zf + d], [xc, yc + L, zf + d], [xc, yc + L, zf]]
      : [[xc - L, yc, zf], [xc - L, yc, zf + d], [xc + L, yc, zf + d], [xc + L, yc, zf]]
    return tube(rounded(pts, 0.012), 0.0055, mat, { seg: 40, radial: 8, cast: false })
  }
  // double wall socket (Swedish "vägguttag"): on a wall facing +x (socketX) or +z (socketZ)
  function socketX(x, z, y, dir = 1, n = 2) {
    const w = 0.075 * n
    box(x, z - w / 2, x + 0.012 * dir, z + w / 2, y - 0.04, y + 0.04, M.trim, { collide: false, cast: false })
    for (let i = 0; i < n; i++) cyl(x + 0.013 * dir, y, z - w / 2 + 0.0375 + i * 0.075, 0.019, 0.019, 0.004, M.plinth, { rz: Math.PI / 2, cast: false })
  }
  function socketZ(x, y, n = 2) {
    const w = 0.075 * n
    box(x - w / 2, 0, x + w / 2, 0.012, y - 0.04, y + 0.04, M.trim, { collide: false, cast: false })
    for (let i = 0; i < n; i++) cyl(x - w / 2 + 0.0375 + i * 0.075, y, 0.013, 0.019, 0.019, 0.004, M.plinth, { rx: Math.PI / 2, cast: false })
  }
  // fabric hanging over a horizontal bar along axis (drape both sides)
  function drapedTowel(cx, cy, cz, along, width, hangA, hangB, mat) {
    const segs = 30
    const g = new THREE.PlaneGeometry(width, hangA + hangB + 0.05, 10, segs)
    const p = g.attributes.position
    const total = hangA + hangB + 0.05
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i), v = (p.getY(i) + total / 2) // 0..total from one end
      let y, d
      if (v < hangA) { y = -(hangA - v); d = -0.022 }
      else if (v < hangA + 0.05) { const t = (v - hangA) / 0.05 * Math.PI; y = Math.sin(t) * 0.022; d = -Math.cos(t) * 0.022 }
      else { y = -(v - hangA - 0.05); d = 0.022 }
      const wob = Math.sin(u * 23 + v * 9) * 0.003 + Math.sin(v * 31) * 0.002
      d += Math.sign(d) * wob
      if (along === 'x') p.setXYZ(i, u, y, d); else p.setXYZ(i, d, y, u)
    }
    g.computeVertexNormals(); g.translate(cx, cy, cz); worldUV(g)
    const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true
    if (cy - hangA < cut) parent.add(m)
    return m
  }
  // plane with plain 0..1 UVs (printed textures: hob, drain)
  function decal(x1, z1, x2, z2, y, mat) {
    if (y > cut) return null
    const g = new THREE.PlaneGeometry(x2 - x1, z2 - z1); g.rotateX(-Math.PI / 2); g.translate((x1 + x2) / 2, y, (z1 + z2) / 2)
    return add(new THREE.Mesh(g, mat), { cast: false })
  }

  const floorMat = (f) => (f === 'tile' ? M.hallFloor : f === 'bath' ? M.bathFloor : f === 'none' ? null : M.parquet)
  const indoor = P.INDOOR_ROOMS

  // ---------------------------------------------------------------- shell
  for (const r of indoor) box(r.rect[0], r.rect[1], r.rect[2], r.rect[3], -0.25, -0.004, M.slab, { collide: false, cast: false })
  for (const w of P.WALLS) box(w[0], w[1], w[2], w[3], -0.25, -0.004, M.slab, { collide: false, cast: false })
  for (const o of P.OPENINGS) box(o.x1, o.z1, o.x2, o.z2, -0.25, -0.004, M.slab, { collide: false, cast: false })
  // floor finishes per room (rooms don't overlap → no z-fighting)
  for (const r of indoor) { const m = floorMat(r.floor); if (m) quad('y', 0, r.rect[0], r.rect[2], r.rect[1], r.rect[3], 1, m) }
  // floor in door openings: tiles if either side is tiled/bath, else the inside room's floor
  for (const o of P.OPENINGS) {
    if (o.kind !== 'door' && o.kind !== 'entrance') continue
    const a = P.toWorld(o.origin, o.theta, o.L / 2, -0.1), b = P.toWorld(o.origin, o.theta, o.L / 2, o.T + 0.1)
    const ra = P.roomAt(a[0], a[1]), rb = o.kind === 'door' ? P.roomAt(b[0], b[1]) : null
    const f = [ra?.floor, rb?.floor].includes('bath') ? 'bath' : [ra?.floor, rb?.floor].includes('tile') ? 'tile' : ra?.floor || 'parquet'
    const m = floorMat(f); if (m) quad('y', 0, o.x1, o.x2, o.z1, o.z2, 1, m)
  }

  for (const w of P.WALLS) box(w[0], w[1], w[2], w[3], 0, P.CEILING, M.paint)

  // ceilings (+ lowered parts as soffit boxes, so the steps have faces)
  if (ceilings) {
    for (const r of indoor) {
      quad('y', P.CEILING, r.rect[0], r.rect[2], r.rect[1], r.rect[3], -1, M.white, { receive: true })
      if (r.ceiling < P.CEILING - 0.01) box(r.rect[0], r.rect[1], r.rect[2], r.rect[3], r.ceiling, P.CEILING, M.white, { collide: false, cast: false })
    }
    for (const s of P.SOFFITS) box(s[0], s[1], s[2], s[3], s[4], P.CEILING, M.white, { collide: false, cast: false })
  }

  // --------------------------------------------------------------- doors
  function makeDoor({ name, pivot, closedDir, len, t, h, mat, glass = false, handleSide = 1 }) {
    const g = new THREE.Group(); g.name = name
    g.position.set(pivot[0], 0, pivot[1])
    const base = Math.atan2(-closedDir[1], closedDir[0])
    g.rotation.y = base
    const leaf = new THREE.Group(); g.add(leaf)
    const prev = parent, prevT = T; parent = leaf; T = { ox: 0, oz: 0, c: 1, s: 0 }
    if (glass) {
      const s = 0.075
      box(0.005, -t / 2, len, t / 2, 0.01, s + 0.1, mat, { collide: false })
      box(0.005, -t / 2, len, t / 2, h - s, h, mat, { collide: false })
      box(0.005, -t / 2, 0.005 + s, t / 2, 0.01, h, mat, { collide: false })
      box(len - s, -t / 2, len, t / 2, 0.01, h, mat, { collide: false })
      quad('z', 0, 0.005 + s, len - s, s + 0.1, h - s, 1, M.glass, { receive: false })
      box(len - 0.045, t / 2, len - 0.03, t / 2 + 0.035, 1.0, 1.14, M.trim, { collide: false })
    } else {
      box(0.005, -t / 2, len, t / 2, 0.008, h, mat, { collide: false })
      for (const sd of [1, -1]) {
        const zf = sd * (t / 2)
        cyl(len - 0.07, 1.02, zf + sd * 0.006, 0.026, 0.026, 0.012, M.steel, { rx: Math.PI / 2 })
        box(len - 0.19, zf + sd * 0.012, len - 0.065, zf + sd * 0.032, 1.01, 1.03, M.steel, { collide: false })
      }
    }
    parent = prev; T = prevT
    root.add(g)
    g.traverse((o) => { o.userData.door = g })
    const d = { name, group: g, base, open: false, angle: 0, target: 0, openAngle: -Math.PI / 2 * 0.97 * handleSide }
    const ex = pivot[0] + closedDir[0] * len, ez = pivot[1] + closedDir[1] * len
    d.len = len; d.pivot = pivot
    d.collider = { x1: Math.min(pivot[0], ex) - 0.03, x2: Math.max(pivot[0], ex) + 0.03, z1: Math.min(pivot[1], ez) - 0.03, z2: Math.max(pivot[1], ez) + 0.03 }
    g.userData.doorState = d
    doors.push(d)
    return d
  }
  // a door leaf hung in opening o: pivot at native (px, pz), swinging toward native +z
  function hangDoor(o, { px, pz, len, ...rest }) {
    const hinge1 = o.hinge === 1
    const pv = P.toWorld(o.origin, o.theta, hinge1 ? o.L - px : px, pz)
    const tip = P.toWorld(o.origin, o.theta, hinge1 ? o.L - px - len : px + len, pz)
    const d = [(tip[0] - pv[0]) / len, (tip[1] - pv[1]) / len]
    const sw = [Math.sin(o.theta), Math.cos(o.theta)] // world dir of native +z
    const handleSide = Math.abs(-d[1] - sw[0]) + Math.abs(d[0] - sw[1]) < 0.1 ? 1 : -1
    return makeDoor({ pivot: pv, closedDir: d, len, handleSide, ...rest })
  }

  // --------------------------------------------------------------- openings
  const FW = 0.055
  for (const o of P.OPENINGS) {
    const { L, T: TH } = o
    const fz1 = TH * 0.414, fz2 = TH * 0.629 // frame depth within the wall (as in the 0.37 m façade)
    inFrame(o.origin, o.theta, () => {
      box(0, 0, L, TH, o.head, P.CEILING, M.paint) // header
      if (o.kind === 'window') {
        box(0, 0, L, TH, 0, o.sill - 0.03, M.paint, { collide: true })
        box(0, fz1, FW, fz2, o.sill, o.head, M.trim, { collide: false })
        box(L - FW, fz1, L, fz2, o.sill, o.head, M.trim, { collide: false })
        box(0, fz1, L, fz2, o.head - FW, o.head, M.trim, { collide: false })
        box(0, fz1, L, fz2, o.sill, o.sill + FW, M.trim, { collide: false })
        const n = o.sashes, inner = (L - 2 * FW) / n
        for (let i = 0; i < n; i++) {
          const sx1 = FW + i * inner, sx2 = sx1 + inner
          const s = 0.06, y1 = o.sill + FW, y2 = o.head - FW
          box(sx1, fz1 - 0.012, sx1 + s, fz1 + 0.05, y1, y2, M.trim, { collide: false })
          box(sx2 - s, fz1 - 0.012, sx2, fz1 + 0.05, y1, y2, M.trim, { collide: false })
          box(sx1, fz1 - 0.012, sx2, fz1 + 0.05, y2 - s, y2, M.trim, { collide: false })
          box(sx1, fz1 - 0.012, sx2, fz1 + 0.05, y1, y1 + s + 0.01, M.trim, { collide: false })
          quad('z', fz1 + 0.02, sx1 + s, sx2 - s, y1 + s, y2 - s, 1, M.glass, { receive: false })
          const hx = n === 2 ? (i === 0 ? sx2 - 0.03 : sx1 + 0.03) : sx2 - 0.03
          box(hx - 0.008, fz1 - 0.04, hx + 0.008, fz1 - 0.012, (y1 + y2) / 2 - 0.06, (y1 + y2) / 2 + 0.06, M.trim, { collide: false })
        }
        // interior stone sill, exterior metal sill
        box(-0.02, -0.035, L + 0.02, fz1, o.sill - 0.03, o.sill, M.stone, { collide: false })
        box(0, fz2, L, TH + 0.04, o.sill - 0.02, o.sill, M.steelDark, { collide: false })
        // slim panel radiator low under the window
        if (o.radiator !== false && o.sill > 0.35) {
          const rw = Math.min(L - 0.25, 0.8), rc = L / 2
          box(rc - rw / 2, -0.1, rc + rw / 2, -0.035, 0.2, Math.min(0.5, o.sill - 0.1), M.radiator, { collide: true })
          box(rc + rw / 2 + 0.02, -0.075, rc + rw / 2 + 0.04, -0.055, 0, 0.32, M.trim, { collide: false })
          box(rc - rw / 2 - 0.04, -0.075, rc - rw / 2 - 0.02, -0.055, 0, 0.32, M.trim, { collide: false })
        }
      } else if (o.kind === 'balconyDoor') {
        box(0, fz1, 0.05, fz2, 0, o.head, M.trim, { collide: false })
        box(L - 0.05, fz1, L, fz2, 0, o.head, M.trim, { collide: false })
        box(0, fz1, L, fz2, o.head - 0.05, o.head, M.trim, { collide: false })
        box(0, 0, L, fz2, 0, 0.03, M.trim, { collide: false, cast: false })
      } else if (o.kind === 'entrance') {
        // frame trims (foder) on the inside + oak threshold
        box(-0.06, -0.012, 0, 0, 0, o.head + 0.06, M.trim, { collide: false })
        box(L, -0.012, L + 0.06, 0, 0, o.head + 0.06, M.trim, { collide: false })
        box(-0.06, -0.012, L + 0.06, 0, o.head, o.head + 0.06, M.trim, { collide: false })
        box(0, 0, L, TH, 0, 0.012, M.oak, { collide: false, cast: false })
      } else if (o.kind === 'door') {
        const back = P.toWorld(o.origin, o.theta, L / 2, -0.15), backRoom = P.roomAt(back[0], back[1])
        const sides = backRoom?.type === 'bath' ? [[TH, TH + 0.012]] : [[TH, TH + 0.012], [-0.012, 0]]
        for (const [za, zb] of sides) {
          box(-0.06, za, 0, zb, 0, o.head + 0.06, M.trim, { collide: false })
          box(L, za, L + 0.06, zb, 0, o.head + 0.06, M.trim, { collide: false })
          box(-0.06, za, L + 0.06, zb, o.head, o.head + 0.06, M.trim, { collide: false })
        }
      }
    })
    if (o.kind === 'entrance') {
      hangDoor(o, { name: 'Ytterdörr', px: 0.05, pz: TH - 0.035, len: L - 0.102, t: 0.055, h: o.head - 0.03, mat: M.entryDoor })
    } else if (o.kind === 'door') {
      const d = hangDoor(o, { name: o.name || 'Dörr', px: 0.04, pz: TH - 0.029, len: L - 0.088, t: 0.04, h: o.head - 0.04, mat: M.door })
      d.open = !!o.open
    } else if (o.kind === 'balconyDoor') {
      hangDoor(o, { name: 'Balkongdörr', px: 0.055, pz: fz1 + 0.03, len: L - 0.11, t: 0.06, h: o.head - 0.09, mat: M.trim, glass: true })
    }
  }

  // --------------------------------------------------------------- kitchen (HTH white, Bosch steel)
  // spec: origin on the wall where the run starts, n = into the room, items in order along the wall.
  // Built in a frame with the wall at x = 0, cabinets toward +x and the run going toward −z.
  for (const K of P.KITCHENS) {
    const kx = 0, depth = K.depth || 0.6, kf = kx + depth
    const ct = K.counterTop || 0.91, upperBottom = K.upperBottom || 1.45, upperDepth = K.upperDepth || 0.35
    const gap = 0.0025, FT = 0.019, PL = 0.1
    const fx = kf - FT, fF = kf, cf = kf + 0.02
    const frontX = (x, z1, z2, y1, y2, mat = M.cabinet) => box(x, z1 + gap, x + FT, z2 - gap, y1 + gap, y2 - gap, mat, { collide: false })
    let cum = 0
    const items = K.items.map((it) => { const r = { ...it, z1: -(cum + it.w), z2: -cum }; cum += it.w; return r })
    const theta = P.fixtureTheta(K.n) - Math.PI / 2
    const kc = P.toWorld([K.x, K.z], theta, depth / 2, -cum / 2), CEIL = ceilAt(kc[0], kc[1])
    inFrame([K.x, K.z], theta, () => {
      // contiguous base runs between tall units
      const runs = []
      let cur = null
      for (const it of items) {
        if (it.type === 'fridge' || it.type === 'tall') { cur = null; continue }
        if (!cur) { cur = { z1: it.z1, z2: it.z2, items: [] }; runs.push(cur) }
        cur.z1 = Math.min(cur.z1, it.z1); cur.z2 = Math.max(cur.z2, it.z2); cur.items.push(it)
      }
      for (const run of runs) {
        const b0 = run.z1, b1 = run.z2
        box(kx, b0, kf - 0.07, b1, 0, PL, M.plinth)
        box(kx, b0, fx, b1, PL, ct - 0.03, M.cabinet)
        const sink = run.items.find((i) => i.type === 'sink')
        // worktop (30 mm) with the sink cut-out
        if (sink) {
          const sz1 = sink.z1 + 0.07, sz2 = sink.z2 - 0.07, sx1 = kx + 0.13, sx2 = kf - 0.07
          box(kx, b0, cf, sz1, ct - 0.03, ct, M.counter)
          box(kx, sz2, cf, b1, ct - 0.03, ct, M.counter)
          box(kx, sz1, sx1, sz2, ct - 0.03, ct, M.counter)
          box(sx2, sz1, cf, sz2, ct - 0.03, ct, M.counter)
        } else box(kx, b0, cf, b1, ct - 0.03, ct, M.counter)
        // backsplash: large portrait tiles, white gloss
        quad('x', kx + 0.003, b0, b1, ct, upperBottom, 1, M.splash)
        if (b1 - b0 > 0.9) { socketX(kx + 0.003, b0 + 0.45, upperBottom - 0.09, 1, 2); socketX(kx + 0.003, b1 - 0.24, upperBottom - 0.09, 1, 2) }
        // wall cabinets to the ceiling (takanslutning): main doors + top boxes
        const ux = kx + upperDepth
        box(kx, b0, ux - FT, b1, upperBottom, CEIL, M.cabinet, { collide: false })
        const doorsN = Math.max(1, Math.round((b1 - b0) / 0.5)), dw = (b1 - b0) / doorsN, splitY = Math.min(2.36, CEIL - 0.3)
        for (let i = 0; i < doorsN; i++) {
          const z1 = b0 + i * dw, z2 = z1 + dw
          frontX(ux - FT, z1, z2, upperBottom, splitY)
          frontX(ux - FT, z1, z2, splitY, CEIL - 0.004)
          bowX(ux, i % 2 ? z1 + 0.035 : z2 - 0.035, upperBottom + 0.1, 0.128, true)
        }
        // light profile under the wall cabinets (white aluminium with an LED diffuser)
        box(kx + 0.18, b0 + 0.02, kx + 0.3, b1 - 0.02, upperBottom - 0.022, upperBottom, M.trim, { collide: false, cast: false })
        const led = quad('y', upperBottom - 0.023, kx + 0.2, kx + 0.28, b0 + 0.04, b1 - 0.04, -1, M.led)
        if (led) led.name = 'kitchenLED'
        if (!anchors.kitchenLed || b1 - b0 > anchors.kitchenLedLen) {
          const w = tw(kx + 0.25, (b0 + b1) / 2)
          anchors.kitchenLed = [w[0], upperBottom - 0.05, w[1]]; anchors.kitchenLedLen = b1 - b0
        }
      }
      for (const it of items) {
        const z0 = it.z1, z1 = it.z2, zc = (z0 + z1) / 2
        if (it.type === 'pullout') {
          frontX(fx, z0, z1, PL, ct - 0.03)
          bowX(fF, z1 - 0.035, ct - 0.17, 0.128, true)
        } else if (it.type === 'drawers') {
          for (const [y1, y2] of [[PL, 0.36], [0.36, 0.62], [0.62, ct - 0.03]]) { frontX(fx, z0, z1, y1, y2); bowX(fF, zc, y2 - 0.055, 0.16) }
        } else if (it.type === 'cabinet') {
          frontX(fx, z0, z1, PL, ct - 0.03)
          bowX(fF, zc, ct - 0.085, 0.16)
        } else if (it.type === 'sink') {
          frontX(fx, z0, z1, PL, ct - 0.03)
          bowX(fF, zc, ct - 0.085, 0.16)
          const sz1 = z0 + 0.07, sz2 = z1 - 0.07, sx1 = kx + 0.13, sx2 = kf - 0.07
          const w = sx2 - sx1, d = sz2 - sz1, sd = 0.18
          const sh = new THREE.Shape(); const r = 0.04
          sh.moveTo(-w / 2 + r, -d / 2); sh.lineTo(w / 2 - r, -d / 2); sh.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r)
          sh.lineTo(w / 2, d / 2 - r); sh.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2); sh.lineTo(-w / 2 + r, d / 2)
          sh.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r); sh.lineTo(-w / 2, -d / 2 + r); sh.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2)
          const walls = new THREE.ExtrudeGeometry(sh, { depth: sd, bevelEnabled: false, curveSegments: 6 })
          walls.rotateX(Math.PI / 2); walls.translate((sx1 + sx2) / 2, ct, (sz1 + sz2) / 2)
          const mesh = new THREE.Mesh(walls, [M.hidden, M.sinkSteel]) // group 0 = caps (hidden), 1 = side walls
          if (ct - sd < cut) { mesh.castShadow = false; mesh.receiveShadow = true; parent.add(mesh) }
          box(sx1, sz1, sx2, sz2, ct - sd - 0.002, ct - sd, M.sinkSteel, { collide: false, cast: false })
          cyl((sx1 + sx2) / 2, ct - sd + 0.002, (sz1 + sz2) / 2, 0.035, 0.035, 0.004, M.steelDark, { cast: false })
          box(sx1 - 0.012, sz1 - 0.012, sx2 + 0.012, sz2 + 0.012, ct, ct + 0.0015, M.sinkSteel, { collide: false, cast: false })
          // tall single-lever mixer at the back
          const mx = kx + 0.075, mz = sz2 - 0.07
          cyl(mx, ct + 0.012, mz, 0.026, 0.028, 0.024, M.chrome)
          cyl(mx, ct + 0.13, mz, 0.02, 0.022, 0.22, M.chrome)
          tube(rounded([[mx, ct + 0.2, mz], [mx, ct + 0.36, mz], [mx + 0.2, ct + 0.36, mz], [mx + 0.2, ct + 0.3, mz]], 0.06), 0.011, M.chrome, { seg: 40 })
          cyl(mx + 0.2, ct + 0.295, mz, 0.014, 0.012, 0.02, M.chrome)
          box(mx - 0.012, mz - 0.007, mx + 0.012, mz + 0.007, ct + 0.24, ct + 0.33, M.chrome, { collide: false })
        } else if (it.type === 'dishwasher') {
          const a = z0 + gap, b = z1 - gap, c = (a + b) / 2
          box(fx, a, fx + 0.02, b, PL, ct - 0.035, M.steel, { collide: false })
          box(fx + 0.02, a + 0.004, fx + 0.021, b - 0.004, ct - 0.1, ct - 0.04, M.steelDark, { collide: false, cast: false })
          cyl(fx + 0.06, ct - 0.13, c, 0.009, 0.009, 0.36, M.steel, { rx: Math.PI / 2 })
          for (const dz of [-0.16, 0.16]) cyl(fx + 0.04, ct - 0.13, c + dz, 0.007, 0.007, 0.04, M.steel, { rz: Math.PI / 2 })
        } else if (it.type === 'oven') {
          const o0 = z0 + gap, o1 = z1 - gap, oc = (o0 + o1) / 2
          frontX(fx, z0, z1, PL, 0.22)
          bowX(fF, oc, 0.19, 0.3)
          box(fx - 0.01, o0, fx + 0.012, o1, 0.22, 0.82, M.steelDark, { collide: false })
          box(fx + 0.012, o0 + 0.002, fx + 0.024, o1 - 0.002, 0.725, 0.82, M.steel, { collide: false })
          for (const dz of [-0.2, 0.2]) {
            cyl(fx + 0.034, 0.772, oc + dz, 0.019, 0.02, 0.022, M.steel, { rz: Math.PI / 2, cast: false })
            box(fx + 0.044, oc + dz - 0.003, fx + 0.047, oc + dz + 0.003, 0.76, 0.785, M.steelDark, { collide: false, cast: false })
          }
          box(fx + 0.024, oc - 0.05, fx + 0.026, oc + 0.05, 0.758, 0.786, M.blackGlass, { collide: false, cast: false })
          box(fx + 0.012, o0 + 0.002, fx + 0.03, o1 - 0.002, 0.235, 0.72, M.blackGlass, { collide: false })
          box(fx + 0.03, o0 + 0.07, fx + 0.031, o1 - 0.07, 0.3, 0.6, M.ovenWindow, { collide: false, cast: false })
          cyl(fx + 0.075, 0.685, oc, 0.011, 0.011, 0.5, M.steel, { rx: Math.PI / 2 })
          for (const dz of [-0.23, 0.23]) cyl(fx + 0.052, 0.685, oc + dz, 0.008, 0.008, 0.046, M.steel, { rz: Math.PI / 2 })
          // induction hob (flush black glass with printed zones)
          box(kx + 0.05, z0 + 0.015, kf - 0.04, z1 - 0.015, ct - 0.004, ct + 0.002, M.blackGlass, { collide: false })
          decal(kx + 0.05, z0 + 0.015, kf - 0.04, z1 - 0.015, ct + 0.0025, M.hob)
          if (ct < cut) drapedTowel(fx + 0.075, 0.685, oc + 0.08, 'z', 0.22, 0.02, 0.32, M.teaTowel)
        } else if (it.type === 'fridge') {
          const f0 = z0, f1 = z1
          const fw = f1 - f0 - 0.02, fzc = (f0 + f1) / 2, fd = 0.62, fxc = kx + 0.02 + fd / 2
          rbox(fxc, 0.95, fzc, fd, 1.86, fw, 0.02, M.fridgeSteel)
          box(kx + 0.02 + fd - 0.002, f0 + 0.015, kx + 0.022 + fd, f1 - 0.015, 1.08, 1.088, M.rubber, { collide: false, cast: false })
          // handles on the side away from the counter run
          const towardRun = items.indexOf(it) > 0 ? 1 : -1
          const hx = kx + 0.02 + fd, hz = towardRun > 0 ? f1 - 0.06 : f0 + 0.06
          tube(rounded([[hx, 1.2, hz], [hx + 0.045, 1.2, hz], [hx + 0.045, 1.72, hz], [hx, 1.72, hz]], 0.02), 0.012, M.steel)
          tube(rounded([[hx, 0.55, hz], [hx + 0.045, 0.55, hz], [hx + 0.045, 0.98, hz], [hx, 0.98, hz]], 0.02), 0.012, M.steel)
          box(kx, f0, kf - FT, f1, 1.93, CEIL, M.cabinet, { collide: false })
          frontX(kf - FT, f0, f1, 1.93, CEIL - 0.004)
          bowX(kf, towardRun > 0 ? f1 - 0.04 : f0 + 0.04, 2.03, 0.128, true)
          pushCol(kx, f0, kx + 0.02 + fd + 0.05, f1)
        } else if (it.type === 'tall') {
          box(kx, z0, fx, z1, 0, CEIL, M.cabinet)
          frontX(fx, z0, z1, 0.02, 2.3); frontX(fx, z0, z1, 2.3, CEIL - 0.004)
          bowX(fF, z1 - 0.04, 1.1, 0.128, true)
        }
      }
      // worktop props (styling as in the listing photos)
      const prop = items.find((i) => i.type === 'drawers' || i.type === 'cabinet') || items.find((i) => i.type === 'dishwasher')
      if (prop && ct < cut) {
        const by = ct, pc = (prop.z1 + prop.z2) / 2
        const board = new THREE.Mesh(new RoundedBoxGeometry(0.02, 0.4, 0.26, 2, 0.008), M.oak)
        board.position.set(kx + 0.03, by + 0.2, pc + 0.02); board.rotation.z = -0.12; board.castShadow = true; parent.add(board)
        cyl(kx + 0.05, by + 0.42, pc + 0.02, 0.02, 0.02, 0.022, M.oak, { rz: Math.PI / 2 })
        lathe([[0, 0], [0.026, 0], [0.028, 0.02], [0.022, 0.09], [0.026, 0.16], [0.018, 0.2], [0.008, 0.215], [0, 0.22]], kx + 0.12, by, pc - 0.18, M.blackMatte, { seg: 24 })
        lathe([[0, 0], [0.034, 0], [0.035, 0.005], [0.035, 0.16], [0.03, 0.19], [0.012, 0.21], [0.012, 0.25], [0, 0.25]], kx + 0.13, by, pc - 0.08, M.amberGlass, { seg: 28 })
        cyl(kx + 0.13, by + 0.26, pc - 0.08, 0.011, 0.012, 0.025, M.oak, { cast: false })
      }
      const bowlAt = items.find((i) => i.type === 'dishwasher') || items.find((i) => i.type === 'pullout')
      if (bowlAt && ct < cut) {
        const bz = (bowlAt.z1 + bowlAt.z2) / 2
        lathe([[0, 0], [0.05, 0], [0.09, 0.03], [0.12, 0.065], [0.115, 0.068], [0.086, 0.036], [0.048, 0.008], [0, 0.008]], kx + 0.2, ct, bz, M.ceramic, { seg: 40 })
        for (const [dx, dz] of [[0, 0], [0.04, 0.03], [-0.03, 0.035]]) {
          const ap = new THREE.Mesh(new THREE.SphereGeometry(0.035, 20, 14), M.apple); ap.position.set(kx + 0.2 + dx, ct + 0.045, bz + dz); ap.castShadow = true; parent.add(ap)
        }
      }
    })
  }

  // --------------------------------------------------------------- bathroom tiles (walls up to the ceiling)
  for (const r of indoor.filter((r) => r.type === 'bath')) {
    const [x1, z1, x2, z2] = r.rect, h = r.ceiling
    // each side, split around door openings on it
    const sides = [
      { axis: 'x', c: x1 + 0.002, dir: 1, a1: z1, a2: z2, line: x1, alongX: false },
      { axis: 'x', c: x2 - 0.002, dir: -1, a1: z1, a2: z2, line: x2, alongX: false },
      { axis: 'z', c: z1 + 0.002, dir: 1, a1: x1, a2: x2, line: z1, alongX: true },
      { axis: 'z', c: z2 - 0.002, dir: -1, a1: x1, a2: x2, line: z2, alongX: true },
    ]
    for (const s of sides) {
      const holes = P.OPENINGS.filter((o) => o.alongX === s.alongX && (s.alongX ? Math.abs(o.z1 - s.line) < 0.02 || Math.abs(o.z2 - s.line) < 0.02 : Math.abs(o.x1 - s.line) < 0.02 || Math.abs(o.x2 - s.line) < 0.02))
        .map((o) => (s.alongX ? [o.x1, o.x2, o] : [o.z1, o.z2, o])).filter(([a, b]) => b > s.a1 && a < s.a2).sort((p, q) => p[0] - q[0])
      let a = s.a1
      for (const [h1, h2, o] of holes) {
        quad(s.axis, s.c, a, h1, 0, h, s.dir, M.bathWall)
        quad(s.axis, s.c, h1, h2, o.kind === 'window' ? o.head : o.head, h, s.dir, M.bathWall)
        if (o.kind === 'window') quad(s.axis, s.c, h1, h2, 0, o.sill - 0.03, s.dir, M.bathWall)
        a = h2
      }
      quad(s.axis, s.c, a, s.a2, 0, h, s.dir, M.bathWall)
    }
    const c = [(x1 + x2) / 2, (z1 + z2) / 2]
    if (!anchors.bath) anchors.bath = [c[0], h - 0.12, c[1]]
  }

  // --------------------------------------------------------------- fixtures
  const FT = 0.019, gap = 0.0025
  for (const f of P.FIXTURES) {
    const theta = P.fixtureTheta(f.n || [0, 1])
    const front = P.toWorld([f.x, f.z], theta, 0, 0.3)
    const CEIL = ceilAt(front[0], front[1])
    inFrame([f.x, f.z], theta, () => {
      if (f.type === 'toilet') {
        // floor-standing close-coupled WC (IFÖ Spira style)
        lathe([[0, 0], [0.12, 0], [0.12, 0.01], [0.105, 0.06], [0.1, 0.16], [0.13, 0.26], [0.17, 0.34], [0.185, 0.385], [0.18, 0.395], [0, 0.395]], 0, 0, 0.43, M.porcelain, { sz: 1.32, seg: 48 })
        rbox(0, 0.2, 0.2, 0.26, 0.4, 0.26, 0.05, M.porcelain)
        lathe([[0, 0], [0.188, 0], [0.19, 0.012], [0.182, 0.026], [0.12, 0.034], [0, 0.036]], 0, 0.398, 0.445, M.porcelain, { sz: 1.3, seg: 48 })
        rbox(0, 0.62, 0.1, 0.38, 0.42, 0.17, 0.04, M.porcelain)
        rbox(0, 0.84, 0.1, 0.4, 0.035, 0.19, 0.015, M.porcelain)
        cyl(0, 0.86, 0.1, 0.028, 0.028, 0.008, M.chrome, { cast: false })
        pushCol(-0.2, 0, 0.2, 0.68)
      } else if (f.type === 'shower') {
        // corner shower: origin = the corner, runs w along the wall (+x), d out into the room
        const W = f.w || 0.8, D = f.d || 0.8, mz = 0.42, my = 1.05
        for (const dz of [-0.075, 0.075]) {
          tube(rounded([[mz + dz + 0.25, 0.04, 0.039], [mz + dz, 0.04, 0.039], [mz + dz, my, 0.039]], 0.04), 0.008, M.chrome, { seg: 32 })
          cyl(mz + dz + 0.25, 0.04, 0.019, 0.02, 0.02, 0.03, M.chrome, { rx: Math.PI / 2, cast: false })
        }
        cyl(mz, my, 0.054, 0.025, 0.025, 0.3, M.chrome, { rz: Math.PI / 2 })
        for (const dz of [-0.16, 0.16]) cyl(mz + dz, my, 0.054, 0.03, 0.03, 0.03, M.chrome, { rz: Math.PI / 2 })
        cyl(mz, my - 0.04, 0.054, 0.008, 0.008, 0.03, M.chrome)
        cyl(mz, 1.55, 0.034, 0.011, 0.011, 0.9, M.chrome)
        for (const y of [1.11, 1.99]) box(mz - 0.012, 0.004, mz + 0.012, 0.039, y - 0.015, y + 0.015, M.chrome, { collide: false })
        box(mz - 0.018, 0.024, mz + 0.018, 0.064, 1.82, 1.86, M.chrome, { collide: false })
        {
          const hs = new THREE.Group(); hs.position.set(mz, 1.84, 0.084); hs.rotation.x = 0.35
          const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.016, 0.2, 16), M.chrome); handle.position.y = -0.08; hs.add(handle)
          const head = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.035, 0.03, 32), M.chrome); head.position.set(0, 0.04, 0.02); head.rotation.x = Math.PI / 2 - 0.3; hs.add(head)
          hs.traverse((o) => { o.castShadow = true }); parent.add(hs)
          tube([[mz, 1.74, 0.104], [mz + 0.03, 1.3, 0.144], [mz + 0.05, 0.95, 0.124], [mz + 0.02, 0.98, 0.074], [mz, my - 0.055, 0.054]], 0.008, M.chrome, { seg: 64 })
        }
        const ry = 2.02
        tube(rounded([[0.005, ry, D], [W, ry, D], [W, ry, 0.005]], 0.18), 0.014, M.trim, { seg: 60 })
        cyl(0.01, ry, D, 0.025, 0.025, 0.02, M.trim, { rz: Math.PI / 2, cast: false })
        cyl(W, ry, 0.01, 0.025, 0.025, 0.02, M.trim, { rx: Math.PI / 2, cast: false })
        drapedTowel(W, ry, D / 2 - 0.06, 'z', 0.42, 0.62, 0.55, M.towel)
        decal(W / 2 - 0.075, D / 2 - 0.075, W / 2 + 0.075, D / 2 + 0.075, 0.003, M.drain)
      } else if (f.type === 'towelRail') {
        const z = 0.075, w = 0.42, y0 = 0.98, y1 = 1.26, xl = -w / 2, xr = w / 2
        const pts = [[xl - 0.02, y0, z], [xr, y0, z], [xr, y0 + 0.14, z], [xl, y0 + 0.14, z], [xl, y1, z], [xr, y1, z], [xr, y1 + 0.14, z], [xl - 0.02, y1 + 0.14, z]]
        tube(rounded(pts, 0.07), 0.011, M.chrome, { seg: 120 })
        for (const [y, xx] of [[y0, xl - 0.02], [y1 + 0.14, xl - 0.02], [y0 + 0.07, xr + 0.06], [y1 + 0.07, xl - 0.06]]) cyl(xx, y, 0.038, 0.012, 0.012, 0.075, M.chrome, { rx: Math.PI / 2 })
        drapedTowel(0.06, y0 + 0.14, z, 'x', 0.2, 0.38, 0.03, M.towelSmall)
      } else if (f.type === 'washer') {
        const W = f.w || 0.6, fz = 0.588
        rbox(0, 0.425, fz / 2, W - 0.02, 0.85, fz - 0.01, 0.02, M.appliance)
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.175, 0.03, 16, 48), M.applianceGrey)
        ring.position.set(0, 0.4, fz + 0.005); ring.castShadow = true; parent.add(ring)
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.008, 10, 48), M.chrome)
        rim.position.set(0, 0.4, fz + 0.004); parent.add(rim)
        lathe([[0, 0.035], [0.08, 0.03], [0.15, 0.01], [0.155, 0]], 0, 0.4, fz, M.washerGlass, { rx: Math.PI / 2, seg: 40, cast: false })
        box(-W / 2 + 0.035, fz, -W / 2 + 0.22, fz + 0.006, 0.74, 0.81, M.appliance, { collide: false })
        cyl(0.02, 0.775, fz + 0.012, 0.028, 0.03, 0.022, M.applianceGrey, { rx: Math.PI / 2 })
        box(0.08, fz, 0.24, fz + 0.003, 0.755, 0.795, M.washerScreen, { collide: false, cast: false })
        pushCol(-W / 2, 0, W / 2, fz)
        // worktop over the machine, outlet + 2-door wall cabinet above
        box(-W / 2 - 0.04, 0, W / 2 + 0.04, fz + 0.04, 0.88, 0.91, M.counter, { collide: false })
        socketZ(0, 1.12)
        const c0 = -W / 2 - 0.02, c1 = W / 2 + 0.02, cm = 0
        box(c0, 0, c1, 0.32, 1.42, 2.04, M.cabinet, { collide: false })
        for (const [a, b] of [[c0, cm], [cm, c1]]) box(a + gap, 0.32, b - gap, 0.32 + FT, 1.42, 2.04, M.cabinet, { collide: false })
        for (const xx of [cm - 0.035, cm + 0.035]) bowZ(0.32 + FT, xx, 1.52, 0.096, true)
      } else if (f.type === 'basin') {
        // wall-hung basin + mixer + mirror with a light above
        lathe([[0, -0.11], [0.09, -0.11], [0.13, -0.08], [0.2, -0.02], [0.215, 0], [0.215, 0.012], [0.195, 0.014], [0.17, -0.005], [0.12, -0.06], [0.05, -0.085], [0, -0.087]], 0, 0.86, 0.204, M.porcelain, { sx: 1.35, seg: 48 })
        box(-0.27, 0.004, 0.27, 0.064, 0.75, 0.872, M.porcelain, { collide: false })
        pushCol(-0.3, 0.004, 0.3, 0.424)
        tube(rounded([[0, 0.77, 0.204], [0, 0.6, 0.204], [0, 0.6, 0.014]], 0.05), 0.016, M.chrome, { seg: 30 })
        cyl(0, 0.9, 0.074, 0.022, 0.024, 0.07, M.chrome)
        tube(rounded([[0, 0.93, 0.074], [0, 0.945, 0.104], [0, 0.935, 0.174]], 0.03), 0.01, M.chrome, { seg: 24 })
        box(-0.006, 0.054, 0.006, 0.094, 0.94, 0.95, M.chrome, { collide: false })
        box(-0.3, 0.004, 0.3, 0.016, 1.08, 1.88, M.mirror, { collide: false, cast: false })
        const mled = box(-0.22, 0.016, 0.22, 0.074, 1.93, 1.97, M.led, { collide: false })
        if (mled) mled.name = 'mirrorLED'
        if (!anchors.mirror) { const w = tw(0, 0.25); anchors.mirror = [w[0], 1.9, w[1]] }
      } else if (f.type === 'stool') {
        // black stool with a folded white towel (photo prop)
        const sy = 0.47
        cyl(0, sy - 0.015, 0, 0.15, 0.15, 0.03, M.blackMatte, { seg: 32 })
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + 0.6
          tube([[Math.cos(a) * 0.12, sy - 0.03, Math.sin(a) * 0.12], [Math.cos(a) * 0.17, 0.0, Math.sin(a) * 0.17]], 0.011, M.blackMatte, { seg: 4 })
        }
        tube([[0.15, 0.17, 0], [0, 0.17, 0.15], [-0.15, 0.17, 0], [0, 0.17, -0.15]], 0.008, M.blackMatte, { closed: true, seg: 32 })
        const t = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.05, 0.28, 3, 0.02), M.towelWhite); t.position.set(0, sy + 0.025, 0); t.rotation.y = 0.2; t.castShadow = true
        if (sy < cut) parent.add(t)
        pushCol(-0.17, -0.17, 0.17, 0.17)
      } else if (f.type === 'wardrobe') {
        const W = f.w || 0.8, D = f.d || 0.6, style = f.style || 'hinged'
        if (style === 'sliding') {
          const F = D - 0.007
          box(-W / 2, 0, W / 2, F - 0.03, 0, CEIL, M.cabinet)
          const dh = CEIL - 0.22
          box(-0.02, F - 0.03, W / 2 - gap, F - 0.012, 0.02, dh, M.cabinet, { collide: false })
          box(-W / 2 + gap, F - 0.012, 0.02, F + 0.006, 0.02, dh, M.cabinet, { collide: false })
          box(-W / 2, F - 0.03, W / 2, F + 0.006, dh, CEIL, M.cabinet, { collide: false })
        } else if (style === 'tall') {
          const F = D - 0.007
          box(-W / 2, 0, W / 2, F - 0.03, 0, CEIL, M.cabinet)
          box(-W / 2 + gap, F - 0.03, W / 2 - gap, F - 0.011, 0.02, 2.3, M.cabinet, { collide: false })
          box(-W / 2 + gap, F - 0.03, W / 2 - gap, F - 0.011, 2.3 + gap, CEIL - 0.005, M.cabinet, { collide: false })
          bowZ(F - 0.011, -(W / 2 - 0.05), 1.1, 0.128, true)
        } else {
          box(-W / 2, 0, W / 2, D - FT, 0, CEIL, M.cabinet)
          const n = f.doors || Math.max(1, Math.round(W / 0.6)), ww = W / n
          for (let i = 0; i < n; i++) {
            const x1 = -W / 2 + i * ww, x2 = x1 + ww
            box(x1 + gap, D - FT, x2 - gap, D, 0.02, 2.3, M.cabinet, { collide: false })
            box(x1 + gap, D - FT, x2 - gap, D, 2.3 + gap, CEIL - 0.005, M.cabinet, { collide: false })
            const hx = i < n / 2 - 0.01 && n > 1 ? x2 - 0.05 : x1 + 0.05
            box(hx - 0.006, D + 0.012, hx + 0.006, D + 0.024, 1.0, 1.128, M.steel, { collide: false })
          }
        }
      } else if (f.type === 'panel') {
        // electrical cabinet (LC)
        box(-0.15, 0, 0.15, 0.022, 1.45, 2.05, M.trim, { collide: false })
      }
    })
  }

  // --------------------------------------------------------------- ceiling fixtures
  for (const L of P.LIGHTS) {
    if (L.y > cut) continue
    if (L.kind === 'pendant') cyl(L.x, L.y - 0.012, L.z, 0.06, 0.06, 0.024, M.white, { cast: false })
    else if (L.kind === 'dome') lathe([[0, 0], [0.16, 0], [0.165, -0.02], [0.15, -0.06], [0.1, -0.08], [0, -0.085]], L.x, L.y, L.z, M.lampShade, { seg: 48, cast: false })
    else cyl(L.x, L.y - 0.01, L.z, 0.05, 0.05, 0.02, M.white, { cast: false })
  }

  // --------------------------------------------------------------- curtains (linen, ceiling rail), per window wall
  if (curtains) {
    const ext = P.OPENINGS.filter((o) => o.kind === 'window' || o.kind === 'balconyDoor')
    const groups = []
    for (const o of ext) {
      const face = o.alongX ? (o.out[1] > 0 ? o.z1 : o.z2) : (o.out[0] > 0 ? o.x1 : o.x2)
      let g = groups.find((g) => g.alongX === o.alongX && g.out[0] === o.out[0] && g.out[1] === o.out[1] && Math.abs(g.face - face) < 0.06)
      if (!g) groups.push((g = { alongX: o.alongX, out: o.out, face, list: [] }))
      g.list.push(o)
    }
    for (const g of groups) {
      const o0 = g.list[0]
      const ax = o0.ax, off = (o) => (o.origin[0] - o0.origin[0]) * ax[0] + (o.origin[1] - o0.origin[1]) * ax[1]
      const spans = g.list.map((o) => [off(o), off(o) + o.L]).sort((a, b) => a[0] - b[0])
      // the room in front of the windows bounds the rail
      const inside = P.toWorld(o0.origin, o0.theta, o0.L / 2, -0.3), room = P.roomAt(inside[0], inside[1])
      if (!room || room.type === 'bath') continue
      const [rx1, rz1, rx2, rz2] = room.rect
      const p1 = P.toWorld(o0.origin, o0.theta, 0, 0)
      const lim = [[rx1, rz1], [rx2, rz2]].map(([x, z]) => (x - p1[0]) * ax[0] + (z - p1[1]) * ax[1]).sort((a, b) => a - b)
      let rail1 = Math.max(lim[0] + 0.05, spans[0][0] - 0.55), rail2 = Math.min(lim[1] - 0.02, spans[spans.length - 1][1] + 0.55)
      // stop short of cabinets / wardrobes standing in the curtain's way
      for (const c of colliders) {
        const pts = [[c.x1, c.z1], [c.x2, c.z2]].map(([x, z]) => [(x - p1[0]) * ax[0] + (z - p1[1]) * ax[1], (x - p1[0]) * Math.sin(o0.theta) + (z - p1[1]) * Math.cos(o0.theta)])
        const xa = Math.min(pts[0][0], pts[1][0]), xb = Math.max(pts[0][0], pts[1][0]), za = Math.min(pts[0][1], pts[1][1]), zb = Math.max(pts[0][1], pts[1][1])
        if (zb < -0.24 || za > -0.11) continue
        if (xb <= spans[0][0] + 0.01) rail1 = Math.max(rail1, xb + 0.03)
        else if (xa >= spans[spans.length - 1][1] - 0.01) rail2 = Math.min(rail2, xa - 0.03)
      }
      const ceil = room.ceiling, top = Math.min(ceil - 0.24, cut - 0.01), cz = -0.17
      // keep clear of tall kitchen cabinets near the windows
      inFrame(o0.origin, o0.theta, () => {
        box(rail1, cz - 0.015, rail2, cz + 0.015, ceil - 0.23, ceil - 0.2, M.trim, { collide: false, cast: false })
        const panel = (a, b) => {
          a = Math.max(a, rail1); b = Math.min(b, rail2)
          const width = b - a, xc = (a + b) / 2
          if (top < 0.3 || width < 0.15) return
          const folds = Math.max(4, Math.round(width / 0.09))
          const geo = new THREE.PlaneGeometry(width, top - 0.015, folds * 8, 24)
          const p = geo.attributes.position
          for (let i = 0; i < p.count; i++) {
            const x = p.getX(i), y = p.getY(i)
            const t = (y + (top - 0.015) / 2) / (top - 0.015)
            const amp = 0.028 + 0.012 * (1 - t)
            p.setZ(i, Math.sin((x / width) * folds * Math.PI * 2) * amp + Math.sin(x * 31 + y * 3) * 0.003)
          }
          geo.computeVertexNormals()
          geo.translate(xc, (top - 0.015) / 2 + 0.01, cz)
          worldUV(geo)
          const m = new THREE.Mesh(geo, M.curtain); m.castShadow = true; m.receiveShadow = true; m.name = 'curtain'
          parent.add(m)
        }
        // a panel each side of every opening; merge the ones that share a pier
        let prevEnd = rail1 - 1
        spans.forEach(([a, b], i) => {
          const gapL = a - prevEnd
          if (i === 0) { if (a - 0.09 - rail1 < 0.2) panel(rail1, rail1 + 0.2); else panel(a - 0.33, a - 0.09) }
          else if (gapL < 0.9) panel(prevEnd + gapL / 2 - 0.21, prevEnd + gapL / 2 + 0.21)
          else { panel(prevEnd + 0.09, prevEnd + 0.51); panel(a - 0.51, a - 0.09) }
          if (i === spans.length - 1) { if (rail2 - b - 0.09 < 0.2) panel(rail2 - 0.2, rail2); else panel(b + 0.09, b + 0.53) }
          prevEnd = b
        })
      })
    }
  }

  // --------------------------------------------------------------- balcony
  if (P.BALCONY) {
    const BC = P.BALCONY, f = P.rectFrame(BC.rect, BC.out)
    const BW = f.L, BD = f.T, fy = BC.floorY
    inFrame(f.origin, f.theta, () => {
      box(0, 0, BW, BD, -0.25, fy, M.concrete, { collide: false })
      const wallL = BC.sideWall === 'left' || BC.sideWall === 'both', wallR = BC.sideWall === 'right' || BC.sideWall === 'both'
      if (wallL) box(0, 0, 0.104, BD, fy, 2.5, M.render)
      if (wallR) box(BW - 0.104, 0, BW, BD, fy, 2.5, M.render)
      const railH = 1.1
      const a0 = wallL ? 0.1 : 0.05, a1 = wallR ? BW - 0.1 : BW - 0.05
      // front: solid panels between posts
      for (let x = a0; x < a1 - 0.05; x += 0.85) box(x, BD - 0.03, Math.min(x + 0.8, a1 - 0.05), BD - 0.015, fy + 0.1, railH - 0.05, M.balcony, { collide: false })
      box(0, BD - 0.05, BW, BD, railH - 0.05, railH, M.balcony)
      for (let x = a0; x <= a1 + 0.05; x += 0.85) box(x - 0.02, BD - 0.05, x + 0.02, BD, fy, railH, M.balcony, { collide: false })
      // open sides: vertical bars
      const bars = (sx) => {
        box(sx, 0, sx + 0.05, BD, railH - 0.05, railH, M.balcony)
        for (let z = 0.06; z < BD - 0.05; z += 0.11) box(sx + 0.01, z - 0.008, sx + 0.03, z + 0.008, fy + 0.08, railH - 0.05, M.balcony, { collide: false })
        box(sx, 0, sx + 0.05, BD, fy + 0.05, fy + 0.09, M.balcony, { collide: false })
      }
      if (!wallR) bars(BW - 0.05)
      if (!wallL) bars(0)
    })
  }

  // --------------------------------------------------------- skirting (sockel) along painted walls
  {
    const SK = 0.056, ST = 0.012, step = 0.02
    const solids = [...P.WALLS, ...P.OPENINGS.filter((o) => o.kind === 'window').map((o) => [o.x1, o.z1, o.x2, o.z2])]
    const inBox = (x, z, b) => x > b[0] && x < b[2] && z > b[1] && z < b[3]
    const ok = (x, z) => {
      const r = P.roomAt(x, z)
      if (!r || r.type === 'bath' || r.type === 'balcony') return false
      if (solids.some((b) => inBox(x, z, b))) return false
      return !colliders.some((c) => x > c.x1 && x < c.x2 && z > c.z1 && z < c.z2)
    }
    const runs = (a1, a2, test, emit) => {
      let s = null
      for (let a = a1; a <= a2 + 1e-6; a += step) {
        const m = Math.min(a + step / 2, a2)
        const good = a < a2 - 1e-6 && test(m)
        if (good && s === null) s = a
        if (!good && s !== null) { emit(s, Math.min(a, a2)); s = null }
      }
    }
    const d = 0.03
    for (const w of solids) {
      const [x1, z1, x2, z2] = w
      runs(x1, x2, (x) => ok(x, z2 + d), (a, b) => box(a, z2, b, z2 + ST, 0, SK, M.trim, { collide: false, cast: false }))
      runs(x1, x2, (x) => ok(x, z1 - d), (a, b) => box(a, z1 - ST, b, z1, 0, SK, M.trim, { collide: false, cast: false }))
      runs(z1, z2, (z) => ok(x2 + d, z), (a, b) => box(x2, a, x2 + ST, b, 0, SK, M.trim, { collide: false, cast: false }))
      runs(z1, z2, (z) => ok(x1 - d, z), (a, b) => box(x1 - ST, a, x1, b, 0, SK, M.trim, { collide: false, cast: false }))
    }
  }

  // bake the local frames into the root so static meshes can be merged
  root.updateMatrixWorld(true)
  for (const g of [...root.children]) {
    if (!g.userData.frame) continue
    for (const c of [...g.children]) root.attach(c)
    root.remove(g)
  }
  mergeStatic(root)
  return { root, colliders, doors, anchors }
}

// Merge all static meshes that share a material into one draw call each (doors stay separate).
export function mergeStatic(root) {
  const groups = new Map()
  for (const m of [...root.children]) {
    if (!m.isMesh || Array.isArray(m.material)) continue
    const key = m.material.uuid + (m.castShadow ? 'c' : '') + (m.receiveShadow ? 'r' : '')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(m)
  }
  for (const list of groups.values()) {
    if (list.length < 2) { list[0].geometry.computeBoundsTree?.(); continue }
    const geos = list.map((m) => {
      m.updateMatrix()
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()
      g.applyMatrix4(m.matrix)
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k)
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
      g.clearGroups()
      return g
    })
    const merged = mergeGeometries(geos, false)
    for (const g of geos) g.dispose()
    if (!merged) continue
    merged.computeBoundsTree?.()
    const mesh = new THREE.Mesh(merged, list[0].material)
    mesh.castShadow = list[0].castShadow; mesh.receiveShadow = list[0].receiveShadow
    for (const m of list) { root.remove(m); m.geometry.dispose() }
    root.add(mesh)
  }
}
