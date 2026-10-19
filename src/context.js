import * as THREE from 'three'
import * as P from './plan.js'
import { worldUV } from './builder.js'
import { facadeWindows, speckle } from './textures.js'

export const FLOOR_H = 3.4 // floor-to-floor
export const GROUND = -0.45 - (P.SPEC.floor || 0) * FLOOR_H // street level below this apartment

// The rest of the building around the apartment + the paving below. Sides of the apartment that have
// windows / balcony doors get a rendered façade with real holes; other sides are neighbours / stairwell.
export function buildContext(M) {
  const root = new THREE.Group(); root.name = 'context'
  const level = P.SPEC.floor || 0
  const top = FLOOR_H * (7 - level)

  const facadeTex = facadeWindows({ base: '#dbc7b3', bayW: 3.3, floorH: FLOOR_H, bays: 4, floors: 2 })
  const facadeMat = new THREE.MeshStandardMaterial({ map: facadeTex, roughness: 0.95 })
  const renderBoth = M.render.clone(); renderBoth.side = THREE.DoubleSide
  const plainMat = new THREE.MeshStandardMaterial({ color: '#cfc0b0', roughness: 0.95 })

  const block = (x1, z1, x2, z2, y1, y2, mat, shadow = true) => {
    if (x2 - x1 < 1e-3 || z2 - z1 < 1e-3 || y2 - y1 < 1e-3) return null
    const g = new THREE.BoxGeometry(x2 - x1, y2 - y1, z2 - z1)
    g.translate((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2); worldUV(g)
    const m = new THREE.Mesh(g, mat); m.castShadow = shadow; m.receiveShadow = true; root.add(m); return m
  }
  const B = P.INDOOR_BOUNDS
  const ext = P.OPENINGS.filter((o) => o.kind === 'window' || o.kind === 'balconyDoor')
  // which bbox sides are façades (exterior openings facing out of that side)
  const sideOf = (o) => (o.alongX ? (o.out[1] > 0 ? 'S' : 'N') : (o.out[0] > 0 ? 'E' : 'W'))
  const fac = { N: false, S: false, E: false, W: false }
  for (const o of ext) fac[sideOf(o)] = true
  const entSide = P.ENTRANCE ? sideOf(P.ENTRANCE) : null
  const FAR = 30, CORR = 1.8

  // masses: extend the bbox outward on non-façade sides; façade sides stop at the façade line
  const X1 = fac.W ? B.x1 : B.x1 - FAR, X2 = fac.E ? B.x2 : B.x2 + FAR
  const Z1 = fac.N ? B.z1 : B.z1 - FAR, Z2 = fac.S ? B.z2 : B.z2 + FAR
  const side = (s, x1, z1, x2, z2) => {
    const mat = fac.N || fac.S ? (s === 'W' || s === 'E' ? facadeMat : plainMat) : s === 'N' || s === 'S' ? facadeMat : plainMat
    if (s === entSide) {
      // stairwell corridor outside the front door
      const c = {
        N: [x1, z2 - CORR, x2, z2], S: [x1, z1, x2, z1 + CORR],
        W: [x2 - CORR, z1, x2, z2], E: [x1, z1, x1 + CORR, z2],
      }[s]
      const rest = {
        N: [x1, z1, x2, z2 - CORR], S: [x1, z1 + CORR, x2, z2],
        W: [x1, z1, x2 - CORR, z2], E: [x1 + CORR, z1, x2, z2],
      }[s]
      block(...rest.slice(0, 2), ...rest.slice(2), GROUND, top, plainMat, false)
      block(c[0], c[1], c[2], c[3], GROUND, 0, M.hallFloor, false)
      block(c[0], c[1], c[2], c[3], 2.7, top, M.white, false)
      return
    }
    block(x1, z1, x2, z2, GROUND, top, mat)
  }
  // left/right strips span the full depth; top/bottom strips only the bbox width
  if (!fac.W) side('W', X1, Z1, B.x1, Z2)
  if (!fac.E) side('E', B.x2, Z1, X2, Z2)
  if (!fac.N) side('N', B.x1, Z1, B.x2, B.z1)
  if (!fac.S) side('S', B.x1, B.z2, B.x2, Z2)
  // the façade continues as neighbouring flats along each façade side
  if (fac.S || fac.N) {
    const za = fac.N ? B.z1 : Z1, zb = fac.S ? B.z2 : Z2
    if (fac.W === false) { /* west strip already spans */ } else block(B.x1 - FAR, za, B.x1, zb, GROUND, top, facadeMat)
    if (fac.E === false) { /* */ } else block(B.x2, za, B.x2 + FAR, zb, GROUND, top, facadeMat)
  }
  if ((fac.E || fac.W) && !(fac.S || fac.N)) {
    const xa = fac.W ? B.x1 : X1, xb = fac.E ? B.x2 : X2
    block(xa, B.z1 - FAR, xb, B.z1, GROUND, top, facadeMat)
    block(xa, B.z2, xb, B.z2 + FAR, GROUND, top, facadeMat)
  }
  // above and below the flat
  block(B.x1, B.z1, B.x2, B.z2, P.CEILING + 0.02, top, facadeMat)
  block(B.x1, B.z1, B.x2, B.z2, GROUND, -0.25, plainMat, false)

  // façade planes over the flat with real openings + reveals
  for (const s of ['N', 'S', 'E', 'W']) {
    if (!fac[s]) continue
    const along = s === 'N' || s === 'S'
    const a1 = along ? B.x1 : B.z1, a2 = along ? B.x2 : B.z2
    const line = { N: B.z1, S: B.z2, W: B.x1, E: B.x2 }[s]
    const sgn = s === 'S' || s === 'E' ? 1 : -1
    const shape = new THREE.Shape()
    shape.moveTo(a1, GROUND); shape.lineTo(a2, GROUND); shape.lineTo(a2, P.CEILING + 0.02); shape.lineTo(a1, P.CEILING + 0.02); shape.closePath()
    const mine = ext.filter((o) => sideOf(o) === s)
    for (const o of mine) {
      const h1 = along ? o.x1 : o.z1, h2 = along ? o.x2 : o.z2, y1 = o.kind === 'window' ? o.sill : 0
      const h = new THREE.Path(); h.moveTo(h1, y1); h.lineTo(h1, o.head); h.lineTo(h2, o.head); h.lineTo(h2, y1); h.closePath(); shape.holes.push(h)
    }
    const g = new THREE.ShapeGeometry(shape)
    // shape (a, y) → world: along x: (a, y, line); along z: (line, y, a)
    if (along) g.translate(0, 0, line + sgn * 0.002)
    else { g.rotateY(-Math.PI / 2); g.translate(line + sgn * 0.002, 0, 0) }
    g.computeVertexNormals(); worldUV(g)
    const m = new THREE.Mesh(g, renderBoth); m.receiveShadow = true; root.add(m)
    // exterior reveals (the last ~14 cm of the wall around each opening)
    for (const o of mine) {
      const y1 = o.kind === 'window' ? o.sill : 0, d = Math.min(0.14, o.T * 0.38)
      const inner = line - sgn * d, outer = line + sgn * 0.002
      const za = Math.min(inner, outer), zb = Math.max(inner, outer)
      if (along) {
        block(o.x1 - 0.001, za, o.x1 + 0.002, zb, y1, o.head, M.render, false)
        block(o.x2 - 0.002, za, o.x2 + 0.001, zb, y1, o.head, M.render, false)
        block(o.x1, za, o.x2, zb, o.head - 0.002, o.head + 0.001, M.render, false)
      } else {
        block(za, o.z1 - 0.001, zb, o.z1 + 0.002, y1, o.head, M.render, false)
        block(za, o.z2 - 0.002, zb, o.z2 + 0.001, y1, o.head, M.render, false)
        block(za, o.z1, zb, o.z2, o.head - 0.002, o.head + 0.001, M.render, false)
      }
    }
  }

  // stacked balconies (ours, the neighbours' beside it and the ones above/below)
  const bal = P.BALCONY
  if (bal) {
    const f = P.rectFrame(bal.rect, bal.out)
    const along = f.alongX, span = (along ? B.w : B.d) + 3.3
    const [bx1, bz1, bx2, bz2] = bal.rect
    const shifted = (k) => (along ? [bx1 + k, bz1, bx2 + k, bz2] : [bx1, bz1 + k, bx2, bz2 + k])
    const outer = f.alongX ? (f.out[1] > 0 ? 'z2' : 'z1') : (f.out[0] > 0 ? 'x2' : 'x1')
    for (let fl = -level; fl < 7 - level; fl++) for (const k of [-2, -1, 0, 1, 2]) {
      if (fl === 0 && k === 0) continue
      const y = fl * FLOOR_H
      const [x1, z1, x2, z2] = shifted(k * span)
      block(x1, z1, x2, z2, y - 0.25, y - 0.05, M.concrete)
      // front rail panel + two side panels
      const fr = { z2: [x1, z2 - 0.04, x2, z2 - 0.01], z1: [x1, z1 + 0.01, x2, z1 + 0.04], x2: [x2 - 0.04, z1, x2 - 0.01, z2], x1: [x1 + 0.01, z1, x1 + 0.04, z2] }[outer]
      block(fr[0], fr[1], fr[2], fr[3], y - 0.05, y + 1.1, M.balcony)
      if (along) { block(x1, z1, x1 + 0.1, z2, y - 0.05, y + 1.1, M.balcony); block(x2 - 0.04, z1, x2 - 0.01, z2, y - 0.05, y + 1.1, M.balcony) }
      else { block(x1, z1, x2, z1 + 0.1, y - 0.05, y + 1.1, M.balcony); block(x1, z2 - 0.04, x2, z2 - 0.01, y - 0.05, y + 1.1, M.balcony) }
    }
  }

  // a strip of paving along the façades; the HDRI (grounded skybox) provides the park beyond
  const paving = new THREE.MeshStandardMaterial({ map: speckle({ base: '#b7b1a8', dots: 'rgba(0,0,0,0.12)', metres: 2, ppm: 96, n: 6000 }), roughness: 0.9 })
  const bz = P.BOUNDS
  if (fac.S) block(B.x1 - FAR, bz.z2, B.x2 + FAR, bz.z2 + 2.4, GROUND - 0.2, GROUND + 0.02, paving, false)
  if (fac.N) block(B.x1 - FAR, bz.z1 - 2.4, B.x2 + FAR, bz.z1, GROUND - 0.2, GROUND + 0.02, paving, false)
  if (fac.E) block(bz.x2, B.z1 - FAR, bz.x2 + 2.4, B.z2 + FAR, GROUND - 0.2, GROUND + 0.02, paving, false)
  if (fac.W) block(bz.x1 - 2.4, B.z1 - FAR, bz.x1, B.z2 + FAR, GROUND - 0.2, GROUND + 0.02, paving, false)

  return { root }
}
