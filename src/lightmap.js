import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'

// Baked light, the way games do it: Blender (Cycles) bakes the empty room's global illumination into
// one lightmap atlas, plus a grid of light probes per room. Walk mode shades the room as albedo × baked
// light, and the furniture reads the probes wherever it stands, so it can move freely without the bake
// going stale. The sun's direct beam stays live (with the live shadow map), so furniture still casts
// real sun shadows on the baked floor.
//
//   bake time: exportBake() → bake.glb + bake.json + bake.bin   (dev/bake.mjs drives this)
//              Blender bakes bake.glb's lightmap UVs → lightmap.exr  (dev/bake.py)
//   run time:  loadBake() → applyBake() / applyFurniture() / clearBake()

const ATLAS = 2048, PAD = 3

// ------------------------------------------------------------------ which meshes get baked light
const mats = (o) => (Array.isArray(o.material) ? o.material : [o.material])
function bakeableMat(m) {
  return m && m.visible !== false && m.isMeshStandardMaterial && !m.userData.noBake && !m.transparent && m.metalness < 0.5 && !m.userData.glow && !m.userData.lampShade
}
const _s = new THREE.Vector3()
function bakeable(o) {
  if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) return false
  const g = o.geometry
  if (!g || !g.attributes.position || !g.attributes.normal || g.morphAttributes.position) return false
  // tiny parts (LEGO studs, pens, flames) stay live-lit: baking them costs Blender a whole object each
  // and looks no different. Needs world matrices to be current (collectTargets updates them first).
  if (!g.boundingSphere) g.computeBoundingSphere()
  o.matrixWorld.decompose(_v, _q, _s)
  if (g.boundingSphere.radius * Math.max(_s.x, _s.y, _s.z) < 0.04) return false
  return mats(o).every(bakeableMat)
}
const _v = new THREE.Vector3(), _q = new THREE.Quaternion()
function visibleChain(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true }

// baked surfaces in a stable order: the apartment shell only. Furniture is never baked into the
// lightmap; it reads the probe grid instead, so it can move without the bake going stale.
function collectTargets(aptRoot) {
  const out = []
  let i = 0
  aptRoot.updateMatrixWorld(true)
  aptRoot.traverse((o) => { if (bakeable(o) && visibleChain(o)) out.push({ mesh: o, key: `a${i++}`, frame: null }) })
  return out
}

// ------------------------------------------------------------------ light probes
// a grid of tiny cubes per room, baked in the same atlas: each cube face records the light arriving
// from that side (an "ambient cube"), so furniture anywhere in the room gets the right ambient light
const PROBE = { step: 0.5, inset: 0.15, size: 0.03, texels: 2 }
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
function axis(a, b, step) {
  const L = Math.max(0, b - a)
  const n = L < 0.2 ? 1 : Math.max(2, Math.round(L / step) + 1)
  return { n, o: n === 1 ? (a + b) / 2 : a, s: n === 1 ? 1 : L / (n - 1) }
}
function probeRooms(rooms) {
  let first = 0
  return rooms.map(([x1, z1, x2, z2, top = 2.5]) => {
    const X = axis(x1 + PROBE.inset, x2 - PROBE.inset, PROBE.step), Z = axis(z1 + PROBE.inset, z2 - PROBE.inset, PROBE.step)
    const Y = axis(0.15, top - 0.3, 0.65)
    const r = { rect: [x1, z1, x2, z2], origin: [X.o, Y.o, Z.o], step: [X.s, Y.s, Z.s], dims: [X.n, Y.n, Z.n], first }
    first += X.n * Y.n * Z.n
    return r
  })
}
function probePositions(r) {
  const out = []
  for (let iz = 0; iz < r.dims[2]; iz++) for (let iy = 0; iy < r.dims[1]; iy++) for (let ix = 0; ix < r.dims[0]; ix++)
    out.push(new THREE.Vector3(r.origin[0] + ix * r.step[0], r.origin[1] + iy * r.step[1], r.origin[2] + iz * r.step[2]))
  return out
}
// a probe stuck inside a wall or a cabinet sees the backs of faces in most directions: skip it
function probeValid(p, aptRoot, ray) {
  let inside = 0
  const d = new THREE.Vector3(), n = new THREE.Vector3()
  for (const f of FACES) {
    ray.set(p, d.set(...f)); ray.far = 1.5
    const h = ray.intersectObject(aptRoot, true).find((h) => h.face && mats(h.object).every((m) => m && m.visible !== false && !m.transparent))
    if (h && n.copy(h.face.normal).transformDirection(h.object.matrixWorld).dot(d) > 0) inside++
  }
  return inside < 3
}

// positions of a target in its frame (apartment: world; furniture: item space, so a chart's size never
// depends on where the item stands), non-indexed so every triangle can sit in its own chart
function framePositions(t) {
  const g = t.mesh.geometry.index ? t.mesh.geometry.toNonIndexed() : t.mesh.geometry.clone()
  const m = t.mesh.matrixWorld.clone()
  if (t.frame) m.premultiply(t.frame.matrixWorld.clone().invert())
  g.applyMatrix4(m)
  return g
}

// ------------------------------------------------------------------ charts + atlas packing
// triangles are grouped by dominant normal axis and edge connectivity, then projected flat (metres)
function charts(pos) {
  const n = pos.count / 3, label = new Int8Array(n), parent = new Int32Array(n), area = new Float32Array(n)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3()
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const edges = new Map(), q = (i) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`
  for (let t = 0; t < n; t++) {
    parent[t] = t
    a.fromBufferAttribute(pos, 3 * t); b.fromBufferAttribute(pos, 3 * t + 1); c.fromBufferAttribute(pos, 3 * t + 2)
    e1.subVectors(b, a).cross(e2.subVectors(c, a)); area[t] = e1.length() / 2
    const ax = Math.abs(e1.x), ay = Math.abs(e1.y), az = Math.abs(e1.z)
    label[t] = ax >= ay && ax >= az ? (e1.x > 0 ? 0 : 1) : ay >= az ? (e1.y > 0 ? 2 : 3) : (e1.z > 0 ? 4 : 5)
    const v = [q(3 * t), q(3 * t + 1), q(3 * t + 2)]
    for (let k = 0; k < 3; k++) {
      const p1 = v[k], p2 = v[(k + 1) % 3], key = (p1 < p2 ? p1 + '|' + p2 : p2 + '|' + p1) + '|' + label[t]
      const o = edges.get(key)
      if (o === undefined) edges.set(key, t); else parent[find(t)] = find(o)
    }
  }
  const byRoot = new Map()
  for (let t = 0; t < n; t++) { const r = find(t); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(t) }
  const out = []
  for (const tris of byRoot.values()) {
    const L = label[tris[0]], ua = L < 2 ? 2 : 0, va = L < 2 || L > 3 ? 1 : 2
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity, ar = 0
    for (const t of tris) {
      ar += area[t]
      for (let k = 0; k < 3; k++) {
        const i = 3 * t + k, u = pos.getComponent(i, ua), v = pos.getComponent(i, va)
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v)
      }
    }
    out.push({ tris, ua, va, u0, v0, w: u1 - u0, h: v1 - v0, area: ar })
  }
  return out
}

// shelf packing at a given density (texels per metre); returns false if it overflows the atlas
function pack(list, density) {
  const order = list.map((c, i) => i)
  for (const c of list) {
    if (c.fixed) { c.tw = c.th = c.fixed + 2 * PAD; continue }
    const k = density * (c.scale ?? 1); c.tw = Math.ceil(c.w * k) + 2 * PAD; c.th = Math.ceil(c.h * k) + 2 * PAD
  }
  order.sort((i, j) => (list[j].th - list[i].th) || (i - j))
  let x = 0, y = 0, rowH = 0
  for (const i of order) {
    const c = list[i]
    if (c.tw > ATLAS) return false
    if (x + c.tw > ATLAS) { x = 0; y += rowH; rowH = 0 }
    c.px = x; c.py = y; x += c.tw; rowH = Math.max(rowH, c.th)
    if (y + rowH > ATLAS) return false
  }
  return true
}

// ------------------------------------------------------------------ export (bake time)
// material albedo for the bounce light: colour × average of its colour texture
const avgCache = new Map()
function albedo(m) {
  const col = m.color ? m.color.clone() : new THREE.Color(1, 1, 1)
  const img = m.map && m.map.image
  if (img && (img.width || img.videoWidth)) {
    if (!avgCache.has(img)) {
      try {
        const cv = document.createElement('canvas'); cv.width = cv.height = 16
        const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, 16, 16)
        const d = cx.getImageData(0, 0, 16, 16).data, s = [0, 0, 0]
        for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += srgbToLinear(d[i + k] / 255)
        avgCache.set(img, new THREE.Color(s[0] / 256, s[1] / 256, s[2] / 256))
      } catch { avgCache.set(img, new THREE.Color(0.6, 0.6, 0.6)) }
    }
    col.multiply(avgCache.get(img))
  }
  return col
}
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

export async function exportBake({ scene, aptRoot, meta, rooms = [], exclude = [] }) {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
  scene.updateMatrixWorld(true)
  const targets = collectTargets(aptRoot)
  const set = new Set(targets.map((t) => t.mesh))
  // charts for every target, then one density that fills the atlas
  const all = []
  for (const t of targets) {
    t.local = framePositions(t)
    t.charts = charts(t.local.attributes.position)
    all.push(...t.charts)
  }
  // charts hidden behind/under other geometry (slab under the parquet, cabinet backs against walls)
  // get a tenth of the resolution, so the atlas goes to surfaces you can actually see
  const ray = new THREE.Raycaster(), A = new THREE.Vector3(), Bv = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), O = new THREE.Vector3()
  const hitOther = (mesh, o, d, far) => { ray.set(o, d); ray.far = far; return ray.intersectObject(aptRoot, true).some((h) => h.object !== mesh && h.object.isMesh && mats(h.object).every((m) => m && m.visible !== false && !m.transparent)) }
  for (const t of targets) {
    const pos = t.local.attributes.position
    for (const c of t.charts) {
      const tris = c.tris.length <= 9 ? c.tris : Array.from({ length: 9 }, (_, k) => c.tris[Math.floor(((k + 0.5) / 9) * c.tris.length)])
      let inside = false
      const hidden = tris.every((tri) => {
        A.fromBufferAttribute(pos, 3 * tri); Bv.fromBufferAttribute(pos, 3 * tri + 1); C.fromBufferAttribute(pos, 3 * tri + 2)
        N.subVectors(Bv, A).cross(O.subVectors(C, A)); if (N.lengthSq() < 1e-14) return true
        N.normalize(); const ctr = A.add(Bv).add(C).multiplyScalar(1 / 3)
        if (rooms.some(([x1, z1, x2, z2, top]) => ctr.x > x1 - 0.03 && ctr.x < x2 + 0.03 && ctr.z > z1 - 0.03 && ctr.z < z2 + 0.03 && ctr.y > -0.08 && ctr.y < top + 0.03)) inside = true
        return hitOther(t.mesh, O.copy(ctr).addScaledVector(N, 0.0005), N, 0.012) ||
          hitOther(t.mesh, O.copy(ctr).addScaledVector(N, 0.003), N.clone().negate(), 0.0034)
      })
      // outside every room (facade, window reveals, wall tops): half the resolution; covered: a tenth
      // (never zero, so a surface wrongly judged hidden still gets real light instead of black)
      c.scale = hidden ? 0.1 : inside ? 1 : 0.5
    }
  }
  // probes: raycasts need to see the backs of faces to tell "inside a wall" apart
  const pRooms = probeRooms(rooms), probes = [], valid = []
  const sides = []
  aptRoot.traverse((o) => { if (o.isMesh) for (const m of mats(o)) if (m && m.side !== THREE.DoubleSide) { sides.push([m, m.side]); m.side = THREE.DoubleSide } })
  for (const r of pRooms) for (const p of probePositions(r)) { probes.push(p); valid.push(probeValid(p, aptRoot, ray) ? 1 : 0) }
  for (const [m, side] of sides) m.side = side
  const blocks = probes.flatMap(() => FACES.map(() => ({ fixed: PROBE.texels })))
  const live = all.concat(blocks)
  let lo = 1, hi = 2000
  for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (pack(live, mid)) lo = mid; else hi = mid }
  pack(live, lo)
  // lightmap uv per vertex (three convention: v up from the bottom of the texture)
  for (const t of targets) {
    const pos = t.local.attributes.position, uv = new Float32Array(pos.count * 2)
    for (const c of t.charts) for (const tri of c.tris) for (let k = 0; k < 3; k++) {
      const i = 3 * tri + k, d = lo * (c.scale ?? 1)
      uv[2 * i] = (c.px + PAD + (pos.getComponent(i, c.ua) - c.u0) * d) / ATLAS
      uv[2 * i + 1] = (c.py + PAD + (pos.getComponent(i, c.va) - c.v0) * d) / ATLAS
    }
    t.uv = uv
  }
  // the probe cubes: one quad per face, filling its block
  const h = PROBE.size / 2, F = PROBE.texels, pp = [], pn = [], pu = []
  const a = new THREE.Vector3(), b = new THREE.Vector3(), q = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  probes.forEach((p, i) => FACES.forEach((f, k) => {
    const blk = blocks[i * 6 + k], n = new THREE.Vector3(...f)
    const ax = f.findIndex((v) => v !== 0), u = new THREE.Vector3(), v = new THREE.Vector3()
    u.setComponent((ax + 1) % 3, 1); v.setComponent((ax + 2) % 3, 1)
    const corner = [[0, 0], [1, 0], [1, 1], [0, 1]]
    corner.forEach(([su, sv], j) => q[j].copy(p).addScaledVector(n, h).addScaledVector(u, (su * 2 - 1) * h).addScaledVector(v, (sv * 2 - 1) * h))
    // wind each quad so its face normal points out of the cube
    const order = a.subVectors(q[1], q[0]).cross(b.subVectors(q[2], q[0])).dot(n) > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]
    for (const j of order) {
      pp.push(q[j].x, q[j].y, q[j].z); pn.push(...f)
      pu.push((blk.px + PAD + corner[j][0] * F) / ATLAS, (blk.py + PAD + corner[j][1] * F) / ATLAS)
    }
  }))
  const probeGeo = new THREE.BufferGeometry()
  probeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3)); probeGeo.setAttribute('normal', new THREE.Float32BufferAttribute(pn, 3))
  // the export scene: world-space copies, plain albedo materials; lightmap uv as TEXCOORD_0 with v flipped
  // (glTF's v runs top-down; this way Blender's bake lands where three samples it)
  const out = new THREE.Scene(), matMap = new Map()
  const plain = (m) => {
    if (!matMap.has(m)) matMap.set(m, new THREE.MeshStandardMaterial({ name: `M${matMap.size}`, color: albedo(m), roughness: 1, metalness: 0, side: THREE.DoubleSide }))
    return matMap.get(m)
  }
  const flipV = (uv) => { const f = Float32Array.from(uv); for (let i = 1; i < f.length; i += 2) f[i] = 1 - f[i]; return f }
  const add = (mesh, name, uv) => {
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k)
    g.applyMatrix4(mesh.matrixWorld)
    if (uv) g.setAttribute('uv', new THREE.BufferAttribute(flipV(uv), 2))
    const m = Array.isArray(mesh.material) ? mesh.material.map(plain) : plain(mesh.material)
    const o = new THREE.Mesh(g, m); o.name = name; out.add(o)
  }
  targets.forEach((t, i) => add(t.mesh, `T${i}`, t.uv))
  if (probes.length) {
    probeGeo.setAttribute('uv', new THREE.BufferAttribute(flipV(pu), 2))
    const pm = new THREE.Mesh(probeGeo, new THREE.MeshStandardMaterial({ name: 'probe', color: 0xffffff, roughness: 1, metalness: 0 })); pm.name = 'P0'; out.add(pm)
  }
  // everything else that blocks or bounces light (context buildings, ground, metal, small decor),
  // except the furniture and the avatar: they move, so they stay out of the bake
  const skip = new Set()
  for (const g of exclude) g && g.traverse((o) => skip.add(o))
  let n = 0
  scene.traverse((o) => {
    if (!o.isMesh || set.has(o) || skip.has(o) || !visibleChain(o) || o.name === 'skybox' || o.isSkinnedMesh || o.isInstancedMesh) return
    if (o.userData.noPick || mats(o).some((m) => !m || m.transparent || !m.isMeshStandardMaterial || m.side === THREE.BackSide)) return
    if (!o.geometry || !o.geometry.attributes.normal) return
    o.geometry.computeBoundingSphere()
    if (o.geometry.boundingSphere.radius > 200) return
    add(o, `O${n++}`)
  })
  const glb = await new GLTFExporter().parseAsync(out, { binary: true })
  // uv per baked mesh for the runtime (uint16, normalised)
  const meshes = [], chunks = []
  let off = 0
  for (const t of targets) {
    const q16 = new Uint16Array(t.uv.length)
    for (let i = 0; i < q16.length; i++) q16[i] = Math.round(t.uv[i] * 65535)
    meshes.push({ key: t.key, count: t.uv.length / 2, offset: off }); chunks.push(q16); off += q16.length
  }
  const bin = new Uint16Array(off)
  { let o = 0; for (const c of chunks) { bin.set(c, o); o += c.length } }
  const stats = { charts: all.length, probes: probes.length, validProbes: valid.reduce((s, v) => s + v, 0) }
  const probeJson = { texels: F, pad: PAD, rooms: pRooms, valid, blocks: blocks.flatMap((b) => [b.px, b.py]) }
  const json = { version: 2, atlas: ATLAS, density: lo, stats, ...meta, probes: probeJson, meshes }
  return { glb, json, bin: bin.buffer }
}

// ------------------------------------------------------------------ runtime
// The bake holds every light except the sun's direct beam (Blender bakes it separately and subtracts it).
// The sun is added back live, with the live shadow map, so moved furniture casts real sun shadows.
// one bake per time of day, in bake/h09/, bake/h15/ ...; bake/index.json lists the hours
export async function bakeHours(id, version = '') {
  const r = await fetch(`/apartments/${id}/bake/index.json${version ? `?v=${version}` : ''}`, { cache: version ? 'no-store' : 'default' })
  if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return []
  return (await r.json()).hours || []
}
export async function loadBake(id, hour, version = '') {
  const base = `/apartments/${id}/bake/h${String(hour).padStart(2, '0')}/`, v = version ? `?v=${version}` : ''
  const r = await fetch(base + 'bake.json' + v, { cache: version ? 'no-store' : 'default' })
  if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null
  const json = await r.json()
  if (json.version !== 2 || !json.probes) return null // older bake (furniture baked in): re-bake
  const bin = new Uint16Array(await (await fetch(base + 'bake.bin' + v, { cache: version ? 'no-store' : 'default' })).arrayBuffer())
  const tex = await new EXRLoader().setDataType(THREE.HalfFloatType).loadAsync(base + 'lightmap.exr' + v)
  tex.channel = 1; tex.colorSpace = THREE.LinearSRGBColorSpace
  tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  const byKey = new Map(json.meshes.map((m) => [m.key, m]))
  const u = {
    tint: { value: new THREE.Vector3(...(json.whiteBalance || [1, 1, 1])) },
    intensity: { value: json.intensity ?? 1 },
    sunScale: { value: json.sunScale ?? 0 },
  }
  const probes = buildProbes(json.probes, tex.image)
  return { json, bin, tex, byKey, u, probes, room: [], furn: [], patched: new Map(), get applied() { return this.room } }
}

// ambient cubes from the atlas → one 3D texture: per room, six slabs (+x -x +y -y +z -z) of nx × ny × nz
function buildProbes(P, img) {
  const { data, width } = img, half = THREE.DataUtils.fromHalfFloat, F = P.texels
  const cube = (i, k) => {
    const bx = P.blocks[2 * (i * 6 + k)] + P.pad, by = P.blocks[2 * (i * 6 + k) + 1] + P.pad, c = [0, 0, 0]
    for (let y = 0; y < F; y++) for (let x = 0; x < F; x++) { const o = ((by + y) * width + bx + x) * 4; for (let j = 0; j < 3; j++) c[j] += half(data[o + j]) / (F * F) }
    return c
  }
  const X = Math.max(...P.rooms.map((r) => r.dims[0])), Y = Math.max(...P.rooms.map((r) => r.dims[1]))
  let Z = 0
  for (const r of P.rooms) { r.z0 = Z; Z += r.dims[2] * 6 }
  const out = new Uint16Array(X * Y * Z * 4)
  for (const r of P.rooms) {
    const [nx, ny, nz] = r.dims, cnt = nx * ny * nz
    const vals = [], ok = []
    for (let i = 0; i < cnt; i++) { ok.push(P.valid[r.first + i] === 1); vals.push(FACES.map((_, k) => cube(r.first + i, k))) }
    // probes inside walls / cabinets: borrow from valid neighbours, layer by layer
    const idx = (x, y, z) => (z * ny + y) * nx + x
    for (let pass = 0; pass < 12 && ok.includes(false); pass++) {
      const add = []
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const i = idx(x, y, z); if (ok[i]) continue
        const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([a, b, c]) => [x + a, y + b, z + c])
          .filter(([a, b, c]) => a >= 0 && b >= 0 && c >= 0 && a < nx && b < ny && c < nz && ok[idx(a, b, c)]).map(([a, b, c]) => idx(a, b, c))
        if (nb.length) add.push([i, FACES.map((_, k) => [0, 1, 2].map((j) => nb.reduce((s, n) => s + vals[n][k][j], 0) / nb.length))])
      }
      for (const [i, v] of add) { vals[i] = v; ok[i] = true }
    }
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) for (let k = 0; k < 6; k++) {
      const v = vals[idx(x, y, z)][k], o = (((r.z0 + k * nz + z) * Y + y) * X + x) * 4
      for (let j = 0; j < 3; j++) out[o + j] = THREE.DataUtils.toHalfFloat(Math.max(0, v[j]))
      out[o + 3] = THREE.DataUtils.toHalfFloat(1)
    }
  }
  const tex = new THREE.Data3DTexture(out, X, Y, Z)
  tex.type = THREE.HalfFloatType; tex.format = THREE.RGBAFormat
  tex.minFilter = tex.magFilter = THREE.LinearFilter
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping
  tex.unpackAlignment = 1; tex.needsUpdate = true
  return { tex, size: new THREE.Vector3(X, Y, Z), rooms: P.rooms }
}

// the sun's own light at this pixel (colour × intensity × N·L × shadow), captured from the light loop
const SUN_CHUNK = (() => {
  const c = THREE.ShaderChunk.lights_fragment_begin
  const at = c.indexOf('RE_Direct( directLight', c.indexOf('NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'))
  return 'vec3 bakeSun = vec3( 0.0 );\n' + c.slice(0, at) +
    'if ( UNROLLED_LOOP_INDEX == 0 ) bakeSun = directLight.color * saturate( dot( geometryNormal, directLight.direction ) );\n\t\t' + c.slice(at)
})()
const lightFrom = (light) => `vec3 outgoingLight = diffuseColor.rgb * ( 1.0 - metalnessFactor ) * ( ${light} + bakeSun * bakeSunScale ) * bakeTint + reflectedLight.indirectSpecular + totalEmissiveRadiance;`
const OUT = 'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;'

// room surfaces: albedo × (baked light + live sun), plus the live environment reflection so glossy floors keep their sheen
function patched(bake, m) {
  if (bake.patched.has(m)) return bake.patched.get(m)
  const p = m.clone()
  p.lightMap = bake.tex; p.lightMapIntensity = 1
  p.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { bakeTint: bake.u.tint, bakeIntensity: bake.u.intensity, bakeSunScale: bake.u.sunScale })
    sh.fragmentShader = 'uniform vec3 bakeTint;\nuniform float bakeIntensity, bakeSunScale;\n' + sh.fragmentShader
      .replace('#include <lights_fragment_begin>', SUN_CHUNK)
      .replace(OUT, lightFrom('texture2D( lightMap, vLightMapUv ).rgb * bakeIntensity'))
  }
  p.customProgramCacheKey = () => 'baked2'
  p.userData.baked = true
  bake.patched.set(m, p)
  return p
}

// furniture: the same, with the light read from the room's probe grid at each pixel
const PROBE_GLSL = `
uniform highp sampler3D probeTex;
uniform vec3 probeOrigin, probeStep, probeDims, probeTexSize;
uniform float probeZ0;
varying vec3 vProbeW;
vec3 probeFace( vec3 g, float f ) {
  return texture( probeTex, vec3( ( g.xy + 0.5 ) / probeTexSize.xy, ( probeZ0 + f * probeDims.z + g.z + 0.5 ) / probeTexSize.z ) ).rgb;
}
vec3 probeLight( vec3 w, vec3 n ) {
  vec3 g = clamp( ( w - probeOrigin ) / probeStep, vec3( 0.0 ), probeDims - 1.0 ), n2 = n * n;
  return n2.x * probeFace( g, n.x > 0.0 ? 0.0 : 1.0 ) + n2.y * probeFace( g, n.y > 0.0 ? 2.0 : 3.0 ) + n2.z * probeFace( g, n.z > 0.0 ? 4.0 : 5.0 );
}
`
function probeMat(bake, m, ri) {
  const key = m.uuid + ':' + ri
  if (bake.patched.has(key)) return bake.patched.get(key)
  const r = bake.probes.rooms[ri], p = m.clone()
  const ru = {
    probeTex: { value: bake.probes.tex }, probeTexSize: { value: bake.probes.size },
    probeOrigin: { value: new THREE.Vector3(...r.origin) }, probeStep: { value: new THREE.Vector3(...r.step) },
    probeDims: { value: new THREE.Vector3(...r.dims) }, probeZ0: { value: r.z0 },
  }
  p.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, ru, { bakeTint: bake.u.tint, bakeIntensity: bake.u.intensity, bakeSunScale: bake.u.sunScale })
    sh.vertexShader = 'varying vec3 vProbeW;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  vec4 probeP = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
  probeP = batchingMatrix * probeP;
  #endif
  #ifdef USE_INSTANCING
  probeP = instanceMatrix * probeP;
  #endif
  vProbeW = ( modelMatrix * probeP ).xyz;`)
    sh.fragmentShader = 'uniform vec3 bakeTint;\nuniform float bakeIntensity, bakeSunScale;\n' + PROBE_GLSL + sh.fragmentShader
      .replace('#include <lights_fragment_begin>', SUN_CHUNK)
      .replace(OUT, lightFrom('probeLight( vProbeW, inverseTransformDirection( normal, viewMatrix ) ) * bakeIntensity'))
  }
  p.customProgramCacheKey = () => 'probe2'
  p.userData.baked = true
  bake.patched.set(key, p)
  return p
}
const probeable = (m) => m && m.visible !== false && m.isMeshStandardMaterial && !m.transparent && m.metalness < 0.5 && !m.userData.glow && !m.userData.lampShade

// which room's grid an item reads: the smallest room around its centre, else the nearest
function roomOf(bake, x, z) {
  let best = -1, score = Infinity
  bake.probes.rooms.forEach((r, i) => {
    const [x1, z1, x2, z2] = r.rect
    const out = Math.hypot(Math.max(x1 - x, 0, x - x2), Math.max(z1 - z, 0, z - z2))
    const s = out > 0 ? 1e6 + out : (x2 - x1) * (z2 - z1)
    if (s < score) { score = s; best = i }
  })
  return best
}

export function applyBake(bake, aptRoot, planner) {
  clearBake(bake)
  for (const t of collectTargets(aptRoot)) {
    const rec = bake.byKey.get(t.key)
    if (!rec) continue
    const src = t.mesh.geometry, g = src.index ? src.toNonIndexed() : src.clone()
    if (g.attributes.position.count !== rec.count) { g.dispose(); continue }
    const uv = new Float32Array(rec.count * 2)
    for (let i = 0; i < uv.length; i++) uv[i] = bake.bin[rec.offset + i] / 65535
    g.setAttribute('uv1', new THREE.BufferAttribute(uv, 2))
    const mat = t.mesh.material
    bake.room.push({ mesh: t.mesh, geometry: src, material: mat })
    t.mesh.geometry = g
    t.mesh.material = Array.isArray(mat) ? mat.map((m) => patched(bake, m)) : patched(bake, mat)
  }
  applyFurniture(bake, planner)
  return bake.room.length
}

// furniture only (cheap: material swaps): after a piece is moved, added or rebuilt
export function applyFurniture(bake, planner) {
  clearFurniture(bake)
  if (!bake.room.length) return
  for (const it of planner.items) {
    if (!it.obj) continue
    const ri = roomOf(bake, it.x, it.z)
    if (ri < 0) continue
    it.obj.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || (o.geometry && o.geometry.morphAttributes.position)) return
      const mat = o.material
      if (!mats(o).every(probeable)) return
      bake.furn.push({ mesh: o, material: mat })
      o.material = Array.isArray(mat) ? mat.map((m) => probeMat(bake, m, ri)) : probeMat(bake, mat, ri)
    })
  }
}

function clearFurniture(bake) {
  for (const a of bake.furn) a.mesh.material = a.material
  bake.furn = []
}

export function clearBake(bake) {
  if (!bake) return
  clearFurniture(bake)
  for (const a of bake.room) {
    if (a.mesh.geometry !== a.geometry) a.mesh.geometry.dispose()
    a.mesh.geometry = a.geometry; a.mesh.material = a.material
  }
  bake.room = []
}
