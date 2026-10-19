import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

// A person at your exact height that walks around the apartment. Walk/idle motion comes from the
// Mixamo-rigged Xbot clips and is retargeted onto the chosen character.
// Man / Woman: Microsoft Rocketbox avatars (MIT licence), everyday clothes, 3ds Max biped rig.
export const CHARACTERS = {
  man: { label: 'Man', fbx: 'Male_Adult_10', style: (o) => reshape(o, baggyJeans(0.32)) },
  woman: { label: 'Woman', fbx: 'Female_Adult_17', style: (o) => reshape(o, baggyJeans(0.45)) },
  mannequin: { label: 'Mannequin', file: 'Xbot.glb', mannequin: true },
}
// natural speed of the walk clip: the stance foot moves back at ~1.22 m/s for the 1.8 m source rig.
// Moving at exactly this (scaled by height) keeps the feet planted instead of sliding.
const CLIP_SPEED = 1.22
const smoothstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x) }

const gltf = new GLTFLoader(), fbx = new FBXLoader(), texLoader = new THREE.TextureLoader()
const loadGLB = (f) => new Promise((res, rej) => gltf.load(`/models/avatar/${f}`, res, undefined, rej))
const loadFBX = (n) => new Promise((res, rej) => fbx.load(`/models/avatar/${n}/${n}.fbx`, res, undefined, rej))
let clipsP = null
function baseClips() {
  if (!clipsP) clipsP = loadGLB('Xbot.glb').then((g) => {
    const get = (n) => g.animations.find((a) => a.name === n)
    g.scene.updateMatrixWorld(true)
    return { idle: get('idle'), walk: get('walk'), scene: g.scene }
  })
  return clipsP
}

// ------------------------------------------------------------------ bone naming
// canonical names = Mixamo's; 3ds Max biped bones are mapped onto them
const BIPED = {
  Pelvis: 'Hips', Spine: 'Spine', Spine1: 'Spine1', Spine2: 'Spine2', Neck: 'Neck', Head: 'Head',
  L_Clavicle: 'LeftShoulder', L_UpperArm: 'LeftArm', L_Forearm: 'LeftForeArm', L_Hand: 'LeftHand',
  R_Clavicle: 'RightShoulder', R_UpperArm: 'RightArm', R_Forearm: 'RightForeArm', R_Hand: 'RightHand',
  L_Thigh: 'LeftUpLeg', L_Calf: 'LeftLeg', L_Foot: 'LeftFoot', L_Toe0: 'LeftToeBase',
  R_Thigh: 'RightUpLeg', R_Calf: 'RightLeg', R_Foot: 'RightFoot', R_Toe0: 'RightToeBase',
}
function canon(n) {
  const m = n.replace(/^mixamorig:?/, '')
  if (/^Bip01[_ ]/.test(n)) return BIPED[n.replace(/^Bip01[_ ]/, '').replace(/ /g, '_')] || null
  return m
}
// limb segments used to match the target's rest pose to the source T-pose (bone -> child)
const CHAINS = [
  ['LeftShoulder', 'LeftArm'], ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'],
  ['RightShoulder', 'RightArm'], ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand'],
  ['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'], ['LeftFoot', 'LeftToeBase'],
  ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'], ['RightFoot', 'RightToeBase'],
]
// how much of the source rotation each bone takes (1 = full). The robot's head and wrist motions don't
// suit a human rig: the head bobbed up and the wrists twisted. Damped so they follow the body naturally.
const INFLUENCE = { Head: 0.25, Neck: 0.45, LeftHand: 0.35, RightHand: 0.35 }
const FINGER = /Thumb|Index|Middle|Ring|Pinky|Finger/
const wpos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld)
const wquat = (o) => o.getWorldQuaternion(new THREE.Quaternion())
function boneMap(root) {
  const m = new Map()
  root.traverse((o) => { if (o.isBone) { const c = canon(o.name); if (c && !m.has(c)) m.set(c, o) } })
  return m
}

// Put the target in the same T-pose as the source (fixes A-pose / bent-arm rigs) and face the same way.
function matchRestPose(targetRoot, src, tgt) {
  const facing = (bm) => { const f = wpos(bm.get('LeftToeBase')).sub(wpos(bm.get('LeftFoot'))); return Math.atan2(f.x, f.z) }
  targetRoot.updateMatrixWorld(true)
  if (tgt.get('LeftToeBase') && src.get('LeftToeBase')) {
    targetRoot.rotation.y += facing(src) - facing(tgt)
    targetRoot.updateMatrixWorld(true)
  }
  for (const [a, b] of CHAINS) {
    const ta = tgt.get(a), tb = tgt.get(b), sa = src.get(a), sb = src.get(b)
    if (!ta || !tb || !sa || !sb) continue
    const dt = wpos(tb).sub(wpos(ta)).normalize(), ds = wpos(sb).sub(wpos(sa)).normalize()
    if (dt.lengthSq() < 0.5 || ds.lengthSq() < 0.5) continue
    const q = new THREE.Quaternion().setFromUnitVectors(dt, ds)
    const nw = q.multiply(wquat(ta))
    ta.quaternion.copy(wquat(ta.parent).invert().multiply(nw))
    targetRoot.updateMatrixWorld(true)
  }
}

// World-space delta retargeting: each target bone gets the same world rotation away from the shared
// T-pose as the source bone. Works across rigs with different bone axes, units and up-axes.
function retarget(clip, targetRoot, base, src, tgt) {
  const srcScene = base.scene
  const tBones = []
  targetRoot.traverse((o) => { if (o.isBone) tBones.push(o) }) // parents first
  srcScene.updateMatrixWorld(true); targetRoot.updateMatrixWorld(true)
  const srcBind = new Map(), tBind = new Map()
  for (const [k, b] of src) srcBind.set(k, wquat(b))
  for (const b of tBones) tBind.set(b, wquat(b))
  const parentWorld0 = new Map(tBones.map((b) => [b, wquat(b.parent)]))
  const restLocal = new Map(tBones.map((b) => [b, b.quaternion.clone()]))
  const mixer = new THREE.AnimationMixer(srcScene)
  const action = mixer.clipAction(clip); action.play()
  const fps = 30, n = Math.max(2, Math.round(clip.duration * fps) + 1)
  const times = new Float32Array(n)
  const values = new Map(tBones.map((b) => [b, new Float32Array(n * 4)]))
  const W = new Map(), loc = new THREE.Quaternion()
  const tName = new Map(tBones.map((b) => [b, canon(b.name)]))
  // hips translation (the up-down bob and side sway of a real walk), scaled to the target's leg length
  const sH = src.get('Hips'), tH = tgt.get('Hips')
  const sH0 = sH && wpos(sH), tH0 = tH && wpos(tH)
  const ratio = sH && tH ? tH0.y / sH0.y : 1
  const hipD = []
  for (let f = 0; f < n; f++) {
    const t = Math.min(clip.duration, (f / (n - 1)) * clip.duration)
    times[f] = t
    mixer.setTime(t)
    srcScene.updateMatrixWorld(true)
    W.clear()
    for (const b of tBones) {
      const pw = W.get(b.parent) || parentWorld0.get(b)
      const k = tName.get(b), s = k && src.get(k)
      let wq
      if (s && !FINGER.test(k)) {
        const d = wquat(s).multiply(srcBind.get(k).clone().invert())
        const w = INFLUENCE[k]
        if (w !== undefined) {
          // damped: blend between "keep rest pose relative to parent" and full source motion
          const rest = pw.clone().multiply(restLocal.get(b))
          const full = d.multiply(tBind.get(b))
          wq = rest.slerp(full, w)
        } else wq = d.multiply(tBind.get(b))
      }
      else wq = pw.clone().multiply(restLocal.get(b))
      W.set(b, wq)
      loc.copy(pw).invert().multiply(wq)
      loc.toArray(values.get(b), f * 4)
    }
    if (sH) hipD.push(wpos(sH).sub(sH0))
  }
  let hipTrack = null
  if (sH && tH) {
    const mx = hipD.reduce((a, d) => a + d.x, 0) / hipD.length, mz = hipD.reduce((a, d) => a + d.z, 0) / hipD.length
    const inv = tH.parent.matrixWorld.clone().invert(), pv = new Float32Array(n * 3)
    hipD.forEach((d, f) => {
      const w = new THREE.Vector3(tH0.x + (d.x - mx) * ratio, tH0.y + d.y * ratio, tH0.z + (d.z - mz) * ratio)
      w.applyMatrix4(inv).toArray(pv, f * 3)
    })
    hipTrack = new THREE.VectorKeyframeTrack(`${tH.name}.position`, times, pv)
  }
  action.stop(); mixer.uncacheRoot(srcScene)
  mixer.setTime(0)
  const tracks = tBones.filter((b) => tName.get(b) && src.has(tName.get(b))).map((b) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values.get(b)))
  if (hipTrack) tracks.push(hipTrack)
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

// Slim a skinned mesh: pull each vertex toward its main bone's segment (keeps limb lengths).
// Reshape clothing in the bind pose: scale vertices radially away from/toward their bone segment.
// factorFor(boneName, h, vertexIndex) -> factor (1 = unchanged); h = 0 at feet, 1 at hips
function reshape(mesh, factorFor) {
  const g = mesh.geometry, sk = mesh.skeleton
  const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight
  const bindPos = sk.bones.map((_, i) => new THREE.Vector3().setFromMatrixPosition(sk.boneInverses[i].clone().invert()))
  const childOf = sk.bones.map((b) => { const c = b.children.find((x) => x.isBone && canon(x.name)); return c ? sk.bones.indexOf(c) : -1 })
  const bm = mesh.bindMatrix, bmi = mesh.bindMatrix.clone().invert()
  const hips = sk.bones.findIndex((b) => canon(b.name) === 'Hips'), feet = sk.bones.findIndex((b) => canon(b.name) === 'LeftFoot')
  const hy = bindPos[hips].y, fy = bindPos[feet].y
  const v = new THREE.Vector3(), seg = new THREE.Vector3(), pr = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    let best = 0, bw = -1
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k) } }
    v.fromBufferAttribute(pos, i).applyMatrix4(bm)
    const f = factorFor(canon(sk.bones[best].name) || '', (v.y - fy) / (hy - fy), i)
    if (f === 1) continue
    const a = bindPos[best], ci = childOf[best]
    if (ci >= 0) { seg.copy(bindPos[ci]).sub(a); const t = Math.max(0, Math.min(1, v.clone().sub(a).dot(seg) / seg.lengthSq())); pr.copy(a).addScaledVector(seg, t) } else pr.copy(a)
    pr.y = v.y
    v.sub(pr).multiplyScalar(f).add(pr).applyMatrix4(bmi)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  pos.needsUpdate = true
  g.computeVertexNormals()
}
// wide-leg / baggy jeans: legs flare out toward the hem
const baggyJeans = (amt) => (bone, h) => {
  if (!/UpLeg$|Leg$/.test(bone)) return 1
  const k = 1 - Math.min(1, Math.max(0, (h - 0.6) / 0.25)) // full flare below the knee-ish, none at the hips
  return 1 + amt * k * (0.45 + 0.55 * (1 - Math.min(1, Math.max(0, h))))
}
// tunic → fitted top: hug the waist & hips so the crop line (painted) sits on the body
// Natural chest reduction: ease the front of the chest back toward the sternum profile with smooth
// falloffs, then relax the surface so there are no ridges.
function reduceChest(mesh, amt = 0.5) {
  const g = mesh.geometry, sk = mesh.skeleton, pos = g.attributes.position
  const bm = mesh.bindMatrix, bmi = mesh.bindMatrix.clone().invert()
  const bp = (n) => { const i = sk.bones.findIndex((b) => canon(b.name) === n); return new THREE.Vector3().setFromMatrixPosition(sk.boneInverses[i].clone().invert()) }
  const s1 = bp('Spine1'), s2 = bp('Spine2'), neck = bp('Neck'), la = bp('LeftArm'), ra = bp('RightArm')
  const cx = (la.x + ra.x) / 2, halfW = Math.abs(la.x - ra.x) / 2
  const N = pos.count, P = new Float32Array(N * 3), v = new THREE.Vector3()
  for (let i = 0; i < N; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(bm); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z }
  // which way is "front": compare the mean depth of chest-height vertices
  const torsoH = neck.y - s1.y
  const yTop = neck.y - torsoH * 0.2, yBot = s1.y - torsoH * 0.6
  const dir = Math.sign(bp('LeftToeBase').z - bp('LeftFoot').z) || 1 // toes point forward
  // sternum (centre-line) front profile per height bin = the "flat chest" baseline
  const BINS = 40, base = new Float32Array(BINS).fill(-1e9)
  const bin = (y) => Math.max(0, Math.min(BINS - 1, Math.floor(((y - yBot) / (yTop - yBot)) * BINS)))
  for (let i = 0; i < N; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], d = (P[i * 3 + 2] - s2.z) * dir
    if (y < yBot || y > yTop || Math.abs(x - cx) > halfW * 0.07) continue
    const b = bin(y); base[b] = Math.max(base[b], d)
  }
  // fill gaps & smooth the baseline
  for (let k = 0; k < BINS; k++) if (base[k] < -1e8) base[k] = k ? base[k - 1] : 0
  const sm = base.map((_, k) => { let a = 0, n = 0; for (let t = -3; t <= 3; t++) { const q = k + t; if (q >= 0 && q < BINS) { a += base[q]; n++ } } return a / n })
  // clothing bridges the cleavage, so use a straight line from upper chest to the waist as the flat front
  const topD = sm[BINS - 2], botD = sm[1]
  const baseAt = (y) => botD + (topD - botD) * Math.max(0, Math.min(1, (y - yBot) / (yTop - yBot)))
  const _unused = (y) => { const f = ((y - yBot) / (yTop - yBot)) * BINS - 0.5, k = Math.max(0, Math.min(BINS - 2, Math.floor(f))), t = Math.max(0, Math.min(1, f - k)); return sm[k] * (1 - t) + sm[k + 1] * t }
  const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }
  const region = new Uint8Array(N), W = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const x = P[i * 3], y = P[i * 3 + 1]
    let d = (P[i * 3 + 2] - s2.z) * dir
    if (y < yBot || y > yTop) continue
    const ty = (y - yBot) / (yTop - yBot) // 0 bottom .. 1 top
    const wy = smooth(ty / 0.18) * smooth((1 - ty) / 0.3)
    const wx = smooth((1 - Math.abs(x - cx) / (halfW * 0.85)) / 0.5)
    const w = wy * wx
    if (w <= 0) continue
    const b = baseAt(y)
    if (d <= b) continue
    region[i] = 1; W[i] = w
    d = b + (d - b) * (1 - amt * w)
    P[i * 3 + 2] = s2.z + d * dir
  }
  for (let i = 0; i < N; i++) if (region[i]) { v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(bmi); pos.setXYZ(i, v.x, v.y, v.z) }
  pos.needsUpdate = true; g.computeVertexNormals()
}
// Rebuild the bare midriff as a smooth rounded torso: per height slice, take the radius around the spine
// at each angle, fill in creases (the old tunic folds) and smooth it, then tuck it in slightly.
function smoothMidriff(mesh, h0, h1, tuck = 0.93) {
  const g = mesh.geometry, sk = mesh.skeleton, pos = g.attributes.position, N = pos.count
  const bm = mesh.bindMatrix, bmi = mesh.bindMatrix.clone().invert()
  const bp = (n) => { const i = sk.bones.findIndex((b) => canon(b.name) === n); return new THREE.Vector3().setFromMatrixPosition(sk.boneInverses[i].clone().invert()) }
  const hips = bp('Hips'), sp = bp('Spine'), feet = bp('LeftFoot')
  const H = (y) => (y - feet.y) / (hips.y - feet.y)
  const P = [], v = new THREE.Vector3()
  for (let i = 0; i < N; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(bm); P.push(v.clone()) }
  const cx = sp.x, cz = sp.z
  const AB = 36, HB = 14
  const rmax = Array.from({ length: HB }, () => new Float32Array(AB))
  const sel = []
  for (let i = 0; i < N; i++) {
    const h = H(P[i].y); if (h < h0 || h > h1) continue
    const dx = P[i].x - cx, dz = P[i].z - cz, r = Math.hypot(dx, dz)
    if (r > Math.abs(bp('LeftArm').x - bp('RightArm').x) * 0.6) continue // not the hands/arms
    const a = Math.atan2(dz, dx), ab = Math.floor(((a + Math.PI) / (2 * Math.PI)) * AB) % AB, hb = Math.min(HB - 1, Math.floor(((h - h0) / (h1 - h0)) * HB))
    rmax[hb][ab] = Math.max(rmax[hb][ab], r); sel.push([i, a, h, r])
  }
  // fill empty bins, close creases (circular max over ±2 bins), smooth around and between slices
  const prof = rmax.map((row) => {
    for (let k = 0; k < AB; k++) if (!row[k]) { let l = k, r = k; while (!row[(l + AB) % AB] && l > k - AB) l--; while (!row[r % AB] && r < k + AB) r++; row[k] = (row[(l + AB) % AB] + row[r % AB]) / 2 }
    const mx = row.map((_, k) => Math.max(row[(k - 1 + AB) % AB], row[k], row[(k + 1) % AB]))
    return mx.map((_, k) => { let s = 0; for (let t = -3; t <= 3; t++) s += mx[(k + t + AB) % AB]; return s / 7 })
  })
  // natural waist shaped from the ribcage ring just under the top: taper in at the waist, out a little
  // at the hips (more at the sides than front/back), so the old tunic flare never shows
  const rTop = prof[HB - 1]
  const sm = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x) }
  const prof2 = prof.map((row, hb) => row.map((_, k) => {
    const h = h0 + ((hb + 0.5) / HB) * (h1 - h0)
    const a = (k + 0.5) / AB * 2 * Math.PI - Math.PI
    const side = Math.abs(Math.cos(a)) // 1 at the sides, 0 front/back
    const hip = 1 + 0.07 * side - 0.02 * (1 - side) // hips: a bit wider at the sides, flat front
    const waist = 0.95
    // ribs (h1) → waist (~1.14) → hips (~0.98) → straight down to mid-thigh (wide jeans)
    let f
    if (h >= 1.14) f = waist + (1 - waist) * sm((h - 1.14) / (h1 - 1.14))
    else if (h >= 0.98) f = hip + (waist - hip) * sm((h - 0.98) / 0.16)
    else f = hip
    return rTop[k] * f
  }))
  const sample = (a, h) => {
    const fa = ((a + Math.PI) / (2 * Math.PI)) * AB - 0.5, a0 = Math.floor(fa), ta = fa - a0
    const fh = Math.max(0, Math.min(HB - 1.001, ((h - h0) / (h1 - h0)) * HB - 0.5)), h0i = Math.floor(fh), th = fh - h0i
    const at = (hb, ab) => prof2[Math.min(HB - 1, hb)][(ab + AB) % AB]
    const r0 = at(h0i, a0) * (1 - ta) + at(h0i, a0 + 1) * ta, r1 = at(h0i + 1, a0) * (1 - ta) + at(h0i + 1, a0 + 1) * ta
    return r0 * (1 - th) + r1 * th
  }
  for (const [i, a, h, r] of sel) {
    const e = Math.min(1, (h - h0) / ((h1 - h0) * 0.2), (h1 - h) / ((h1 - h0) * 0.2)) // blend at the band edges
    const target = sample(a, h) * (1 - (1 - tuck) * e)
    const nr = r + (target - r) * e
    v.set(cx + Math.cos(a) * nr, P[i].y, cz + Math.sin(a) * nr).applyMatrix4(bmi)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  pos.needsUpdate = true; g.computeVertexNormals()
}
function cropTop(mesh) {
  // the old tunic skirt hangs between the thighs: pull it in to the legs/pelvis so the jeans read as jeans
  reshape(mesh, (bone, h) => {
    if (h < 0.55 || h > 0.95) return 1
    const t = Math.min(1, (h - 0.55) / 0.08) * Math.min(1, (0.95 - h) / 0.06)
    if (/^Hips$/.test(bone)) return 1 - 0.45 * t
    if (/UpLeg$/.test(bone)) return 1 - 0.22 * t
    return 1
  })
}

function slim(mesh, factorFor) {
  const g = mesh.geometry, sk = mesh.skeleton
  const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight
  const bindPos = sk.bones.map((_, i) => new THREE.Vector3().setFromMatrixPosition(sk.boneInverses[i].clone().invert()))
  const childOf = sk.bones.map((b) => { const c = b.children.find((x) => x.isBone); return c ? sk.bones.indexOf(c) : -1 })
  const v = new THREE.Vector3(), seg = new THREE.Vector3(), pr = new THREE.Vector3()
  const bm = mesh.bindMatrix, bmi = mesh.bindMatrix.clone().invert() // (bindMatrixInverse can be stale)
  for (let i = 0; i < pos.count; i++) {
    let best = 0, bw = -1
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k) } }
    const f = factorFor(sk.bones[best].name)
    if (f === 1) continue
    v.fromBufferAttribute(pos, i).applyMatrix4(bm)
    const a = bindPos[best], ci = childOf[best]
    if (ci >= 0) {
      seg.copy(bindPos[ci]).sub(a)
      const t = Math.max(0, Math.min(1, v.clone().sub(a).dot(seg) / seg.lengthSq()))
      pr.copy(a).addScaledVector(seg, t)
    } else pr.copy(a)
    v.sub(pr).multiplyScalar(f).add(pr).applyMatrix4(bmi)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  pos.needsUpdate = true
  g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere()
}
const robotSlim = (n) => /Head|Neck/.test(n) ? 1 : /Hand|Finger|Thumb|Index|Middle|Ring|Pinky/.test(n) ? 0.92 : /Foot|Toe/.test(n) ? 0.9
  : /Arm|Shoulder/.test(n) ? 0.74 : /Leg/.test(n) ? 0.76 : /Spine|Hips/.test(n) ? 0.8 : 0.85

// Hair cards: point normals outward from the head so the strands shade as one smooth volume
// (per-card normals catch the window light at their edges and glitter).
function smoothHairNormals(mesh, hairMatIndex) {
  const g = mesh.geometry, sk = mesh.skeleton
  const head = sk.bones.find((b) => /Head$/.test(b.name)) || sk.bones.find((b) => /Head/.test(b.name))
  if (!head) return
  const hi = sk.bones.indexOf(head)
  const inv = mesh.bindMatrix.clone().invert()
  const c = new THREE.Vector3().setFromMatrixPosition(sk.boneInverses[hi].clone().invert()).applyMatrix4(inv)
  const pos = g.attributes.position, nor = g.attributes.normal, idx = g.index
  const v = new THREE.Vector3()
  for (const gr of g.groups) {
    if (gr.materialIndex !== hairMatIndex) continue
    for (let k = gr.start; k < gr.start + gr.count; k++) {
      const i = idx ? idx.getX(k) : k
      v.fromBufferAttribute(pos, i).sub(c)
      v.y *= 0.6 // ponytail hangs down: favour sideways/back normals
      v.normalize()
      nor.setXYZ(i, v.x, v.y, v.z)
    }
  }
  nor.needsUpdate = true
}

function rocketboxMaterials(model, name) {
  const t = (f, srgb) => { const x = texLoader.load(`/models/avatar/${name}/${f}`); if (srgb) x.colorSpace = THREE.SRGBColorSpace; x.anisotropy = 4; return x }
  const mats = {
    // matte (no grazing-angle reflections: the bright windows behind made silhouettes glitter)
    body: new THREE.MeshLambertMaterial({ map: t('body_color.jpg', true), normalMap: t('body_normal.jpg'), normalScale: new THREE.Vector2(0.7, 0.7) }),
    head: new THREE.MeshLambertMaterial({ map: t('head_color.jpg', true), normalMap: t('head_normal.jpg'), normalScale: new THREE.Vector2(0.6, 0.6) }),
    // hair cards: matte (no specular/fresnel, which made the strand edges glint white)
    opacity: new THREE.MeshLambertMaterial({ map: t('opacity_color.jpg', true), alphaMap: t('opacity_alpha.jpg'), alphaTest: 0.35, side: THREE.DoubleSide }),
  }
  mats.opacity.userData.hair = true
  model.traverse((o) => {
    if (!o.isMesh) return
    const list = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => /opacity/i.test(m.name) ? mats.opacity : /head/i.test(m.name) ? mats.head : mats.body)
    o.material = Array.isArray(o.material) ? list : list[0]
    if (o.isSkinnedMesh && Array.isArray(o.material)) { const hi = o.material.indexOf(mats.opacity); if (hi >= 0) smoothHairNormals(o, hi) }
  })
}

// Transplant a hairstyle from another Rocketbox avatar: take its hair-card triangles, express them in its
// head-bone space, and parent them rigidly to our head bone (same biped rig conventions & units).
async function transplantHair(targetRoot, donorName) {
  if (!donorName) { removeBun(targetRoot); return }
  const donor = await loadFBX(donorName)
  let dm; donor.traverse((o) => { if (o.isSkinnedMesh) dm = o })
  donor.updateMatrixWorld(true)
  const mats = Array.isArray(dm.material) ? dm.material : [dm.material]
  const hairIdx = mats.findIndex((m) => /opacity/i.test(m.name))
  if (hairIdx < 0) return
  const sk = dm.skeleton, hb = sk.bones.findIndex((b) => canon(b.name) === 'Head')
  const toHead = sk.boneInverses[hb].clone().multiply(dm.bindMatrix)
  const g = dm.geometry, idx = g.index, pos = g.attributes.position, uv = g.attributes.uv
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight
  const headish = (i) => { let b = 0, w = -1; for (let k = 0; k < 4; k++) { const x = sw.getComponent(i, k); if (x > w) { w = x; b = si.getComponent(i, k) } } return /Head|Neck/.test(canon(sk.bones[b].name) || sk.bones[b].name) }
  const P = [], U = [], v = new THREE.Vector3()
  for (const gr of g.groups) {
    if (gr.materialIndex !== hairIdx) continue
    for (let k = gr.start; k < gr.start + gr.count; k += 3) {
      const ii = [0, 1, 2].map((t) => (idx ? idx.getX(k + t) : k + t))
      if (!ii.some(headish)) continue
      for (const i of ii) { v.fromBufferAttribute(pos, i).applyMatrix4(toHead); P.push(v.x, v.y, v.z); U.push(uv.getX(i), uv.getY(i)) }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2))
  geo.computeVertexNormals()
  const t = (f, srgb) => { const x = texLoader.load(`/models/avatar/${donorName}/${f}`); if (srgb) x.colorSpace = THREE.SRGBColorSpace; x.anisotropy = 4; return x }
  const mat = new THREE.MeshLambertMaterial({ map: t('opacity_color.jpg', true), alphaMap: t('opacity_alpha.jpg'), alphaTest: 0.35, side: THREE.DoubleSide })
  const hair = new THREE.Mesh(geo, mat)
  hair.castShadow = true; hair.frustumCulled = false; hair.userData.noPick = true; hair.name = 'transplantedHair'
  let head; targetRoot.traverse((o) => { if (o.isBone && canon(o.name) === 'Head') head = o })
  head.add(hair)

}

function removeBun(targetRoot) {
  // remove the bun: head-mesh triangles that stick out behind/above the skull (head-bone space:
  // x = up along the head, y = front(+)/back(-), units cm)
  targetRoot.traverse((o) => {
    if (!o.isSkinnedMesh) return
    const gg = o.geometry, pa = gg.attributes.position, ix = gg.index, sk2 = o.skeleton
    const hb2 = sk2.bones.findIndex((b) => canon(b.name) === 'Head'); if (hb2 < 0) return
    const toH = sk2.boneInverses[hb2].clone().multiply(o.bindMatrix), v = new THREE.Vector3()
    // pull everything outside the skull's radius (the bun) back onto the skull surface
    const inv = toH.clone().invert(), c = new THREE.Vector3(6, -0.5, 0), R = 10.6
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i).applyMatrix4(toH)
      const d = v.clone().sub(c)
      if (v.y < -2 && v.x > 2 && d.length() > R) { v.copy(c).addScaledVector(d.normalize(), R); v.applyMatrix4(inv); pa.setXYZ(i, v.x, v.y, v.z) }
    }
    if (ix) ix.needsUpdate = true; pa.needsUpdate = true
  })
  // hide our own hair cards (the bun)
  targetRoot.traverse((o) => {
    if (!o.isSkinnedMesh || !Array.isArray(o.material)) return
    o.material = o.material.map((m) => (m.userData.hair ? new THREE.MeshBasicMaterial({ visible: false }) : m))
  })
}

// Long straight hair fitted to the head: a cap shaped from the actual skull, falling to the shoulders.
// Built in head-bone space (x = up the head, y = front, z = side; cm) and parented to the head bone.
function buildLongHair(root) {
  let mesh, head
  root.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; if (o.isBone && canon(o.name) === 'Head') head = o })
  const sk = mesh.skeleton, hb = sk.bones.indexOf(head)
  const toH = sk.boneInverses[hb].clone().multiply(mesh.bindMatrix)
  const g = mesh.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight
  const c = new THREE.Vector3(7, -0.5, 0)
  const NT = 72, NP = 24, rmax = new Float32Array(NT * NP), v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    let b = 0, w = -1; for (let k = 0; k < 4; k++) { const x = sw.getComponent(i, k); if (x > w) { w = x; b = si.getComponent(i, k) } }
    if (b !== hb) continue
    v.fromBufferAttribute(pos, i).applyMatrix4(toH).sub(c)
    const r = v.length(); if (r < 1) continue
    const phi = Math.acos(Math.max(-1, Math.min(1, v.x / r))), th = Math.atan2(v.z, v.y)
    if (phi > Math.PI / 2 + 0.25) continue
    const pi = Math.min(NP - 1, Math.floor((phi / (Math.PI / 2 + 0.25)) * NP)), ti = Math.floor(((th + Math.PI) / (2 * Math.PI)) * NT) % NT
    rmax[pi * NT + ti] = Math.max(rmax[pi * NT + ti], r)
  }
  // fill & smooth the skull radius map
  const get = (p, t) => rmax[Math.max(0, Math.min(NP - 1, p)) * NT + ((t % NT) + NT) % NT]
  for (let it = 0; it < 30; it++) for (let p = 0; p < NP; p++) for (let t = 0; t < NT; t++) if (!get(p, t)) {
    const n = [get(p - 1, t), get(p + 1, t), get(p, t - 1), get(p, t + 1)].filter((x) => x)
    if (n.length) rmax[p * NT + t] = n.reduce((a, b) => a + b) / n.length
  }
  const sm = rmax.map((_, k) => { const p = Math.floor(k / NT), t = k % NT; let a = 0, n = 0; for (let dp = -1; dp <= 1; dp++) for (let dt = -2; dt <= 2; dt++) { const x = get(p + dp, t + dt); if (x) { a += x; n++ } } return n ? a / n : 10 })
  const radius = (phi, th) => { const p = Math.min(NP - 1, Math.floor((phi / (Math.PI / 2 + 0.25)) * NP)), t = Math.floor(((th + Math.PI) / (2 * Math.PI)) * NT) % NT; return sm[p * NT + t] }
  const LEN = 27, GAP = 0.9 // hair length below the head's equator (cm), offset above the scalp
  const NU = 96, NV = 44, P = [], U = [], I = []
  const deg = Math.PI / 180
  for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
    const th = -Math.PI + (i / NU) * 2 * Math.PI, vv = j / NV
    let x, y, z
    if (vv <= 0.45) {
      const phi = (vv / 0.45) * (Math.PI / 2)
      const r = radius(phi, th) + GAP + 1.2 * Math.cos(phi) ** 4 // a little extra volume on top (covers the crown)
      x = c.x + r * Math.cos(phi); y = c.y + r * Math.sin(phi) * Math.cos(th); z = c.z + r * Math.sin(phi) * Math.sin(th)
    } else {
      const d = ((vv - 0.45) / 0.55) * LEN
      const r = radius(Math.PI / 2, th) + GAP + d * 0.13 + Math.sin(th * 9) * 0.15
      x = c.x - d; y = c.y + r * Math.cos(th); z = c.z + r * Math.sin(th)
    }
    P.push(x, y, z); U.push((i / NU) * 6, 1 - vv)
  }
  // hairline: leave the face open (front = +y, th = 0)
  const keep = (th, vv) => {
    const a = Math.abs(th) / deg
    if (a > 100) return true
    // swept back off the face: hairline at ~40° in front, framing the face at the sides
    const phiMax = a < 52 ? 40 + a * 0.12 : 46 + ((a - 52) / 18) * 200
    return (vv / 0.45) * 90 <= phiMax
  }
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const th = -Math.PI + ((i + 0.5) / NU) * 2 * Math.PI, vv = (j + 0.5) / NV
    if (!keep(th, vv)) continue
    const a = j * (NU + 1) + i, b = a + 1, cc = a + NU + 1, d = cc + 1
    I.push(a, cc, b, b, cc, d)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2))
  geo.setIndex(I); geo.computeVertexNormals()
  // strand texture (dark brown, fine vertical strands, ragged tips)
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512
  const x2 = cv.getContext('2d')
  x2.fillStyle = '#0f0a08'; x2.fillRect(0, 0, 512, 512)
  for (let k = 0; k < 2600; k++) {
    const px = Math.random() * 512, l = 0.3 + Math.random() * 0.7
    const t = Math.random(); x2.strokeStyle = `rgba(${34 + t * 34},${24 + t * 22},${19 + t * 16},${0.3 + Math.random() * 0.35})`
    x2.lineWidth = 0.6 + Math.random() * 1.2
    x2.beginPath(); x2.moveTo(px, 512 * (1 - l)); x2.bezierCurveTo(px + 2, 340, px - 2, 170, px + (Math.random() - 0.5) * 4, 0); x2.stroke()
  }
  const map = new THREE.CanvasTexture(cv); map.colorSpace = THREE.SRGBColorSpace; map.wrapS = THREE.RepeatWrapping; map.anisotropy = 4
  const ac = document.createElement('canvas'); ac.width = 256; ac.height = 256
  const a2 = ac.getContext('2d'); a2.fillStyle = '#fff'; a2.fillRect(0, 0, 256, 256)
  a2.fillStyle = '#000'
  for (let px = 0; px < 256; px += 2) { const tip = 6 + Math.random() * 22; a2.fillRect(px, 256 - tip, 2, tip) } // ragged ends at the bottom (v = 0)
  const alpha = new THREE.CanvasTexture(ac); alpha.wrapS = THREE.RepeatWrapping
  alpha.repeat.set(1, 1)
  const mat = new THREE.MeshLambertMaterial({ map, alphaMap: alpha, alphaTest: 0.5, side: THREE.DoubleSide })
  const hair = new THREE.Mesh(geo, mat)
  hair.castShadow = true; hair.frustumCulled = false; hair.userData.noPick = true; hair.name = 'longHair'
  head.add(hair)
}

export class Avatar {
  constructor(scene, overlay, onChange) {
    this.group = new THREE.Group(); this.group.name = 'avatar'
    this.group.visible = false
    scene.add(this.group)
    this.onChange = onChange
    this.height = 1.72
    this.path = []
    this.moving = false
    this.speed = 0
    this.heading = 0
    this.targetHeading = 0
    this.ready = false
    this.kind = null

    const el = document.createElement('div'); el.className = 'avatar-label'
    this.labelEl = el
    this.label = new CSS2DObject(el)
    overlay.add(this.label)
  }

  async setCharacter(kind) {
    if (!CHARACTERS[kind]) kind = 'man'
    if (kind === this.kind) return
    this.kind = kind
    const def = CHARACTERS[kind]
    const [loaded, base] = await Promise.all([def.fbx ? loadFBX(def.fbx) : loadGLB(def.file), baseClips()])
    if (this.kind !== kind) return
    const m = def.fbx ? loaded : loaded.scene
    if (def.fbx) rocketboxMaterials(m, def.fbx)
    if (def.style) m.traverse((o) => { if (o.isSkinnedMesh) def.style(o) })
    if (def.longHair) { await transplantHair(m, null); buildLongHair(m) }
    const softHair = []
    m.traverse((o) => {
      if (o.isMesh) {
        if (def.mannequin) {
          o.material = /Joints/.test(o.material.name)
            ? new THREE.MeshStandardMaterial({ color: '#6c6f74', roughness: 0.45, metalness: 0.2 })
            : new THREE.MeshStandardMaterial({ color: '#d9d5cf', roughness: 0.55 })
          if (o.isSkinnedMesh) slim(o, robotSlim)
        }
        o.castShadow = true
        o.receiveShadow = false // self-shadowing striped the hair cards
        o.frustumCulled = false
        o.userData.noPick = true
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        if (o.isSkinnedMesh && mats.some((x) => x.userData.hair)) softHair.push(o)
      }
    })
    if (this.model) { this.group.remove(this.model); this.mixer?.stopAllAction() }
    // wrap so the retarget's facing correction lives inside, and scaling happens outside
    const holder = new THREE.Group(); holder.add(m)
    this.model = holder
    this.group.add(holder)
    m.updateMatrixWorld(true)
    const bind = new THREE.Box3().setFromObject(m, true)
    this.baseHeight = Math.max(0.5, bind.max.y - bind.min.y)
    this.baseMinY = bind.min.y
    let idle = base.idle, walk = base.walk
    this.mixer = new THREE.AnimationMixer(m)
    if (!def.mannequin) {
      const src = boneMap(base.scene)
      const tgt = boneMap(m)
      const parent = this.group.parent; this.group.removeFromParent()
      const keep = [this.group.position.clone(), this.group.rotation.y]
      this.group.position.set(0, 0, 0); this.group.rotation.y = 0; holder.scale.setScalar(1); holder.position.set(0, 0, 0)
      this.group.updateMatrixWorld(true)
      // source & target must be compared at the same scale: normalise the target to the source height
      const sb = new THREE.Box3().setFromObject(base.scene, true)
      holder.scale.setScalar((sb.max.y - sb.min.y) / this.baseHeight); this.group.updateMatrixWorld(true)
      matchRestPose(m, src, tgt)
      idle = retarget(base.idle, m, base, src, tgt); walk = retarget(base.walk, m, base, src, tgt)
      holder.scale.setScalar(1)
      this.group.position.copy(keep[0]); this.group.rotation.y = keep[1]
      if (parent) parent.add(this.group)
    }
    this.idleA = this.mixer.clipAction(idle)
    this.walkA = this.mixer.clipAction(walk)
    this.idleA.play(); this.walkA.play()
    this.idleA.setEffectiveWeight(1); this.walkA.setEffectiveWeight(0)
    this.mixer.update(0.01)
    this.ready = true
    this.setHeight(this.height)
    this.onChange()
  }

  setHeight(h) {
    this.height = h
    if (this.model) {
      const s = h / this.baseHeight
      this.model.scale.setScalar(s)
      this.model.position.y = -this.baseMinY * s
    }
    this.labelEl.textContent = `You, ${Math.round(h * 100)} cm`
    this.updateLabel()
  }

  get position() { return this.group.position }

  place(x, z, heading = this.heading) {
    this.group.position.set(x, 0, z)
    this.heading = this.targetHeading = heading
    this.group.rotation.y = heading
    this.path = []; this.setSpeed(0)
    this.updateLabel()
  }

  updateLabel() { this.label.position.set(this.group.position.x, this.height + 0.14, this.group.position.z - (this.topView ? 0.42 : 0)) }

  walkTo(target, blockers) {
    const path = findPath(this.group.position, target, blockers, 0.27)
    if (!path) return false
    this.path = path
    return true
  }

  get naturalSpeed() { return CLIP_SPEED * (this.height / 1.8) }

  // externally driven movement (keyboard in third-person walk mode)
  drive(x, z, vx, vz) {
    this.path = []
    this.group.position.x = x; this.group.position.z = z
    const sp = Math.hypot(vx, vz)
    if (sp > 0.05) this.targetHeading = Math.atan2(vx, vz)
    this.setSpeed(sp)
  }

  // blend idle↔walk continuously by speed; play the walk at the speed you actually move
  setSpeed(sp) {
    this.speed = sp
    this.moving = sp > 0.03
    if (!this.walkA) return
    const ns = this.naturalSpeed, w = smoothstep(sp / (ns * 0.55))
    this.walkA.setEffectiveWeight(w)
    this.idleA.setEffectiveWeight(1 - w)
    this.walkA.timeScale = Math.max(0.55, Math.min(1.6, sp / ns))
  }

  // returns true while something is animating (needs re-render)
  update(dt) {
    if (!this.ready) return false
    const p = this.group.position
    if (this.path.length) {
      const ns = this.naturalSpeed
      // distance left on the path → ease out at the end
      let left = 0, q = p
      for (const t of this.path) { left += Math.hypot(t.x - q.x, t.z - q.z); q = t }
      const t0 = this.path[0]
      const want = Math.atan2(t0.x - p.x, t0.z - p.z)
      let turn = Math.abs(Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading)))
      // slow down for sharp turns and near the end; accelerate smoothly from standstill
      const target = ns * Math.min(1, left / 0.45 + 0.15) * (turn > 1.2 ? 0.35 : turn > 0.6 ? 0.7 : 1)
      this.cur = (this.cur || 0) + (target - (this.cur || 0)) * Math.min(1, dt * (target > (this.cur || 0) ? 3.2 : 6))
      let step = this.cur * dt
      while (step > 0 && this.path.length) {
        const t = this.path[0]
        const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz)
        if (d < 1e-3) { this.path.shift(); continue }
        this.targetHeading = Math.atan2(dx, dz)
        const s = Math.min(step, d)
        p.x += (dx / d) * s; p.z += (dz / d) * s
        step -= s
        if (s >= d) this.path.shift()
      }
      if (!this.path.length) this.cur = 0
      this.setSpeed(this.path.length ? this.cur : 0)
    } else if (this.speed && !this.driven) this.setSpeed(Math.max(0, this.speed - dt * 4))
    let dh = this.targetHeading - this.heading
    dh = Math.atan2(Math.sin(dh), Math.cos(dh))
    let anim = this.moving
    if (Math.abs(dh) > 1e-3) { this.heading += dh * Math.min(1, dt * 6.5); anim = true }
    this.group.rotation.y = this.heading
    // idle breathing keeps playing (at 30 Hz to stay light)
    this.idleAcc = (this.idleAcc || 0) + dt
    if (!anim && this.idleAcc < 1 / 30) { this.updateLabel(); return false }
    if (this.group.visible) this.mixer.update(anim ? dt : this.idleAcc)
    this.idleAcc = 0
    this.updateLabel()
    return this.group.visible
  }

  setOpacity(a) {
    if (!this.model || this._opacity === a) return
    this._opacity = a
    this.model.traverse((o) => {
      if (!o.isMesh) return
      const ms = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of ms) {
        if (m.alphaTest > 0) { m.opacity = 1; continue } // hair cards: fading them breaks depth sorting → glowing strand edges
        m.transparent = a < 1; m.opacity = a; m.depthWrite = a >= 1
      }
    })
  }
}

// ------------------------------------------------------------------ pathfinding
const GRID = { x0: -0.1, z0: -1.75, x1: 6.65, z1: 8.0, cell: 0.05 }
export function setWalkArea(b) { Object.assign(GRID, { x0: b.x1 - 2, z0: b.z1 - 2, x1: b.x2 + 2, z1: b.z2 + 2 }) }

export function findPath(from, to, blockers, radius) {
  const { x0, z0, x1, z1, cell } = GRID
  const W = Math.ceil((x1 - x0) / cell), H = Math.ceil((z1 - z0) / cell)
  const blocked = new Uint8Array(W * H)
  for (const b of blockers) {
    const i0 = Math.max(0, Math.floor((b.x1 - radius - x0) / cell)), i1 = Math.min(W - 1, Math.ceil((b.x2 + radius - x0) / cell))
    const j0 = Math.max(0, Math.floor((b.z1 - radius - z0) / cell)), j1 = Math.min(H - 1, Math.ceil((b.z2 + radius - z0) / cell))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = x0 + (i + 0.5) * cell, cz = z0 + (j + 0.5) * cell
      const dx = Math.max(b.x1 - cx, 0, cx - b.x2), dz = Math.max(b.z1 - cz, 0, cz - b.z2)
      if (dx * dx + dz * dz < radius * radius) blocked[j * W + i] = 1
    }
  }
  const toCell = (p) => [Math.min(W - 1, Math.max(0, Math.floor((p.x - x0) / cell))), Math.min(H - 1, Math.max(0, Math.floor((p.z - z0) / cell)))]
  let [si, sj] = toCell(from), [ti, tj] = toCell(to)
  const nearestFree = (i, j) => {
    if (!blocked[j * W + i]) return [i, j]
    for (let r = 1; r < 20; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = i + di, b = j + dj
      if (a >= 0 && b >= 0 && a < W && b < H && !blocked[b * W + a]) return [a, b]
    }
    return null
  }
  const s = nearestFree(si, sj), t = nearestFree(ti, tj)
  if (!s || !t) return null
  ;[si, sj] = s; [ti, tj] = t
  const N = W * H, g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N)
  const heap = []
  const push = (f, i) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p } }
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m } } return top }
  const hfn = (i, j) => Math.hypot(i - ti, j - tj)
  const start = sj * W + si, goal = tj * W + ti
  g[start] = 0; push(hfn(si, sj), start)
  const nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]]
  let found = false
  while (heap.length) {
    const [, cur] = pop()
    if (closed[cur]) continue
    if (cur === goal) { found = true; break }
    closed[cur] = 1
    const ci = cur % W, cj = (cur / W) | 0
    for (const [di, dj, c] of nb) {
      const ni = ci + di, nj = cj + dj
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue
      const n = nj * W + ni
      if (blocked[n] || closed[n]) continue
      if (di && dj && (blocked[cj * W + ni] || blocked[nj * W + ci])) continue
      const ng = g[cur] + c
      if (ng < g[n]) { g[n] = ng; came[n] = cur; push(ng + hfn(ni, nj), n) }
    }
  }
  if (!found) return null
  const cells = []
  for (let c = goal; c !== -1; c = came[c]) cells.push(c)
  cells.reverse()
  const free = (a, b) => {
    const ai = a % W, aj = (a / W) | 0, bi = b % W, bj = (b / W) | 0
    const n = Math.ceil(Math.max(Math.abs(bi - ai), Math.abs(bj - aj)) * 2)
    for (let k = 0; k <= n; k++) {
      const i = Math.round(ai + ((bi - ai) * k) / n), j = Math.round(aj + ((bj - aj) * k) / n)
      if (blocked[j * W + i]) return false
    }
    return true
  }
  const out = []
  let anchor = 0
  for (let k = 2; k < cells.length; k++) if (!free(cells[anchor], cells[k])) { out.push(cells[k - 1]); anchor = k - 1 }
  out.push(goal)
  const pts = out.map((c) => ({ x: x0 + ((c % W) + 0.5) * cell, z: z0 + (((c / W) | 0) + 0.5) * cell }))
  if (t[0] === Math.floor((to.x - x0) / cell) && t[1] === Math.floor((to.z - z0) / cell)) pts[pts.length - 1] = { x: to.x, z: to.z }
  return pts
}
