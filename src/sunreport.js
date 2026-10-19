import * as THREE from 'three'
import { solarPosition, sunVector } from './sun.js'

// When does direct sunlight reach the living room / balcony? Rays from sample points toward the
// real sun position, tested against the full building (walls, ceiling, balconies above, neighbours).
// sample points spread over a rect at a few heights
function samples(rect, heights) {
  if (!rect) return []
  const [x1, z1, x2, z2] = rect, out = []
  const fx = [0.2, 0.5, 0.8, 0.35, 0.65, 0.5], fz = [0.75, 0.5, 0.25, 0.9, 0.9, 0.1]
  for (let i = 0; i < Math.min(fx.length, heights.length * 2); i++) out.push([x1 + (x2 - x1) * fx[i], heights[i % heights.length], z1 + (z2 - z1) * fz[i]])
  return out
}

export function makeSunAnalyser(objects, { living, balcony } = {}) {
  const LIVING = samples(living, [0.75, 0.5, 0.3])
  const BALCONY = samples(balcony, [0.6, 0.6, 1.2]).slice(0, 3)
  const ray = new THREE.Raycaster()
  ray.firstHitOnly = true
  const o = new THREE.Vector3(), d = new THREE.Vector3()
  const blocks = (p) => {
    o.set(p[0], p[1], p[2])
    ray.set(o, d); ray.far = 200
    const hits = ray.intersectObjects(objects, true)
    for (const h of hits) {
      const m = h.object.material
      if (h.object.name === 'skybox' || h.object.userData.noPick) continue
      if (m && !Array.isArray(m) && (m.transparent || m.visible === false)) continue // glass, curtains
      return true
    }
    return false
  }
  const lit = (pts) => pts.length > 0 && pts.some((p) => !blocks(p))

  // minutes of direct sun on one day, plus the first/last time
  function day(date, pts, step = 10) {
    let mins = 0, first = null, last = null
    for (let m = 3 * 60; m <= 23 * 60; m += step) {
      const { elevation, azimuth } = solarPosition(date, m / 60)
      if (elevation < 0.5) continue
      sunVector(elevation, azimuth, d)
      if (lit(pts)) { mins += step; if (first === null) first = m; last = m }
    }
    return { mins, first, last }
  }
  return {
    living: (date) => day(date, LIVING),
    balcony: (date) => day(date, BALCONY),
    nowLit: (date, hour) => {
      const { elevation, azimuth } = solarPosition(date, hour)
      if (elevation < 0.5) return false
      sunVector(elevation, azimuth, d)
      return lit(LIVING)
    },
  }
}

export const fmtTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
export const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}` : `${m} min`).trim()
