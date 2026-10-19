import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { tex } from './textures.js'

// Parametric furniture modelled on the listing photos (Scandinavian
// showroom style). Each builder gets (w, d, h, color) in metres and returns a Group
// with its origin at floor level, centred, front facing local +z.

const matCache = new Map()
const memo = (key, make) => { if (!matCache.has(key)) matCache.set(key, make()); return matCache.get(key) }

const FABRICS = {
  linen: { file: 'rough_linen', size: 0.27, sheen: 0.6, normal: 0.8 },
  boucle: { file: 'velour', size: 0.28, sheen: 0.9, normal: 1.4 },
  waffle: { file: 'waffle_pique_cotton', size: 0.28, sheen: 0.5, normal: 1.0 },
}
export function fabric(color, kind = 'linen', scale = 1) {
  return memo(`fab:${kind}:${color}:${scale}`, () => {
    const f = FABRICS[kind], m = [f.size * scale, f.size * scale]
    const c = new THREE.Color(color)
    return new THREE.MeshStandardMaterial({
      color: c,
      map: tex(`/tex/${f.file}_gray.jpg`, { srgb: true, metres: m }),
      normalMap: tex(`/tex/${f.file}_nor_gl_1k.jpg`, { metres: m }),
      normalScale: new THREE.Vector2(f.normal, f.normal),
      roughnessMap: tex(`/tex/${f.file}_rough_1k.jpg`, { metres: m }),
      roughness: 1,
    })
  })
}
const lacquer = (c, r = 0.35) => memo(`lq:${c}:${r}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: r }))
const metal = (c, r = 0.35) => memo(`mt:${c}:${r}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: 1 }))
const matte = (c, r = 0.6) => memo(`mm:${c}:${r}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: r }))
let oakMat = null
export function setOakMaterial(m) { oakMat = m }
const oak = () => oakMat || matte('#c49a6c')

// planar UVs in metres so fabric/wood textures keep their real scale
function metricUV(geo) {
  const p = geo.attributes.position, n = geo.attributes.normal
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i))
    let u, v
    if (ax >= ay && ax >= az) { u = p.getZ(i); v = p.getY(i) } else if (ay >= az) { u = p.getX(i); v = p.getZ(i) } else { u = p.getX(i); v = p.getY(i) }
    uv[i * 2] = u; uv[i * 2 + 1] = v
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return geo
}

const add = (g, geo, m, x = 0, y = 0, z = 0) => {
  const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z)
  mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh
}

// soft upholstered block: rounded box with puffed faces
function cushion(w, h, d, r, puff = 0, wrinkle = 0) {
  const geo = new RoundedBoxGeometry(w, h, d, 5, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3))
  const p = geo.attributes.position
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
    const nx = Math.min(1, Math.abs(x) / (w / 2)), ny = Math.min(1, Math.abs(y) / (h / 2)), nz = Math.min(1, Math.abs(z) / (d / 2))
    const fx = 1 - nx * nx, fy = 1 - ny * ny, fz = 1 - nz * nz
    let dy = Math.sign(y) * puff * fx * fz
    let dz = Math.sign(z) * puff * 0.6 * fx * fy
    let dx = Math.sign(x) * puff * 0.4 * fy * fz
    if (wrinkle) dy += wrinkle * Math.sin(x * 37 + z * 11) * Math.sin(z * 29 - x * 7) * fx * fz * (y > 0 ? 1 : 0)
    p.setXYZ(i, x + dx, y + dy, z + dz)
  }
  geo.computeVertexNormals()
  return metricUV(geo)
}
const rbox = (w, h, d, r) => metricUV(new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)))
const taperLeg = (h, r1, r2) => new THREE.CylinderGeometry(r1, r2, h, 16)
const tube = (pts, r, closed = false) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), closed), 64, r, 10, closed)

function oakLegs(g, w, d, h, inset = 0.06, splay = 0) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = add(g, taperLeg(h, 0.018, 0.012), oak(), sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset))
    leg.rotation.z = -sx * splay; leg.rotation.x = sz * splay
  }
}

// ------------------------------------------------------------------ GLTF decor models
const gltf = new GLTFLoader()
const models = new Map() // name -> { scene, size } | 'loading'
let onModel = () => {}
export function onModelLoaded(fn) { onModel = fn }
function modelInstance(name, h) {
  const m = models.get(name)
  if (!m) {
    models.set(name, 'loading')
    gltf.load(`/models/${name}/${name}.gltf`, (res) => {
      const s = res.scene
      s.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
      const box = new THREE.Box3().setFromObject(s)
      const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3())
      s.position.set(-c.x, -box.min.y, -c.z)
      const wrap = new THREE.Group(); wrap.add(s)
      models.set(name, { scene: wrap, size })
      onModel(name)
    })
  }
  const g = new THREE.Group()
  if (m && m !== 'loading') {
    const inst = m.scene.clone(true)
    inst.scale.setScalar(h / m.size.y)
    g.add(inst)
  } else {
    const ph = add(g, new THREE.CylinderGeometry(0.15, 0.12, h, 16), matte('#d9d4cb', 0.8), 0, h / 2, 0)
    ph.material = ph.material.clone(); ph.material.transparent = true; ph.material.opacity = 0.4
  }
  return g
}
export function preloadModel(name) { modelInstance(name, 1) }
export function withModel(name, cb) {
  const m = models.get(name)
  if (m && m !== 'loading') return cb(m)
  gltf.load(`/models/${name}/${name}.gltf`, (res) => {
    res.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
    const box = new THREE.Box3().setFromObject(res.scene)
    cb({ scene: res.scene, size: box.getSize(new THREE.Vector3()), box })
  })
}
export function getModel(name) { const m = models.get(name); return m && m !== 'loading' ? m : null }

// ------------------------------------------------------------------ catalogue
// ------------------------------------------------------------------ style themes (textiles & accents)
export const STYLES = {
  scandi: { name: 'Scandi blue', duvet: '#7d9cc4', throw: '#2f4566', pillowA: '#f6f8fb', pillowB: '#dfe8f3', cushA: '#c9b79c', cushB: '#4a3226', sofa: '#a8a59f', armchair: '#e9e3d8', rug: '#d6d0c5', curtain: '#f1ece3', art: ['#2f4566', '#7d9cc4', '#e9e3d8', '#c9b79c'] },
  japandi: { name: 'Cozy Japandi', duvet: '#d8ccb6', throw: '#8a6f55', pillowA: '#efe8dc', pillowB: '#c8b8a0', cushA: '#6f7a5d', cushB: '#8a6f55', sofa: '#cbbfae', armchair: '#e6dccb', rug: '#c9b9a0', curtain: '#e9e0d0', art: ['#2b2b28', '#8a6f55', '#d8ccb6', '#6f7a5d'] },
  moody: { name: 'Dark moody', duvet: '#2c3038', throw: '#7a3e2b', pillowA: '#454b54', pillowB: '#9a6440', cushA: '#7a3e2b', cushB: '#c7a26b', sofa: '#3b3e44', armchair: '#5a4a3f', rug: '#34312e', curtain: '#55514a', art: ['#c7a26b', '#7a3e2b', '#1c1d20', '#9a6440'] },
  colour: { name: 'Colourful', duvet: '#e9a23b', throw: '#2a9d8f', pillowA: '#f4b6b6', pillowB: '#8ecae6', cushA: '#e76f51', cushB: '#2a9d8f', sofa: '#2a9d8f', armchair: '#f4b6b6', rug: '#e76f51', curtain: '#f6efe1', art: ['#e63946', '#f4a261', '#2a9d8f', '#264653'] },
}
export const theme = { ...STYLES.scandi }
export function setTheme(k) { Object.assign(theme, STYLES[k] || STYLES.scandi) }
// things that glow; their brightness is driven by the lighting mood
export const glowMats = new Set()
const glow = (key, color, emissive) => memo('glow' + key, () => { const m = new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: 0, roughness: 0.4 }); m.userData.glow = key; glowMats.add(m); return m })

// ------------------------------------------------------------------ Lego builds (procedural bricks with studs)
const LEGO = ['#c91a09', '#0055bf', '#f2cd37', '#237841', '#fe8a18', '#f4f4f4', '#1b2a34', '#a0a5a9', '#5a93db', '#d67572']
const legoMat = (c) => memo('lego' + c, () => new THREE.MeshStandardMaterial({ color: c, roughness: 0.25 }))
const STUD = new THREE.CylinderGeometry(0.0024, 0.0024, 0.0017, 10)
function brick(g, x, y, z, nx, nz, c, plate = false) {
  const u = 0.008, bh = plate ? 0.0032 : 0.0096
  add(g, new THREE.BoxGeometry(nx * u - 0.0002, bh, nz * u - 0.0002), legoMat(c), x, y + bh / 2, z)
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const s = new THREE.Mesh(STUD, legoMat(c)); s.position.set(x + (i - (nx - 1) / 2) * u, y + bh + 0.00085, z + (k - (nz - 1) / 2) * u); g.add(s)
  }
  return bh
}
// a small "set": a base plate with a little stacked building / vehicle, scaled up so it reads at room scale
function legoSet(seed, size = 1) {
  let r = seed * 9301 + 49297
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280)
  const g = new THREE.Group(), inner = new THREE.Group(); inner.scale.setScalar(2.2 * size); g.add(inner)
  const W = 8 + Math.floor(rnd() * 4), D = 6 + Math.floor(rnd() * 3), u = 0.008
  brick(inner, 0, 0, 0, W, D, rnd() > 0.5 ? '#237841' : '#a0a5a9', true)
  let y = 0.0032
  const kind = rnd()
  if (kind < 0.5) { // little house / tower
    const walls = LEGO[Math.floor(rnd() * LEGO.length)], floors = 3 + Math.floor(rnd() * 4)
    for (let f = 0; f < floors; f++) { brick(inner, 0, y, 0, W - 4, D - 3, f % 2 ? walls : '#f4f4f4'); y += 0.0096 }
    brick(inner, 0, y, 0, W - 2, D - 1, '#c91a09', true); y += 0.0032
    brick(inner, 0, y, 0, W - 5, D - 4, '#c91a09')
  } else { // car / spaceship
    const body = LEGO[Math.floor(rnd() * 5)]
    brick(inner, 0, y, 0, W - 2, D - 3, '#1b2a34', true); y += 0.0032
    brick(inner, 0, y, 0, W - 2, D - 3, body); y += 0.0096
    brick(inner, -u, y, 0, W - 5, D - 3, '#5a93db'); y += 0.0096
    brick(inner, -u, y, 0, W - 5, D - 3, body, true)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const wh = add(inner, new THREE.CylinderGeometry(0.0065, 0.0065, 0.004, 16), matte('#151515'), sx * (W - 4) * u / 2, 0.0065, sz * (D - 2) * u / 2); wh.rotation.x = Math.PI / 2 }
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

// duvet, throw and pillows on a mattress whose top surface is at y = top
function bedding(g, w, d, top) {
  // soft fabric sheet draped over the mattress: sags over the sides, gentle wrinkles
  const drape = (dw, dd, lift, roll, wr) => {
    const dg = new THREE.PlaneGeometry(dw, dd, 72, 54); dg.rotateX(-Math.PI / 2)
    const p = dg.attributes.position
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i)
      const over = Math.max(0, Math.abs(x) - w / 2)
      let y = top + lift - Math.min(over, 0.3) * 1.25 - Math.max(0, over - 0.2) * 0.4
      y += wr * (Math.sin(x * 9 + z * 4) * Math.cos(z * 7 - x * 3) + 0.5 * Math.sin(x * 23 + z * 17))
      if (roll) y += Math.max(0, 1 - Math.abs(z + dd / 2) / 0.12) * 0.03 // folded top edge
      p.setY(i, y)
      if (over > 0.22) p.setX(i, Math.sign(x) * (w / 2 + 0.22 + (over - 0.22) * 0.2))
    }
    dg.computeVertexNormals(); metricUV(dg)
    return dg
  }
  // duvet: draped over the foot two-thirds of the bed
  const dd = d * 0.74
  const duvet = add(g, drape(w + 0.5, dd, 0.055, true, 0.012), fabric(theme.duvet, 'linen', 1.6), 0, 0, d / 2 - dd / 2 + 0.03)
  duvet.material = duvet.material.clone(); duvet.material.side = THREE.DoubleSide
  // navy waffle throw draped across the foot (follows the duvet, hangs over the sides)
  const throwM = fabric(theme.throw, 'waffle').clone(); throwM.side = THREE.DoubleSide
  add(g, drape(w + 0.46, 0.55, 0.072, false, 0.006), throwM, 0, 0, d / 2 - 0.36)
  const n = w > 1.1 ? 2 : 1, pw = n === 2 ? w / 2 - 0.06 : w - 0.2
  for (let i = 0; i < n; i++) {
    const px = n === 2 ? (i ? 1 : -1) * (w / 4) : 0
    const pl = add(g, cushion(pw, 0.13, 0.44, 0.06, 0.05, 0.004), fabric(i ? theme.pillowB : theme.pillowA, 'linen', 1.5), px, top + 0.08, -d / 2 + 0.3)
    pl.rotation.x = -0.25
  }
}

export const CATALOG = {
  bed: {
    label: 'Bed', group: 'Sleep', w: 1.4, d: 2.0, h: 0.56, color: '#c9c3b8',
    presets: [[0.9, 2.0], [1.2, 2.0], [1.4, 2.0], [1.6, 2.0], [1.8, 2.0]],
    build(w, d, h, c) {
      const g = new THREE.Group(), frame = fabric(c, 'linen')
      const legH = 0.08, frameH = h - legH - 0.2
      add(g, cushion(w + 0.06, frameH, d + 0.04, 0.03, 0.006), frame, 0, legH + frameH / 2, 0)
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(g, taperLeg(legH, 0.022, 0.018), oak(), sx * (w / 2 - 0.05), legH / 2, sz * (d / 2 - 0.05))
      add(g, cushion(w + 0.06, 1.05, 0.1, 0.035, 0.02), frame, 0, 0.525, -d / 2 - 0.05)
      const top = h
      add(g, cushion(w - 0.01, 0.2, d - 0.03, 0.05, 0.012), fabric('#f7f6f3', 'linen', 2), 0, top - 0.1, 0)
      bedding(g, w, d, top)
      return g
    },
  },
  nightstand: {
    label: 'Nightstand', group: 'Sleep', w: 0.42, d: 0.38, h: 0.5, color: '#f2f2ef',
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, rbox(w, h - 0.12, d, 0.006), lacquer(c), 0, 0.12 + (h - 0.12) / 2, 0)
      oakLegs(g, w, d, 0.12, 0.04)
      add(g, rbox(w - 0.04, 0.003, 0.004, 0.001), matte('#cfcfcb'), 0, 0.12 + (h - 0.12) * 0.55, d / 2 + 0.001)
      return g
    },
  },
  wardrobe: {
    label: 'Wardrobe', group: 'Sleep', w: 1.0, d: 0.58, h: 2.01, color: '#f2f2ef',
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, rbox(w, h, d - 0.02, 0.004), lacquer(c, 0.45), 0, h / 2, -0.01)
      for (const s of [-1, 1]) {
        add(g, rbox(w / 2 - 0.004, h - 0.02, 0.02, 0.003), lacquer(c, 0.4), s * (w / 4), h / 2, d / 2 - 0.01)
        add(g, new THREE.CylinderGeometry(0.006, 0.006, 0.13, 10), metal('#c8c8c8', 0.3), s * 0.035, h * 0.52, d / 2 + 0.02)
      }
      return g
    },
  },
  dresser: {
    label: 'Chest of drawers', group: 'Sleep', w: 0.8, d: 0.45, h: 0.8, color: '#f2f2ef',
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, rbox(w, h - 0.1, d - 0.02, 0.004), lacquer(c), 0, 0.1 + (h - 0.1) / 2, -0.01)
      oakLegs(g, w, d, 0.1, 0.05)
      const n = 3, dh = (h - 0.1) / n
      for (let i = 0; i < n; i++) {
        add(g, rbox(w - 0.006, dh - 0.004, 0.02, 0.003), lacquer(c, 0.38), 0, 0.1 + dh * (i + 0.5), d / 2 - 0.01)
        add(g, rbox(0.12, 0.012, 0.015, 0.005), oak(), 0, 0.1 + dh * (i + 0.5) + dh * 0.3, d / 2 + 0.006)
      }
      return g
    },
  },
  sofa: {
    label: 'Sofa', group: 'Living', w: 2.1, d: 0.9, h: 0.8, color: '#a8a59f',
    presets: [[1.6, 0.85], [2.1, 0.9], [2.4, 0.95]],
    build(w, d, h, c) {
      const g = new THREE.Group(), f = fabric(c, 'linen'), arm = 0.17, legH = 0.1
      add(g, cushion(w, 0.2, d, 0.04, 0.004), f, 0, legH + 0.1, 0)
      for (const s of [-1, 1]) add(g, cushion(arm, h * 0.78 - legH, d, 0.06, 0.012), f, s * (w / 2 - arm / 2), legH + (h * 0.78 - legH) / 2, 0)
      add(g, cushion(w - 0.02, h - legH - 0.2, 0.18, 0.05, 0.01), f, 0, legH + 0.2 + (h - legH - 0.2) / 2, -d / 2 + 0.09)
      const seats = w > 1.8 ? 3 : 2, sw = (w - 2 * arm) / seats
      for (let i = 0; i < seats; i++) {
        const x = -w / 2 + arm + sw * (i + 0.5)
        add(g, cushion(sw - 0.008, 0.17, d - 0.2, 0.06, 0.022, 0.003), f, x, legH + 0.2 + 0.085, 0.09)
        const b = add(g, cushion(sw - 0.012, h - 0.42, 0.19, 0.07, 0.035, 0.003), f, x, 0.47 + (h - 0.42) / 2 - 0.01, -d / 2 + 0.27)
        b.rotation.x = -0.14
      }
      // throw pillows (beige linen + dark brown velvet-ish, as in the showroom)
      const p1 = add(g, cushion(0.46, 0.46, 0.15, 0.08, 0.06), fabric(theme.cushA, 'linen'), -w / 2 + arm + 0.28, 0.75, -d / 2 + 0.42)
      p1.rotation.set(-0.3, 0.25, 0.05)
      const p2 = add(g, cushion(0.42, 0.42, 0.14, 0.08, 0.06), fabric(theme.cushB, 'boucle', 0.5), -w / 2 + arm + 0.56, 0.72, -d / 2 + 0.45)
      p2.rotation.set(-0.32, 0.1, -0.04)
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(g, taperLeg(legH, 0.02, 0.014), oak(), sx * (w / 2 - 0.08), legH / 2, sz * (d / 2 - 0.08))
      return g
    },
  },
  armchair: {
    label: 'Armchair', group: 'Living', w: 0.8, d: 0.82, h: 0.76, color: '#e9e3d8',
    build(w, d, h, c) {
      const g = new THREE.Group(), f = fabric(c, 'boucle'), legH = 0.16
      add(g, cushion(w, 0.2, d, 0.08, 0.01), f, 0, legH + 0.1, 0)
      add(g, cushion(w - 0.22, 0.14, d - 0.24, 0.06, 0.03, 0.002), f, 0, legH + 0.27, 0.08)
      const back = add(g, cushion(w, h - legH - 0.12, 0.18, 0.08, 0.03), f, 0, legH + 0.12 + (h - legH - 0.12) / 2, -d / 2 + 0.1)
      back.rotation.x = -0.12
      for (const s of [-1, 1]) add(g, cushion(0.12, 0.34, d - 0.06, 0.06, 0.012), f, s * (w / 2 - 0.06), legH + 0.32, 0.01)
      oakLegs(g, w, d, legH, 0.08, 0.06)
      return g
    },
  },
  coffee: {
    label: 'Coffee table', group: 'Living', w: 1.0, d: 0.6, h: 0.42, color: '#f3f2ef',
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, rbox(w, 0.022, d, 0.006), lacquer(c, 0.2), 0, h - 0.011, 0)
      const lm = metal('#d6d3cc', 0.25)
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(g, new THREE.CylinderGeometry(0.008, 0.008, h - 0.022, 10), lm, sx * (w / 2 - 0.04), (h - 0.022) / 2, sz * (d / 2 - 0.04))
      for (const sz of [-1, 1]) { const r = add(g, new THREE.CylinderGeometry(0.006, 0.006, w - 0.08, 8), lm, 0, 0.08, sz * (d / 2 - 0.04)); r.rotation.z = Math.PI / 2 }
      return g
    },
  },
  tvbench: {
    label: 'TV bench', group: 'Living', w: 1.6, d: 0.4, h: 0.45, color: '#f2f2ef',
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, rbox(w, h - 0.12, d, 0.005), lacquer(c), 0, 0.12 + (h - 0.12) / 2, 0)
      oakLegs(g, w, d, 0.12, 0.06)
      for (let i = 1; i < 3; i++) add(g, rbox(0.003, h - 0.14, 0.004, 0.001), matte('#d6d6d2'), -w / 2 + (w / 3) * i, 0.12 + (h - 0.12) / 2, d / 2 + 0.001)
      return g
    },
  },
  tv: {
    label: 'TV', group: 'Living', w: 1.23, d: 0.25, h: 0.78, color: '#111111', elev: 0.45,
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, rbox(w, h - 0.07, 0.03, 0.004), matte(c, 0.3), 0, 0.07 + (h - 0.07) / 2, 0)
      add(g, new THREE.PlaneGeometry(w - 0.02, h - 0.09), memo('scr', () => new THREE.MeshStandardMaterial({ color: '#050608', roughness: 0.05 })), 0, 0.07 + (h - 0.07) / 2, 0.0155)
      add(g, rbox(0.32, 0.012, d * 0.9, 0.005), metal('#2b2b2b'), 0, 0.006, 0); add(g, rbox(0.05, 0.08, 0.03, 0.005), metal('#2b2b2b'), 0, 0.04, 0)
      return g
    },
  },
  bookshelf: {
    label: 'Bookshelf', group: 'Living', w: 0.8, d: 0.28, h: 2.02, color: '#f2f2ef',
    build(w, d, h, c) {
      const g = new THREE.Group(), m = lacquer(c, 0.45), t = 0.018
      add(g, rbox(t, h, d, 0.002), m, -w / 2 + t / 2, h / 2, 0); add(g, rbox(t, h, d, 0.002), m, w / 2 - t / 2, h / 2, 0)
      add(g, new THREE.BoxGeometry(w, h, 0.005), m, 0, h / 2, -d / 2 + 0.0025)
      const n = Math.max(2, Math.round(h / 0.36))
      const books = ['#8a6f5a', '#3f5566', '#c9b8a0', '#6b6f5d', '#a44a3f', '#e3ddd3', '#2f3337', '#b7a48a']
      let k = 0
      for (let i = 0; i <= n; i++) {
        const y = 0.06 + ((h - 0.08) / n) * i
        add(g, rbox(w - 2 * t, t, d, 0.002), m, 0, y, 0)
        if (i < n && i % 2 === 0 || i === 1) {
          let x = -w / 2 + t + 0.02
          while (x < w / 2 - t - 0.12) {
            const bw = 0.02 + ((k * 37) % 7) / 220, bh = 0.2 + ((k * 13) % 9) / 90
            add(g, rbox(bw, bh, d * 0.78, 0.002), matte(books[k % books.length], 0.7), x + bw / 2, y + t / 2 + bh / 2, 0.01)
            x += bw + 0.002; k++
            if (k % 9 === 0) x += 0.16
          }
        }
      }
      return g
    },
  },
  rug: {
    label: 'Rug', group: 'Living', w: 2.0, d: 1.4, h: 0.012, color: '#d6d0c5',
    presets: [[1.6, 2.3], [2.0, 3.0], [1.4, 2.0]],
    noCollide: true,
    build(w, d, h, c) { const g = new THREE.Group(); const m = add(g, rbox(w, h, d, 0.005), fabric(c, 'boucle', 0.6), 0, h / 2, 0); m.castShadow = false; return g },
  },
  dining: {
    label: 'Dining table', group: 'Dining', w: 1.2, d: 0.8, h: 0.75, color: '#c49a6c',
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, rbox(w, 0.028, d, 0.006), oak(), 0, h - 0.014, 0)
      add(g, rbox(w - 0.12, 0.07, d - 0.12, 0.004), oak(), 0, h - 0.063, 0)
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(g, rbox(0.045, h - 0.03, 0.045, 0.006), oak(), sx * (w / 2 - 0.07), (h - 0.03) / 2, sz * (d / 2 - 0.07))
      return g
    },
  },
  roundtable: {
    label: 'Round table', group: 'Dining', w: 0.9, d: 0.9, h: 0.75, color: '#f4f2ee',
    build(w, d, h, c) {
      const g = new THREE.Group()
      const top = add(g, new THREE.CylinderGeometry(w / 2, w / 2, 0.025, 64), lacquer(c, 0.25), 0, h - 0.0125, 0); top.scale.z = d / w
      add(g, new THREE.CylinderGeometry(0.035, 0.035, h - 0.025, 20), lacquer('#141414', 0.35), 0, (h - 0.025) / 2, 0)
      add(g, new THREE.CylinderGeometry(0.24, 0.26, 0.02, 48), lacquer('#141414', 0.35), 0, 0.01, 0)
      return g
    },
  },
  chair: {
    // bentwood café chair (Thonet No. 18 style), like the black chairs in the photos
    label: 'Bentwood chair', group: 'Dining', w: 0.42, d: 0.5, h: 0.86, color: '#151515',
    build(w, d, h, c) {
      const g = new THREE.Group(), m = lacquer(c, 0.32), sx = w / 0.42, sz = d / 0.5, sy = h / 0.86
      const inner = new THREE.Group(); inner.scale.set(sx, sy, sz); g.add(inner)
      const ring = add(inner, new THREE.TorusGeometry(0.2, 0.012, 10, 48), m, 0, 0.455, 0.02); ring.rotation.x = Math.PI / 2
      add(inner, new THREE.CylinderGeometry(0.198, 0.198, 0.016, 48), m, 0, 0.452, 0.02)
      const lr = add(inner, new THREE.TorusGeometry(0.17, 0.008, 8, 40), m, 0, 0.2, 0.02); lr.rotation.x = Math.PI / 2
      for (const s of [-1, 1]) {
        add(inner, tube([[s * 0.15, 0, 0.19], [s * 0.145, 0.22, 0.165], [s * 0.14, 0.445, 0.14]], 0.012), m)
        add(inner, tube([[s * 0.15, 0, -0.2], [s * 0.15, 0.25, -0.16], [s * 0.15, 0.45, -0.15], [s * 0.15, 0.68, -0.2], [s * 0.13, 0.84, -0.235]], 0.013), m)
      }
      add(inner, tube([[-0.13, 0.84, -0.235], [-0.08, 0.875, -0.25], [0, 0.885, -0.255], [0.08, 0.875, -0.25], [0.13, 0.84, -0.235]], 0.013), m)
      add(inner, tube([[-0.148, 0.55, -0.17], [-0.1, 0.78, -0.22], [0, 0.82, -0.235], [0.1, 0.78, -0.22], [0.148, 0.55, -0.17]], 0.009), m)
      return g
    },
  },
  desk: {
    label: 'Desk', group: 'Work', w: 1.2, d: 0.6, h: 0.74, color: '#f2f2ef',
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, rbox(w, 0.025, d, 0.005), lacquer(c, 0.3), 0, h - 0.0125, 0)
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(g, rbox(0.035, h - 0.025, 0.035, 0.004), oak(), sx * (w / 2 - 0.05), (h - 0.025) / 2, sz * (d / 2 - 0.05))
      return g
    },
  },
  officechair: {
    label: 'Office chair', group: 'Work', w: 0.62, d: 0.62, h: 1.05, color: '#3a3c3f',
    build(w, d, h, c) {
      const g = new THREE.Group(), f = fabric(c, 'boucle', 0.6), m = metal('#2a2a2a', 0.4)
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2
        const leg = add(g, rbox(0.04, 0.03, w / 2, 0.01), m, Math.sin(a) * w / 4, 0.07, Math.cos(a) * w / 4); leg.rotation.y = a
        add(g, new THREE.SphereGeometry(0.025, 12, 8), matte('#111'), Math.sin(a) * w / 2.1, 0.025, Math.cos(a) * w / 2.1)
      }
      add(g, new THREE.CylinderGeometry(0.025, 0.025, 0.36, 12), m, 0, 0.27, 0)
      add(g, cushion(0.5, 0.08, 0.48, 0.04, 0.015), f, 0, 0.48, 0.02)
      const b = add(g, cushion(0.46, h - 0.6, 0.07, 0.04, 0.015), f, 0, 0.6 + (h - 0.6) / 2, -0.24); b.rotation.x = -0.1
      return g
    },
  },
  floorlamp: {
    label: 'Floor lamp', group: 'Decor', w: 0.4, d: 0.4, h: 1.55, color: '#ece6db', noCollide: true,
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, new THREE.CylinderGeometry(0.15, 0.16, 0.02, 32), metal('#1d1d1d', 0.5), 0, 0.01, 0)
      add(g, new THREE.CylinderGeometry(0.008, 0.008, h - 0.3, 8), metal('#1d1d1d', 0.5), 0, (h - 0.3) / 2, 0)
      const shade = memo('shade' + c, () => {
        const m = fabric(c, 'linen').clone(); m.side = THREE.DoubleSide; m.emissive = new THREE.Color('#ffcf96'); m.emissiveIntensity = 0; m.userData.lampShade = true; return m
      })
      add(g, metricUV(new THREE.CylinderGeometry(w * 0.4, w / 2, 0.3, 40, 1, true)), shade, 0, h - 0.15, 0)
      return g
    },
  },
  plant: {
    label: 'Plant (large)', group: 'Decor', w: 0.6, d: 0.6, h: 1.0, color: '#5c7a45', uniform: true,
    build(w, d, h) { return modelInstance('potted_plant_02', h) },
  },
  plantsmall: {
    label: 'Plant (small)', group: 'Decor', w: 0.3, d: 0.3, h: 0.45, color: '#5c7a45', uniform: true,
    build(w, d, h) { return modelInstance('potted_plant_04', h) },
  },
  vase: {
    label: 'Vase', group: 'Decor', w: 0.15, d: 0.15, h: 0.3, color: '#ffffff', uniform: true, noCollide: true, elev: 0.75,
    build(w, d, h) { return modelInstance('ceramic_vase_01', h) },
  },
  basket: {
    label: 'Wicker basket', group: 'Decor', w: 0.38, d: 0.3, h: 0.117, color: '#a07850', uniform: true, noCollide: true,
    build(w, d, h) { return modelInstance('wicker_basket_01', h) },
  },
  frame: {
    label: 'Picture frame', group: 'Decor', w: 0.2, d: 0.1, h: 0.25, color: '#ffffff', uniform: true, noCollide: true, elev: 0.75,
    build(w, d, h) { return modelInstance('standing_picture_frame_01', h) },
  },
  legoshelf: {
    // IKEA Kallax-style 2×4 cube shelf full of Lego builds
    label: 'Lego display shelf', group: 'Decor', w: 0.77, d: 0.39, h: 1.47, color: '#f2f2ef',
    build(w, d, h, c) {
      const g = new THREE.Group(), m = lacquer(c, 0.4), t = 0.035, cols = 2, rows = 4
      add(g, rbox(w, t, d, 0.003), m, 0, t / 2, 0); add(g, rbox(w, t, d, 0.003), m, 0, h - t / 2, 0)
      add(g, rbox(t, h, d, 0.003), m, -w / 2 + t / 2, h / 2, 0); add(g, rbox(t, h, d, 0.003), m, w / 2 - t / 2, h / 2, 0)
      add(g, rbox(0.016, h - 2 * t, d, 0.002), m, 0, h / 2, 0)
      const ch = (h - 2 * t - (rows - 1) * 0.016) / rows
      for (let r = 1; r < rows; r++) add(g, rbox(w - 2 * t, 0.016, d, 0.002), m, 0, t + r * (ch + 0.016) - 0.008, 0)
      add(g, new THREE.BoxGeometry(w - 0.01, h - 0.01, 0.004), matte('#e9e8e4'), 0, h / 2, -d / 2 + 0.002)
      let seed = 3
      for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
        const set = legoSet(seed++, 0.95)
        set.position.set((k - 0.5) * (w / 2 - 0.01), t + r * (ch + 0.016), 0.02)
        set.rotation.y = (seed % 3 - 1) * 0.35
        g.add(set)
      }
      return g
    },
  },
  lego: {
    label: 'Lego set', group: 'Decor', w: 0.25, d: 0.2, h: 0.15, color: '#c91a09', noCollide: true, elev: 0.75,
    build() { return legoSet(Math.floor(Math.random() * 1000), 1.1) },
  },
  wallart: {
    // framed print hung on a wall; abstract art in the style's colours
    label: 'Wall art', group: 'Decor', w: 0.7, d: 0.03, h: 0.9, color: '#1c1c1c', noCollide: true, elev: 1.2,
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, rbox(w, h, d, 0.004), matte(c, 0.5), 0, h / 2, 0)
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = Math.round(256 * h / w)
      const x = cv.getContext('2d'), A = theme.art
      x.fillStyle = '#f3efe7'; x.fillRect(0, 0, cv.width, cv.height)
      let r = Math.floor(w * 977 + h * 131)
      const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280)
      for (let k = 0; k < 6; k++) {
        x.fillStyle = A[k % A.length]; x.globalAlpha = 0.9
        x.beginPath()
        if (k % 2) x.arc(rnd() * cv.width, rnd() * cv.height, 20 + rnd() * 70, 0, Math.PI * 2)
        else x.rect(rnd() * cv.width * 0.7, rnd() * cv.height * 0.7, 40 + rnd() * 120, 30 + rnd() * 140)
        x.fill()
      }
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace
      add(g, new THREE.PlaneGeometry(w - 0.06, h - 0.06), new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 }), 0, h / 2, d / 2 + 0.001)
      return g
    },
  },
  stringlights: {
    // fairy lights hanging in a gentle curve (W = length)
    label: 'String lights', group: 'Decor', w: 2.0, d: 0.05, h: 0.25, color: '#ffd9a0', noCollide: true, elev: 2.2,
    build(w, d, h, c) {
      const g = new THREE.Group(), pts = []
      for (let i = 0; i <= 40; i++) { const t = i / 40; pts.push(new THREE.Vector3(-w / 2 + t * w, h - h * Math.sin(Math.PI * t), 0)) }
      add(g, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 0.0018, 4), matte('#2a2a2a'))
      const bulb = glow('string', '#fff2d8', c), n = Math.max(6, Math.round(w / 0.1))
      for (let i = 0; i <= n; i++) { const t = i / n; const m = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), bulb); m.position.set(-w / 2 + t * w, h - h * Math.sin(Math.PI * t) - 0.012, 0); g.add(m) }
      g.userData.lightSource = { kind: 'string', color: c }
      return g
    },
  },
  monitor: {
    label: 'Gaming monitor 27"', group: 'Work', w: 0.62, d: 0.22, h: 0.5, color: '#111111', noCollide: true, elev: 0.75,
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, rbox(w, 0.36, 0.025, 0.006), matte(c, 0.3), 0, h - 0.18, 0)
      add(g, new THREE.PlaneGeometry(w - 0.02, 0.34), glow('screen', '#0b0f1a', '#3a6cff'), 0, h - 0.18, 0.0135)
      add(g, rbox(0.05, h - 0.36, 0.04, 0.006), matte('#1a1a1a', 0.4), 0, (h - 0.36) / 2 + 0.01, -0.03)
      add(g, rbox(0.24, 0.012, d, 0.004), matte('#1a1a1a', 0.4), 0, 0.006, 0)
      add(g, rbox(0.44, 0.02, 0.14, 0.004), matte('#1d1d1f', 0.5), 0, 0.01, 0.2) // keyboard
      add(g, new THREE.BoxGeometry(0.43, 0.004, 0.13), glow('rgb', '#111', '#b14cff'), 0, 0.021, 0.2)
      add(g, rbox(0.065, 0.025, 0.11, 0.02), matte('#1d1d1f', 0.5), 0.3, 0.012, 0.2) // mouse
      g.userData.lightSource = { kind: 'screen', color: '#5a7dff' }
      return g
    },
  },
  gamingpc: {
    label: 'Gaming PC (RGB)', group: 'Work', w: 0.22, d: 0.45, h: 0.48, color: '#141416',
    build(w, d, h, c) {
      const g = new THREE.Group()
      add(g, rbox(w - 0.05, h, d, 0.008), matte(c, 0.35), -0.025, h / 2, 0) // closed side + internals
      for (const z of [-d / 2 + 0.006, d / 2 - 0.006]) add(g, new THREE.BoxGeometry(w, h, 0.012), matte(c, 0.35), 0, h / 2, z) // front/back frame
      for (const y of [0.006, h - 0.006]) add(g, new THREE.BoxGeometry(w, 0.012, d), matte(c, 0.35), 0, y, 0)
      const glass = new THREE.MeshStandardMaterial({ color: '#202028', roughness: 0.05, transparent: true, opacity: 0.35 })
      add(g, new THREE.PlaneGeometry(d - 0.04, h - 0.04), glass, w / 2 + 0.001, h / 2, 0).rotation.y = Math.PI / 2
      for (const [y, z] of [[h * 0.72, -d * 0.2], [h * 0.45, -d * 0.2], [h * 0.6, d * 0.25]]) {
        const f = add(g, new THREE.TorusGeometry(0.05, 0.007, 8, 24), glow('rgb', '#111', '#b14cff'), w / 2 - 0.018, y, z); f.rotation.y = Math.PI / 2
      }
      g.userData.lightSource = { kind: 'rgb', color: '#b14cff' }
      return g
    },
  },
  candle: {
    label: 'Candles', group: 'Decor', w: 0.18, d: 0.12, h: 0.16, color: '#f3ede2', noCollide: true, elev: 0.75,
    build(w, d, h, c) {
      const g = new THREE.Group()
      for (const [x, z, hh] of [[-0.05, 0, 0.14], [0.03, 0.025, 0.1], [0.05, -0.03, 0.07]]) {
        add(g, new THREE.CylinderGeometry(0.022, 0.022, hh, 20), matte(c, 0.7), x, hh / 2, z)
        const fl = new THREE.Mesh(new THREE.SphereGeometry(0.007, 10, 8), glow('flame', '#ffd27a', '#ff9a2a')); fl.scale.y = 1.8; fl.position.set(x, hh + 0.012, z); g.add(fl)
      }
      g.userData.lightSource = { kind: 'candle', color: '#ffad4d' }
      return g
    },
  },
  bistro: {
    // balcony: small round table + two folding chairs (black metal)
    label: 'Balcony bistro set', group: 'Balcony', w: 1.3, d: 0.65, h: 0.72, color: '#1e1f21',
    build(w, d, h, c) {
      const g = new THREE.Group(), m = memo('bistroMetal' + c, () => new THREE.MeshStandardMaterial({ color: '#3a3d40', roughness: 0.45, metalness: 0.55, side: THREE.DoubleSide }))
      add(g, new THREE.CylinderGeometry(0.3, 0.3, 0.02, 40), m, 0, h - 0.01, 0)
      add(g, new THREE.CylinderGeometry(0.015, 0.015, h - 0.02, 10), m, 0, (h - 0.02) / 2, 0)
      add(g, new THREE.CylinderGeometry(0.18, 0.2, 0.015, 30), m, 0, 0.008, 0)
      // two French bistro folding chairs, facing the table
      const tube = (pts, r = 0.009) => add(g2, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((q) => new THREE.Vector3(...q))), 24, r, 8), m)
      let g2
      for (const s of [-1, 1]) {
        g2 = new THREE.Group(); g2.position.set(s * 0.5, 0, 0); g2.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2; g.add(g2)
        const sw = 0.38, sd = 0.36, sy = 0.45
        // back legs rise into the backrest frame (slight rake), front legs straight
        for (const x of [-sw / 2, sw / 2]) {
          tube([[x, 0, -sd / 2 - 0.04], [x, sy, -sd / 2], [x * 0.96, 0.62, -sd / 2 - 0.03], [x * 0.92, 0.82, -sd / 2 - 0.06]])
          tube([[x, 0, sd / 2 + 0.02], [x, sy, sd / 2 - 0.01]])
        }
        // seat frame + slats
        tube([[-sw / 2, sy, sd / 2 - 0.01], [sw / 2, sy, sd / 2 - 0.01]], 0.008)
        tube([[-sw / 2, sy, -sd / 2], [sw / 2, sy, -sd / 2]], 0.008)
        for (let k = 0; k < 5; k++) add(g2, rbox(sw - 0.01, 0.012, sd / 5 - 0.012, 0.004), m, 0, sy + 0.012, -sd / 2 + (k + 0.5) * sd / 5)
        // backrest: two curved boards between the back legs
        for (const [y, zb] of [[0.66, -sd / 2 - 0.035], [0.77, -sd / 2 - 0.052]]) {
          const bg = new THREE.CylinderGeometry(0.75, 0.75, 0.06, 24, 1, true, -0.25, 0.5)
          const bm = new THREE.Mesh(bg, m); bm.material = m
          bm.position.set(0, y, zb + 0.75 - 0.02); bm.rotation.y = Math.PI; bm.castShadow = true
          bm.material.side = THREE.DoubleSide
          g2.add(bm)
        }
        // folding cross-brace under the seat
        tube([[-sw / 2, 0.12, sd / 2 + 0.015], [sw / 2, 0.12, sd / 2 + 0.015]], 0.006)
        tube([[-sw / 2, 0.15, -sd / 2 - 0.03], [sw / 2, 0.15, -sd / 2 - 0.03]], 0.006)
      }
      return g
    },
  },
  // ---------------------------------------------------------------- the user's own IKEA pieces
  raholmar: {
    // RÅHOLMAR pocket-spring base on 20 cm legs (35 cm total), with a thin top mattress and bedding
    label: 'RÅHOLMAR bed', group: 'Sleep', w: 1.2, d: 2.0, h: 0.41, color: '#d9d0c1',
    presets: [[0.9, 2.0], [1.2, 2.0], [1.4, 2.0], [1.6, 2.0]],
    build(w, d, h, c) {
      const g = new THREE.Group(), legH = 0.2, baseH = 0.15
      add(g, cushion(w, baseH, d, 0.02, 0.004), fabric(c, 'linen'), 0, legH + baseH / 2, 0)
      for (const sx of [-1, 1]) for (const sz of [-1, 0, 1]) add(g, taperLeg(legH, 0.02, 0.016), oak(), sx * (w / 2 - 0.08), legH / 2, sz * (d / 2 - 0.12))
      add(g, cushion(w - 0.01, h - legH - baseH, d - 0.01, 0.03, 0.006), fabric('#f7f6f3', 'linen', 2), 0, legH + baseH + (h - legH - baseH) / 2, 0)
      bedding(g, w, d, h)
      return g
    },
  },
  gullaberg: {
    // GULLABERG bedside table: drawer on top, open shelf below, tall tapered legs
    label: 'GULLABERG bedside', group: 'Sleep', w: 0.53, d: 0.43, h: 0.69, color: '#f3f1ec',
    build(w, d, h, c) {
      const g = new THREE.Group(), m = lacquer(c, 0.5), t = 0.018, caseH = 0.17, legW = 0.032
      add(g, rbox(w, t, d, 0.004), m, 0, h - t / 2, 0)
      add(g, rbox(w - 0.02, caseH, d - 0.02, 0.003), m, 0, h - t - caseH / 2, 0)
      add(g, rbox(w - 0.05, caseH - 0.03, 0.004, 0.002), lacquer(c, 0.42), 0, h - t - caseH / 2, d / 2 - 0.008)
      add(g, new THREE.SphereGeometry(0.014, 16, 10), oak(), 0, h - t - caseH / 2, d / 2 - 0.0)
      const shelfY = 0.3
      add(g, rbox(w - 0.02, t, d - 0.02, 0.003), m, 0, shelfY, 0)
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const leg = add(g, new THREE.CylinderGeometry(legW * 0.62, legW * 0.42, h - t, 4), m, sx * (w / 2 - 0.03), (h - t) / 2, sz * (d / 2 - 0.03))
        leg.rotation.y = Math.PI / 4
      }
      return g
    },
  },
  kallax: {
    // KALLAX 2x4 shelf on its side: 147 x 39 x 77, 33 cm cubes, no back panel
    label: 'KALLAX 2×4', group: 'Living', w: 1.47, d: 0.39, h: 0.77, color: '#f4f3f0',
    presets: [[1.47, 0.39], [0.77, 0.39]],
    build(w, d, h, c) {
      const g = new THREE.Group(), m = lacquer(c, 0.45), T = 0.038, t = 0.016
      const cols = Math.max(1, Math.round((w - T) / 0.35)), rows = Math.max(1, Math.round((h - T) / 0.35))
      add(g, rbox(w, T, d, 0.003), m, 0, h - T / 2, 0)
      add(g, rbox(w, T, d, 0.003), m, 0, T / 2, 0)
      for (const s of [-1, 1]) add(g, rbox(T, h - 2 * T, d, 0.002), m, s * (w / 2 - T / 2), h / 2, 0)
      const cw = (w - 2 * T - (cols - 1) * t) / cols, ch = (h - 2 * T - (rows - 1) * t) / rows
      for (let i = 1; i < cols; i++) add(g, new THREE.BoxGeometry(t, h - 2 * T, d), m, -w / 2 + T + i * cw + (i - 0.5) * t, h / 2, 0)
      for (let j = 1; j < rows; j++) add(g, new THREE.BoxGeometry(w - 2 * T, t, d), m, 0, T + j * ch + (j - 0.5) * t, 0)
      // a few books in one cube, a fabric box in another
      const books = ['#3f5566', '#c9b8a0', '#8a6f5a', '#e3ddd3', '#2f3337', '#a44a3f']
      if (cols > 1) {
        let x = -w / 2 + T + 0.02
        for (let k = 0; k < 9; k++) {
          const bw = 0.02 + ((k * 37) % 7) / 260, bh = Math.min(ch - 0.04, 0.2 + ((k * 13) % 9) / 80)
          add(g, rbox(bw, bh, d * 0.7, 0.002), matte(books[k % books.length], 0.7), x + bw / 2, T + bh / 2, 0.02)
          x += bw + 0.002
        }
        const bx = -w / 2 + T + (cols - 1) * (cw + t) + cw / 2
        add(g, cushion(cw - 0.02, ch - 0.02, d - 0.06, 0.01, 0.004), fabric('#cfc6b6', 'linen'), bx, T + ch / 2, 0.01)
      }
      return g
    },
  },
  pinntorp: {
    // PINNTORP round table: light-brown stained pine top on white stained legs, Ø85 cm
    label: 'PINNTORP table', group: 'Dining', w: 0.85, d: 0.85, h: 0.75, color: '#b8895a',
    build(w, d, h, c) {
      const g = new THREE.Group(), legM = matte('#ece7dd', 0.55)
      const top = add(g, metricUV(new THREE.CylinderGeometry(w / 2, w / 2, 0.028, 64)), matte(c, 0.5), 0, h - 0.014, 0); top.scale.z = d / w
      const ap = add(g, new THREE.CylinderGeometry(w / 2 - 0.09, w / 2 - 0.09, 0.07, 48, 1, true), legM, 0, h - 0.063, 0); ap.scale.z = d / w
      ap.material = legM.clone(); ap.material.side = THREE.DoubleSide
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2, r = w / 2 - 0.12
        add(g, new THREE.CylinderGeometry(0.024, 0.018, h - 0.028, 12), legM, Math.cos(a) * r, (h - 0.028) / 2, Math.sin(a) * r * (d / w))
      }
      return g
    },
  },
  relatera: {
    // RELATERA desk 90x60: white melamine top, white frame, rail between front and back legs
    label: 'RELATERA desk', group: 'Work', w: 0.9, d: 0.6, h: 0.72, color: '#f4f4f2',
    build(w, d, h, c) {
      const g = new THREE.Group(), m = lacquer(c, 0.35), fr = lacquer('#f1f1ef', 0.4)
      add(g, rbox(w, 0.022, d, 0.004), m, 0, h - 0.011, 0)
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) add(g, rbox(0.035, h - 0.022, 0.035, 0.006), fr, sx * (w / 2 - 0.035), (h - 0.022) / 2, sz * (d / 2 - 0.035))
        add(g, rbox(0.025, 0.025, d - 0.07, 0.005), fr, sx * (w / 2 - 0.035), 0.12, 0)
        add(g, rbox(0.025, 0.05, d - 0.07, 0.005), fr, sx * (w / 2 - 0.035), h - 0.05, 0)
      }
      add(g, rbox(w - 0.07, 0.05, 0.02, 0.005), fr, 0, h - 0.05, -d / 2 + 0.035)
      add(g, tube([[w / 2, h - 0.06, 0.1], [w / 2 + 0.03, h - 0.07, 0.1], [w / 2 + 0.03, h - 0.12, 0.1], [w / 2 + 0.015, h - 0.11, 0.1]], 0.005), fr)
      return g
    },
  },
  showercurtain: {
    // LUDDHAGTORN 180x200 on an L-shaped corner rail: w along the open front, d along the open side
    label: 'LUDDHAGTORN curtain', group: 'Bath', w: 0.8, d: 0.8, h: 2.0, color: '#f2f2f0', noCollide: true,
    build(w, d, h, c) {
      const g = new THREE.Group(), r = 0.18
      // rail path (local): from the wall at (-w/2, d/2) along the front, round the corner, back to (w/2, -d/2)
      const path = new THREE.CurvePath()
      path.add(new THREE.LineCurve3(new THREE.Vector3(-w / 2, 0, d / 2), new THREE.Vector3(w / 2 - r, 0, d / 2)))
      path.add(new THREE.QuadraticBezierCurve3(new THREE.Vector3(w / 2 - r, 0, d / 2), new THREE.Vector3(w / 2, 0, d / 2), new THREE.Vector3(w / 2, 0, d / 2 - r)))
      path.add(new THREE.LineCurve3(new THREE.Vector3(w / 2, 0, d / 2 - r), new THREE.Vector3(w / 2, 0, -d / 2)))
      const L = path.getLength(), cols = 160, rows = 24, amp = 0.022, pleat = 0.11
      const pos = [], idx = []
      for (let i = 0; i <= cols; i++) {
        const u = i / cols, p = path.getPointAt(u), tg = path.getTangentAt(u)
        const nx = tg.z, nz = -tg.x // outward normal
        for (let j = 0; j <= rows; j++) {
          const v = j / rows, y = h - 0.04 - v * (h - 0.06)
          const a = amp * (0.8 + 0.4 * v) * Math.sin((u * L * Math.PI * 2) / pleat)
          pos.push(p.x + nx * a, y, p.z + nz * a)
        }
      }
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const a = i * (rows + 1) + j, b = a + rows + 1
        idx.push(a, b, a + 1, b, b + 1, a + 1)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals()
      const cm = memo('showerCurtain' + c, () => { const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, side: THREE.DoubleSide }); m.userData.noBake = true; return m }) // one-sided bake would light the inside
      add(g, geo, cm)
      for (let k = 0; k <= Math.floor(L / 0.12); k++) {
        const p = path.getPointAt(Math.min(1, (k * 0.12) / L)), ring = add(g, new THREE.TorusGeometry(0.016, 0.003, 6, 16), metal('#d9d9d9', 0.3), p.x, h - 0.025, p.z)
        ring.rotation.y = Math.atan2(path.getTangentAt(Math.min(1, (k * 0.12) / L)).x, path.getTangentAt(Math.min(1, (k * 0.12) / L)).z)
      }
      return g
    },
  },
  bathmat: {
    label: 'FINTSEN bath mat', group: 'Bath', w: 0.6, d: 0.4, h: 0.015, color: '#d9cdb9', noCollide: true,
    build(w, d, h, c) { const g = new THREE.Group(); const m = add(g, cushion(w, h, d, 0.006, 0.002), fabric(c, 'boucle', 0.5), 0, h / 2, 0); m.castShadow = false; return g },
  },
  laundrybag: {
    // KLUNKA: free-standing white laundry bag with black handles, Ø36 x 60 cm
    label: 'KLUNKA laundry bag', group: 'Bath', w: 0.36, d: 0.36, h: 0.6, color: '#f1f0ec',
    build(w, d, h, c) {
      const g = new THREE.Group(), f = fabric(c, 'linen').clone(); f.side = THREE.DoubleSide
      const pts = [[0, 0], [w * 0.46, 0], [w * 0.5, 0.03], [w * 0.5, h * 0.55], [w * 0.47, h * 0.8], [w * 0.49, h * 0.95], [w * 0.47, h]].map(([x, y]) => new THREE.Vector2(x, y))
      const bag = add(g, metricUV(new THREE.LatheGeometry(pts, 40)), f, 0, 0, 0); bag.scale.z = d / w
      const p = bag.geometry.attributes.position
      for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(z, x); const k = 1 + 0.035 * Math.sin(a * 5 + y * 9) * (y / h); p.setXYZ(i, x * k, y, z * k) }
      bag.geometry.computeVertexNormals()
      add(g, new THREE.CylinderGeometry(w * 0.46, w * 0.46, 0.25, 32), matte('#cfcbc2', 0.9), 0, 0.27, 0) // laundry inside
      const hm = matte('#1d1d1d', 0.7)
      for (const s of [-1, 1]) add(g, tube([[s * w * 0.47, h - 0.02, -0.07], [s * w * 0.5, h + 0.07, -0.04], [s * w * 0.5, h + 0.07, 0.04], [s * w * 0.47, h - 0.02, 0.07]], 0.008), hm)
      return g
    },
  },
  bin: {
    label: 'Bathroom bin', group: 'Bath', w: 0.21, d: 0.21, h: 0.28, color: '#f2f2f0',
    build(w, d, h, c) {
      const g = new THREE.Group(), m = lacquer(c, 0.3)
      const body = add(g, new THREE.CylinderGeometry(w / 2, w / 2 - 0.01, h - 0.02, 40), m, 0, (h - 0.02) / 2, 0); body.scale.z = d / w
      const lid = add(g, new THREE.CylinderGeometry(w / 2 + 0.002, w / 2 + 0.002, 0.02, 40), lacquer('#e4e4e2', 0.25), 0, h - 0.01, 0); lid.scale.z = d / w
      add(g, rbox(0.08, 0.012, 0.05, 0.004), metal('#cfcfcf', 0.3), 0, 0.012, d / 2 + 0.02) // pedal
      return g
    },
  },
  plates: {
    label: 'Plates', group: 'Kitchen', w: 0.26, d: 0.26, h: 0.09, color: '#f6f5f1', noCollide: true, elev: 0.91,
    build(w, d, h, c) {
      const g = new THREE.Group(), m = memo('plate' + c, () => new THREE.MeshStandardMaterial({ color: c, roughness: 0.12 }))
      const r = w / 2, prof = [[0, 0], [r * 0.6, 0], [r * 0.65, 0.004], [r * 0.95, 0.014], [r, 0.02], [r * 0.97, 0.022], [r * 0.62, 0.008], [0, 0.008]].map(([x, y]) => new THREE.Vector2(x, y))
      const geo = new THREE.LatheGeometry(prof, 48), n = Math.max(1, Math.round(h / 0.015))
      for (let i = 0; i < n; i++) add(g, geo, m, 0, i * 0.015, 0)
      return g
    },
  },
  glasses: {
    label: 'Glasses', group: 'Kitchen', w: 0.2, d: 0.12, h: 0.11, color: '#e8f0f0', noCollide: true, elev: 0.91,
    build(w, d, h, c) {
      const g = new THREE.Group()
      const m = memo('glass' + c, () => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.04, metalness: 0, transmission: 0.95, thickness: 0.004, transparent: true, opacity: 0.45, side: THREE.DoubleSide }))
      const r = 0.036, prof = [[0, 0], [r * 0.92, 0], [r * 0.95, 0.008], [r, h], [r - 0.002, h], [r * 0.93, 0.01], [0, 0.01]].map(([x, y]) => new THREE.Vector2(x, y))
      const geo = new THREE.LatheGeometry(prof, 32)
      for (const [x, z] of [[-w / 2 + r, -d / 2 + r], [0.0, d / 2 - r], [w / 2 - r, -d / 2 + r]]) { const gl = add(g, geo, m, x, 0, z); gl.castShadow = false }
      return g
    },
  },
  utensils: {
    // ceramic crock with wooden spoons and a spatula
    label: 'Utensil holder', group: 'Kitchen', w: 0.12, d: 0.12, h: 0.32, color: '#e9e4da', noCollide: true, elev: 0.91,
    build(w, d, h, c) {
      const g = new THREE.Group(), r = w / 2, ch = 0.15
      const prof = [[0, 0], [r * 0.9, 0], [r, 0.01], [r, ch], [r - 0.006, ch], [r - 0.006, 0.012], [0, 0.012]].map(([x, y]) => new THREE.Vector2(x, y))
      add(g, new THREE.LatheGeometry(prof, 40), memo('crock' + c, () => new THREE.MeshStandardMaterial({ color: c, roughness: 0.3, side: THREE.DoubleSide })), 0, 0, 0)
      const wood = oak(), black = matte('#1c1c1c', 0.5)
      const tools = [[-0.02, -0.01, 0.12, 0.1, wood, 'spoon'], [0.02, 0.01, -0.1, 0.08, wood, 'spat'], [0.0, 0.02, 0.04, -0.14, black, 'ladle'], [0.015, -0.02, -0.05, -0.06, black, 'whisk']]
      for (const [x, z, rx, rz, m, kind] of tools) {
        const t = new THREE.Group(); t.position.set(x, 0.02, z); t.rotation.set(rx, 0, rz); g.add(t)
        add(t, new THREE.CylinderGeometry(0.006, 0.007, h - 0.06, 8), m, 0, (h - 0.06) / 2, 0)
        if (kind === 'spoon' || kind === 'ladle') { const b = add(t, new THREE.SphereGeometry(0.024, 16, 10), m, 0, h - 0.04, 0); b.scale.set(1, 1.5, 0.45) }
        if (kind === 'spat') add(t, rbox(0.055, 0.075, 0.006, 0.003), m, 0, h - 0.04, 0)
        if (kind === 'whisk') for (let k = 0; k < 4; k++) { const loop = add(t, new THREE.TorusGeometry(0.02, 0.0015, 4, 20), metal('#cfcfcf', 0.2), 0, h - 0.045, 0); loop.scale.y = 2; loop.rotation.y = (k * Math.PI) / 4 }
      }
      return g
    },
  },
  oakchair: {
    // oak dining chair: round tapered legs, light upholstered seat, curved bent-ply back on the rear posts
    label: 'Oak chair', group: 'Dining', w: 0.46, d: 0.5, h: 0.79, color: '#efede8',
    build(w, d, h, c) {
      const g = new THREE.Group(), wood = matte('#d8be98', 0.55), seatY = 0.45, fz = d / 2 - 0.04, bz = -d / 2 + 0.045, fx = w / 2 - 0.035
      for (const sx of [-1, 1]) {
        add(g, new THREE.CylinderGeometry(0.017, 0.012, seatY - 0.01, 16), wood, sx * fx, (seatY - 0.01) / 2, fz)
        add(g, new THREE.CylinderGeometry(0.017, 0.012, h - 0.04, 16), wood, sx * fx, (h - 0.04) / 2, bz)
        add(g, rbox(0.02, 0.06, d - 0.11, 0.004), wood, sx * (fx - 0.005), seatY - 0.06, (fz + bz) / 2)
      }
      for (const z of [fz, bz]) add(g, rbox(2 * fx - 0.03, 0.06, 0.02, 0.004), wood, 0, seatY - 0.06, z)
      add(g, cushion(w + 0.01, 0.05, d - 0.02, 0.022, 0.008), fabric(c, 'linen', 0.7), 0, seatY + 0.005, 0.005)
      // bent plywood back: a thin slab curved around the sitter, edges swept forward
      const bw = w + 0.04, back = new THREE.BoxGeometry(bw, 0.2, 0.014, 32, 1, 1), p = back.attributes.position
      for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, p.getZ(i) + 0.45 * x * x + 0.04 * Math.max(0, y) * (x * x) * 8) }
      back.computeVertexNormals(); metricUV(back)
      const b = add(g, back, wood, 0, h - 0.135, bz + 0.026); b.rotation.x = -0.12
      return g
    },
  },
  bygglek: {
    // IKEA × LEGO BYGGLEK storage box: studs on the lid so builds can sit on top (large 35×26×12)
    label: 'BYGGLEK LEGO box', group: 'Decor', w: 0.35, d: 0.26, h: 0.12, color: '#f4f4f2', noCollide: true,
    presets: [[0.35, 0.26], [0.26, 0.18], [0.18, 0.13]],
    build(w, d, h, c) {
      const g = new THREE.Group(), m = memo('bygglek' + c, () => new THREE.MeshStandardMaterial({ color: c, roughness: 0.22 }))
      add(g, rbox(w, h - 0.01, d, 0.006), m, 0, (h - 0.01) / 2, 0)
      add(g, rbox(w + 0.002, 0.012, d + 0.002, 0.004), m, 0, h - 0.006, 0)
      const nx = Math.floor((w - 0.01) / 0.008), nz = Math.floor((d - 0.01) / 0.008)
      const stud = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.0024, 0.0024, 0.0017, 10), m, nx * nz), o = new THREE.Object3D()
      let i = 0
      for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) { o.position.set((a - (nx - 1) / 2) * 0.008, h + 0.0008, (b - (nz - 1) / 2) * 0.008); o.updateMatrix(); stud.setMatrixAt(i++, o.matrix) }
      stud.castShadow = true; g.add(stud)
      return g
    },
  },
  mosslanda: {
    // IKEA MOSSLANDA picture ledge (115 cm) with framed prints leaning on it
    label: 'MOSSLANDA picture ledge', group: 'Decor', w: 1.15, d: 0.12, h: 0.5, color: '#f2f2ef', noCollide: true, elev: 1.15,
    presets: [[1.15, 0.12], [0.55, 0.12]],
    build(w, d, h, c) {
      const g = new THREE.Group(), m = lacquer(c, 0.4)
      add(g, rbox(w, 0.07, 0.02, 0.003), m, 0, 0.035 - 0.07, -d / 2 + 0.01) // back plate (hangs below the shelf)
      add(g, rbox(w, 0.018, d, 0.003), m, 0, 0.009 - 0.018, 0)
      add(g, rbox(w, 0.03, 0.012, 0.003), m, 0, 0.01, d / 2 - 0.006) // lip that stops the frames sliding off
      const prints = ['#2f4566', '#c9b79c', '#8a6f55', '#e3ddd3', '#6f7a5d', '#1c1d20']
      const frames = [[0.3, 0.4, '#1d1d1d'], [0.21, 0.3, '#f2f2ef'], [0.4, 0.3, '#c49a6c'], [0.21, 0.3, '#1d1d1d']]
      let x = -w / 2 + 0.06, k = 0
      for (const [fw, fh, fc] of frames) {
        if (x + fw > w / 2) break
        const f = new THREE.Group(); f.position.set(x + fw / 2, 0, -d / 2 + 0.035); f.rotation.x = -0.09; g.add(f)
        add(f, rbox(fw, fh, 0.02, 0.003), matte(fc, 0.45), 0, fh / 2, 0)
        add(f, new THREE.PlaneGeometry(fw - 0.06, fh - 0.06), matte('#f6f4ef', 0.8), 0, fh / 2, 0.0105)
        add(f, new THREE.PlaneGeometry(fw - 0.1, fh - 0.1), matte(prints[k++ % prints.length], 0.7), 0, fh / 2, 0.011)
        x += fw + 0.05
      }
      return g
    },
  },
  tertial: {
    // IKEA TERTIAL clamp work lamp: two arms and a cone shade, Ø17 cm
    label: 'TERTIAL desk lamp', group: 'Work', w: 0.2, d: 0.2, h: 0.62, color: '#3d3f42', noCollide: true, elev: 0.72,
    build(w, d, h, c) {
      const g = new THREE.Group(), m = metal(c, 0.55)
      add(g, rbox(0.05, 0.03, 0.06, 0.006), m, 0, -0.015, 0) // clamp
      add(g, new THREE.CylinderGeometry(0.012, 0.012, 0.05, 12), m, 0, 0.025, 0)
      const arm = (len, ax, az, ox, oy, oz) => {
        const a = new THREE.Group(); a.position.set(ox, oy, oz); a.rotation.set(ax, 0, az); g.add(a)
        for (const sx of [-0.008, 0.008]) add(a, new THREE.CylinderGeometry(0.004, 0.004, len, 8), m, sx, len / 2, 0)
        return a
      }
      arm(0.4, -0.35, 0, 0, 0.05, 0)
      const ex = 0, ey = 0.05 + 0.4 * Math.cos(0.35), ez = -0.4 * Math.sin(0.35)
      arm(0.32, 1.6, 0, ex, ey, ez)
      const hx = 0, hy = ey + 0.32 * Math.cos(1.6), hz = ez + 0.32 * Math.sin(1.6)
      const shade = add(g, new THREE.CylinderGeometry(0.025, 0.085, 0.13, 32, 1, true), memo('tert' + c, () => { const s = metal(c, 0.55).clone(); s.side = THREE.DoubleSide; return s }), hx, hy - 0.05, hz + 0.02)
      shade.rotation.x = 0.25
      add(g, new THREE.SphereGeometry(0.03, 16, 10), glow('lamp', '#fff6e5', '#ffd9a0'), hx, hy - 0.09, hz + 0.03)
      return g
    },
  },
  skadis: {
    // IKEA SKÅDIS pegboard 56×56 with a shelf, a pen cup and a hook
    label: 'SKÅDIS pegboard', group: 'Work', w: 0.56, d: 0.12, h: 0.56, color: '#f4f4f2', noCollide: true, elev: 0.95,
    build(w, d, h, c) {
      const g = new THREE.Group()
      const tex = memo('skadisTex', () => {
        const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256
        const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 256, 256); x.fillStyle = '#9a9a96'
        for (let r = 0; r < 14; r++) for (let k = 0; k < 14; k++) { const ox = 9 + k * 17.5 + (r % 2) * 8.75; x.beginPath(); x.roundRect(ox, 6 + r * 17.5, 4, 11, 2); x.fill() }
        const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t
      })
      add(g, rbox(w, h, 0.012, 0.004), memo('skadis' + c, () => new THREE.MeshStandardMaterial({ color: c, map: tex, roughness: 0.5 })), 0, h / 2, -d / 2 + 0.006)
      const acc = matte('#f4f4f2', 0.45)
      add(g, rbox(0.28, 0.012, 0.1, 0.003), acc, -0.1, h * 0.55, -d / 2 + 0.06) // shelf
      add(g, rbox(0.06, 0.09, 0.05, 0.004), matte('#c9b79c', 0.6), -0.18, h * 0.55 + 0.05, -d / 2 + 0.06)
      add(g, new THREE.CylinderGeometry(0.035, 0.035, 0.09, 20), acc, 0.16, h * 0.25, -d / 2 + 0.05) // pen cup
      for (const [px, pc] of [[0.15, '#2f4566'], [0.17, '#a44a3f'], [0.165, '#1d1d1d']]) { const pen = add(g, new THREE.CylinderGeometry(0.004, 0.004, 0.14, 6), matte(pc), px, h * 0.25 + 0.06, -d / 2 + 0.05); pen.rotation.z = (px - 0.16) * 6 }
      add(g, tube([[0.18, h * 0.8, -d / 2 + 0.012], [0.18, h * 0.8, -d / 2 + 0.06], [0.18, h * 0.8 + 0.03, -d / 2 + 0.07]], 0.004), metal('#cfcfcf', 0.3)) // hook
      const hp = add(g, new THREE.TorusGeometry(0.075, 0.012, 10, 32, Math.PI * 1.2), matte('#1d1d1f', 0.5), 0.18, h * 0.8 - 0.07, -d / 2 + 0.07); hp.rotation.z = -0.3 // headphones
      return g
    },
  },
  gladom: {
    // IKEA GLADOM tray table, Ø45 × 53 cm: lift-off tray with a raised rim on a powder-coated steel frame
    label: 'GLADOM tray table', group: 'Living', w: 0.45, d: 0.45, h: 0.53, color: '#f1f1ee',
    build(w, d, h, c) {
      const g = new THREE.Group(), m = memo('gladom' + c, () => new THREE.MeshStandardMaterial({ color: c, roughness: 0.38, metalness: 0.15, side: THREE.DoubleSide }))
      const r = w / 2, prof = [[0, 0], [r - 0.012, 0], [r - 0.004, 0.006], [r, 0.035], [r - 0.006, 0.036], [r - 0.012, 0.009], [0, 0.009]].map(([x, y]) => new THREE.Vector2(x, y))
      const tray = add(g, new THREE.LatheGeometry(prof, 64), m, 0, h - 0.036, 0); tray.scale.z = d / w
      // four legs from under the tray rim, splayed slightly, joined by a ring halfway down
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2, top = [Math.cos(a) * (r - 0.06), h - 0.036, Math.sin(a) * (r - 0.06) * (d / w)], foot = [Math.cos(a) * (r - 0.02), 0, Math.sin(a) * (r - 0.02) * (d / w)]
        add(g, tube([top, [(top[0] + foot[0]) / 2, h / 2, (top[2] + foot[2]) / 2], foot], 0.006), m)
      }
      const ring = add(g, new THREE.TorusGeometry(r - 0.045, 0.005, 8, 48), m, 0, h * 0.42, 0); ring.rotation.x = Math.PI / 2; ring.scale.y = d / w
      return g
    },
  },
  console: {
    // slim hallway console: shallow top on four thin legs with a low shelf (fits along a wall, keeps the walkway)
    label: 'Slim console table', group: 'Living', w: 0.9, d: 0.26, h: 0.75, color: '#f3f2ef',
    presets: [[0.9, 0.26], [1.2, 0.3], [0.7, 0.24]],
    build(w, d, h, c) {
      const g = new THREE.Group(), m = lacquer(c, 0.3), legs = lacquer(c, 0.35)
      add(g, rbox(w, 0.028, d, 0.004), m, 0, h - 0.014, 0)
      add(g, rbox(w - 0.04, 0.05, d - 0.03, 0.003), m, 0, h - 0.053, 0) // apron
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(g, rbox(0.03, h - 0.028, 0.03, 0.004), legs, sx * (w / 2 - 0.03), (h - 0.028) / 2, sz * (d / 2 - 0.03))
      add(g, rbox(w - 0.06, 0.018, d - 0.04, 0.003), m, 0, 0.2, 0) // lower shelf
      return g
    },
  },
  box: {
    label: 'Custom box', group: 'Other', w: 0.6, d: 0.6, h: 0.6, color: '#9bb4c9',
    build(w, d, h, c) { const g = new THREE.Group(); add(g, rbox(w, h, d, 0.008), matte(c, 0.7), 0, h / 2, 0); return g },
  },
}
