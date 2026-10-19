// Floor-plan recognition for the editor: solid wall fills → wall rectangles, gaps between collinear walls →
// openings, enclosed areas → rooms. Works on any architectural plan where walls are drawn as thick dark fills.

const r2 = (v) => Math.round(v * 100) / 100 // 1 cm

// ImageData + scale → [[x1, z1, x2, z2], …] in metres (image px / pxPerM, origin = image top-left)
export function detectWalls(img, pxPerM, { minThick = 0.075, region = null } = {}) {
  const f = Math.max(1, Math.floor(pxPerM / 40)) // work at ≈ 2.5 cm per cell
  const ppm = pxPerM / f
  const W = Math.floor(img.width / f), H = Math.floor(img.height / f)
  const dark = new Uint8Array(W * H)
  const d = img.data
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
      const p = ((y * f + j) * img.width + (x * f + i)) * 4
      const a = d[p + 3] / 255
      s += (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) * a + 255 * (1 - a); n++
    }
    dark[y * W + x] = s / n < 115 ? 1 : 0
  }
  if (region) { // only inside a user-drawn box (metres)
    const [a, b, c, e] = region.map((v) => v * ppm)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < a || x > c || y < b || y > e) dark[y * W + x] = 0
  }
  // morphological opening with a k×k square keeps only fills at least `minThick` thick (no text, hatching, lines)
  const k = Math.max(2, Math.round(minThick * ppm))
  const integ = new Int32Array((W + 1) * (H + 1))
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += dark[y * W + x]; integ[(y + 1) * (W + 1) + x + 1] = integ[y * (W + 1) + x + 1] + row } }
  const sum = (x1, y1, x2, y2) => integ[y2 * (W + 1) + x2] - integ[y1 * (W + 1) + x2] - integ[y2 * (W + 1) + x1] + integ[y1 * (W + 1) + x1]
  const ero = new Uint8Array(W * H)
  for (let y = 0; y + k <= H; y++) for (let x = 0; x + k <= W; x++) if (sum(x, y, x + k, y + k) === k * k) ero[y * W + x] = 1 // top-left anchored
  const ei = new Int32Array((W + 1) * (H + 1))
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += ero[y * W + x]; ei[(y + 1) * (W + 1) + x + 1] = ei[y * (W + 1) + x + 1] + row } }
  const esum = (x1, y1, x2, y2) => ei[y2 * (W + 1) + x2] - ei[y1 * (W + 1) + x2] - ei[y2 * (W + 1) + x1] + ei[y1 * (W + 1) + x1]
  const op = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (dark[y * W + x] && esum(Math.max(0, x - k + 1), Math.max(0, y - k + 1), x + 1, y + 1) > 0) op[y * W + x] = 1

  // connected components: keep the biggest structure (the apartment) + pieces close to it
  const lab = new Int32Array(W * H), comps = []
  const st = []
  for (let i = 0; i < W * H; i++) {
    if (!op[i] || lab[i]) continue
    const id = comps.length + 1, c = { n: 0, x1: W, y1: H, x2: 0, y2: 0 }
    lab[i] = id; st.push(i)
    while (st.length) {
      const p = st.pop(), x = p % W, y = (p / W) | 0
      c.n++; if (x < c.x1) c.x1 = x; if (x > c.x2) c.x2 = x; if (y < c.y1) c.y1 = y; if (y > c.y2) c.y2 = y
      for (const q of [p - 1, p + 1, p - W, p + W]) if (q >= 0 && q < W * H && op[q] && !lab[q] && Math.abs((q % W) - x) <= 1) { lab[q] = id; st.push(q) }
    }
    comps.push(c)
  }
  if (!comps.length) return []
  const main = comps.reduce((a, b) => (b.n > a.n ? b : a))
  const pad = Math.round(0.35 * ppm), reach = Math.round(2.0 * ppm) // window gaps can be ~2 m wide
  const keep = new Set([comps.indexOf(main) + 1])
  // grow the apartment outline by every sizeable piece touching it (walls are often split by window frames)
  const box = { x1: main.x1, y1: main.y1, x2: main.x2, y2: main.y2 }
  for (let grew = true; grew;) {
    grew = false
    comps.forEach((c, i) => {
      if (keep.has(i + 1) || c.n < k * k * 2) return
      const r = c.n > k * k * 8 && Math.max(c.x2 - c.x1, c.y2 - c.y1) > 0.6 * ppm ? reach : pad // long wall pieces may sit across a window
      if (c.x2 >= box.x1 - r && c.x1 <= box.x2 + r && c.y2 >= box.y1 - r && c.y1 <= box.y2 + r) {
        keep.add(i + 1); grew = true
        box.x1 = Math.min(box.x1, c.x1); box.y1 = Math.min(box.y1, c.y1); box.x2 = Math.max(box.x2, c.x2); box.y2 = Math.max(box.y2, c.y2)
      }
    })
  }
  for (let i = 0; i < W * H; i++) if (op[i] && !keep.has(lab[i])) op[i] = 0

  // greedy largest-rectangle decomposition (histogram method)
  const bx1 = Math.max(0, box.x1 - 2), by1 = Math.max(0, box.y1 - 2), bx2 = Math.min(W - 1, box.x2 + 2), by2 = Math.min(H - 1, box.y2 + 2)
  const rects = [], hist = new Int32Array(W + 1), minArea = k * k * 1.5
  for (let guard = 0; guard < 400; guard++) {
    let best = 0, br = null
    hist.fill(0)
    for (let y = by1; y <= by2; y++) {
      for (let x = bx1; x <= bx2; x++) hist[x] = op[y * W + x] ? hist[x] + 1 : 0
      const stack = []
      for (let x = bx1; x <= bx2 + 1; x++) {
        const h = x <= bx2 ? hist[x] : 0
        let s = x
        while (stack.length && stack[stack.length - 1][1] >= h) {
          const [sx, sh] = stack.pop(); s = sx
          const area = sh * (x - sx)
          if (area > best && sh >= k && x - sx >= k) { best = area; br = [sx, y - sh + 1, x - 1, y] }
        }
        stack.push([s, h])
      }
    }
    if (!br || best < minArea) break
    const [x1, y1, x2, y2] = br
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) op[y * W + x] = 0
    rects.push([r2(x1 / ppm), r2(y1 / ppm), r2((x2 + 1) / ppm), r2((y2 + 1) / ppm)])
  }
  return snapWalls(rects)
}

// snap nearly-equal coordinates together so walls line up exactly
export function snapWalls(rects, tol = 0.03) {
  const xs = [], zs = []
  for (const r of rects) { xs.push(r[0], r[2]); zs.push(r[1], r[3]) }
  const cluster = (vals) => {
    const s = [...vals].sort((a, b) => a - b), map = new Map()
    let group = []
    const flush = () => { if (!group.length) return; const m = r2(group.reduce((a, b) => a + b, 0) / group.length); for (const g of group) map.set(g, m); group = [] }
    for (const v of s) { if (group.length && v - group[group.length - 1] > tol) flush(); group.push(v) }
    flush()
    return map
  }
  const mx = cluster(xs), mz = cluster(zs)
  return rects.map((r) => [mx.get(r[0]), mz.get(r[1]), mx.get(r[2]), mz.get(r[3])]).filter((r) => r[2] - r[0] > 0.02 && r[3] - r[1] > 0.02)
}

export function wallBounds(walls) {
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity
  for (const w of walls) { x1 = Math.min(x1, w[0]); z1 = Math.min(z1, w[1]); x2 = Math.max(x2, w[2]); z2 = Math.max(z2, w[3]) }
  return { x1, z1, x2, z2 }
}

// the gap in a wall at point (x, z): between two collinear walls → slot rect, or null
export function gapAt(walls, x, z, maxGap = 3) {
  let best = null
  const consider = (slot, len) => { if (len > 0.35 && len < maxGap && (!best || len < best.len)) best = { slot, len } }
  // horizontal run (gap along x): walls left & right sharing a z band that contains z
  for (const a of walls) {
    if (a[2] > x || z < a[1] - 0.02 || z > a[3] + 0.02) continue
    for (const b of walls) {
      if (b[0] < x || z < b[1] - 0.02 || z > b[3] + 0.02) continue
      const z1 = Math.max(a[1], b[1]), z2 = Math.min(a[3], b[3])
      if (z2 - z1 < 0.05) continue
      if (walls.some((c) => c !== a && c !== b && c[0] < b[0] - 0.01 && c[2] > a[2] + 0.01 && c[1] < z2 - 0.01 && c[3] > z1 + 0.01)) continue
      consider([a[2], z1, b[0], z2], b[0] - a[2])
    }
  }
  for (const a of walls) {
    if (a[3] > z || x < a[0] - 0.02 || x > a[2] + 0.02) continue
    for (const b of walls) {
      if (b[1] < z || x < b[0] - 0.02 || x > b[2] + 0.02) continue
      const x1 = Math.max(a[0], b[0]), x2 = Math.min(a[2], b[2])
      if (x2 - x1 < 0.05) continue
      if (walls.some((c) => c !== a && c !== b && c[1] < b[1] - 0.01 && c[3] > a[3] + 0.01 && c[0] < x2 - 0.01 && c[2] > x1 + 0.01)) continue
      consider([x1, a[3], x2, b[1]], b[1] - a[3])
    }
  }
  return best?.slot || null
}

// flood fill from the border with the given solids as barriers → isOutside(x, z)
export function outsideTest(solids) {
  const B = wallBounds(solids)
  const xs = [...new Set([B.x1 - 0.5, B.x2 + 0.5, ...solids.flatMap((s) => [s[0], s[2]])])].sort((a, b) => a - b)
  const zs = [...new Set([B.z1 - 0.5, B.z2 + 0.5, ...solids.flatMap((s) => [s[1], s[3]])])].sort((a, b) => a - b)
  const NX = xs.length - 1, NZ = zs.length - 1, out = new Uint8Array(NX * NZ), solid = new Uint8Array(NX * NZ)
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2
    if (solids.some((s) => cx > s[0] && cx < s[2] && cz > s[1] && cz < s[3])) solid[j * NX + i] = 1
  }
  const st = []
  for (let i = 0; i < NX; i++) for (const j of [0, NZ - 1]) st.push(j * NX + i)
  for (let j = 0; j < NZ; j++) for (const i of [0, NX - 1]) st.push(j * NX + i)
  while (st.length) {
    const p = st.pop(); if (out[p] || solid[p]) continue
    out[p] = 1
    const i = p % NX, j = (p / NX) | 0
    if (i > 0) st.push(p - 1); if (i < NX - 1) st.push(p + 1); if (j > 0) st.push(p - NX); if (j < NZ - 1) st.push(p + NX)
  }
  const find = (arr, v) => { let lo = 0, hi = arr.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= v) lo = m; else hi = m - 1 } return lo }
  return (x, z) => {
    if (x <= xs[0] || x >= xs[NX] || z <= zs[0] || z >= zs[NZ]) return true
    return !!out[find(zs, z) * NX + find(xs, x)]
  }
}

// all gaps between collinear walls → opening guesses (windows on the façade, the front door, inner doors)
export function detectOpenings(walls) {
  const cand = []
  const seen = (s) => cand.some((o) => Math.abs(o.slot[0] - s[0]) < 0.03 && Math.abs(o.slot[1] - s[1]) < 0.03 && Math.abs(o.slot[2] - s[2]) < 0.03 && Math.abs(o.slot[3] - s[3]) < 0.03)
  for (const a of walls) for (const b of walls) {
    if (a === b) continue
    if (b[0] > a[2] + 0.4 && b[0] - a[2] <= 2.6) { // b to the right of a, sharing a z band
      const z1 = Math.max(a[1], b[1]), z2 = Math.min(a[3], b[3])
      if (z2 - z1 > 0.06 && z2 - z1 < 0.6 && !walls.some((c) => c !== a && c !== b && c[0] < b[0] - 0.01 && c[2] > a[2] + 0.01 && c[1] < z2 - 0.01 && c[3] > z1 + 0.01)) {
        const s = [a[2], z1, b[0], z2]; if (!seen(s)) cand.push({ slot: s, alongX: true, len: b[0] - a[2], ta: a[3] - a[1], tb: b[3] - b[1] })
      }
    }
    if (b[1] > a[3] + 0.4 && b[1] - a[3] <= 2.6) { // b below a, sharing an x band
      const x1 = Math.max(a[0], b[0]), x2 = Math.min(a[2], b[2])
      if (x2 - x1 > 0.06 && x2 - x1 < 0.6 && !walls.some((c) => c !== a && c !== b && c[1] < b[1] - 0.01 && c[3] > a[3] + 0.01 && c[0] < x2 - 0.01 && c[2] > x1 + 0.01)) {
        const s = [x1, a[3], x2, b[1]]; if (!seen(s)) cand.push({ slot: s, alongX: false, len: b[1] - a[3], ta: a[2] - a[0], tb: b[2] - b[0] })
      }
    }
  }
  // what's outside: flood from the border with walls + every candidate gap closed
  const isOut = outsideTest([...walls, ...cand.map((c) => c.slot)])
  const found = []
  for (const c of cand) {
    const [x1, z1, x2, z2] = c.slot, cx = (x1 + x2) / 2, cz = (z1 + z2) / 2, band = c.alongX ? z2 - z1 : x2 - x1
    const d = band / 2 + 0.06
    const sides = c.alongX ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]]
    const outs = sides.map(([dx, dz]) => isOut(cx + dx * d, cz + dz * d))
    if (outs[0] && outs[1]) continue // floating in the open
    c.exterior = outs[0] || outs[1]
    c.out = c.exterior ? (outs[0] ? sides[0] : sides[1]) : null
    // exterior gaps can be wide windows; inner gaps must look like a door in a wall of one thickness
    const ok = c.exterior ? c.len >= 0.45 && c.len <= 2.6 : c.len >= 0.6 && c.len <= 1.15 && Math.abs(c.ta - band) < 0.05 && Math.abs(c.tb - band) < 0.05
    if (ok) found.push(c)
  }
  const sideName = (o) => (o.out[1] < 0 ? 'N' : o.out[1] > 0 ? 'S' : o.out[0] < 0 ? 'W' : 'E')
  const counts = {}
  for (const o of found) if (o.exterior) counts[sideName(o)] = (counts[sideName(o)] || 0) + 1
  const facade = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
  let entrance = false
  return found.map((o) => {
    if (o.exterior && sideName(o) === facade) return { kind: 'window', slot: o.slot, out: o.out, sill: 0.7, head: 2.35, sashes: o.len > 1.3 ? 2 : 1 }
    if (o.exterior && !entrance && o.len < 1.2) { entrance = true; return { kind: 'entrance', slot: o.slot, out: o.out, head: 2.1, hinge: 0 } }
    if (o.exterior) return { kind: 'window', slot: o.slot, out: o.out, sill: 0.7, head: 2.35, sashes: o.len > 1.3 ? 2 : 1 }
    return { kind: 'door', slot: o.slot, swing: o.alongX ? [0, 1] : [1, 0], head: 2.1, hinge: 0, name: 'Dörr' }
  })
}

// wall pieces with the outside on every side (balcony side lines, fences, stray marks) aren't part of the flat
export function pruneWalls(walls, openings) {
  const isOut = outsideTest([...walls, ...openings.map((o) => o.slot)])
  return walls.filter((w) => {
    const [x1, z1, x2, z2] = w, cx = (x1 + x2) / 2, cz = (z1 + z2) / 2, e = 0.05
    return ![[cx, z1 - e], [cx, z2 + e], [x1 - e, cz], [x2 + e, cz]].every(([x, z]) => isOut(x, z) || walls.some((o) => o !== w && x > o[0] && x < o[2] && z > o[1] && z < o[3]))
  })
}

// enclosed areas (walls + openings as barriers) → non-overlapping room rects, exactly on the wall lines
export function detectRooms(walls, openings, { ceiling = 2.5 } = {}) {
  const solids = [...walls, ...openings.map((o) => o.slot)]
  const B = wallBounds(walls)
  const xs = [...new Set([B.x1 - 0.5, B.x2 + 0.5, ...solids.flatMap((s) => [s[0], s[2]])])].sort((a, b) => a - b)
  const zs = [...new Set([B.z1 - 0.5, B.z2 + 0.5, ...solids.flatMap((s) => [s[1], s[3]])])].sort((a, b) => a - b)
  const NX = xs.length - 1, NZ = zs.length - 1
  const blocked = new Uint8Array(NX * NZ)
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2
    if (solids.some((s) => cx > s[0] && cx < s[2] && cz > s[1] && cz < s[3])) blocked[j * NX + i] = 1
  }
  // flood fill regions; ones touching the border are outside
  const reg = new Int32Array(NX * NZ).fill(-1), regions = []
  for (let s = 0; s < NX * NZ; s++) {
    if (blocked[s] || reg[s] >= 0) continue
    const id = regions.length, cells = [], st = [s]; reg[s] = id
    let outside = false
    while (st.length) {
      const p = st.pop(), i = p % NX, j = (p / NX) | 0
      cells.push(p)
      if (i === 0 || j === 0 || i === NX - 1 || j === NZ - 1) outside = true
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj
        if (a < 0 || b < 0 || a >= NX || b >= NZ) continue
        const q = b * NX + a
        if (!blocked[q] && reg[q] < 0) { reg[q] = id; st.push(q) }
      }
    }
    regions.push({ id, cells, outside })
  }
  const rooms = [], shafts = []
  for (const R of regions) {
    if (R.outside) continue
    const inR = new Uint8Array(NX * NZ)
    for (const c of R.cells) inR[c] = 1
    const area = R.cells.reduce((a, c) => a + (xs[(c % NX) + 1] - xs[c % NX]) * (zs[((c / NX) | 0) + 1] - zs[(c / NX) | 0]), 0)
    if (area < 0.6) { shafts.push(...R.cells.map((c) => [xs[c % NX], zs[(c / NX) | 0], xs[(c % NX) + 1], zs[((c / NX) | 0) + 1]].map(r2))); continue }
    // greedy biggest rectangles of free cells
    const rects = []
    for (let guard = 0; guard < 30; guard++) {
      let best = 0, br = null
      for (let i1 = 0; i1 < NX; i1++) for (let i2 = i1; i2 < NX; i2++) {
        const w = xs[i2 + 1] - xs[i1]
        let j0 = -1
        for (let j = 0; j <= NZ; j++) {
          let ok = j < NZ
          if (ok) for (let i = i1; i <= i2; i++) if (!inR[j * NX + i]) { ok = false; break }
          if (ok && j0 < 0) j0 = j
          if (!ok && j0 >= 0) {
            const a = w * (zs[j] - zs[j0])
            if (a > best) { best = a; br = [i1, j0, i2, j - 1] }
            j0 = -1
          }
        }
      }
      if (!br || best < 0.12) break
      const [i1, j1, i2, j2] = br
      for (let j = j1; j <= j2; j++) for (let i = i1; i <= i2; i++) inR[j * NX + i] = 0
      rects.push([xs[i1], zs[j1], xs[i2 + 1], zs[j2 + 1]].map(r2))
    }
    rooms.push({ area, rects })
  }
  // name them: biggest = living room, small closed ones = storage / bathroom
  rooms.sort((a, b) => b.area - a.area)
  const out = []
  const entrance = openings.find((o) => o.kind === 'entrance')
  const touches = (r, s, e = 0.03) => r[0] <= s[2] + e && r[2] >= s[0] - e && r[1] <= s[3] + e && r[3] >= s[1] - e
  rooms.forEach((R, k) => {
    let type = 'room', name = 'Rum'
    if (k === 0) { type = 'living'; name = 'Kök / vardagsrum' }
    else if (R.area < 1.6) { type = 'storage'; name = 'Förråd' }
    else if (R.area < 7 && !(entrance && R.rects.some((r) => touches(r, entrance.slot)))) { type = 'bath'; name = 'Badrum' }
    else if (entrance && R.rects.some((r) => touches(r, entrance.slot))) { type = 'hall'; name = 'Hall' }
    R.rects.forEach((rect, i) => {
      let t = type, nm = name, label = i === 0
      // the part of the living area by the front door is the hall
      if (type === 'living' && entrance && touches(rect, entrance.slot) && R.rects.length > 1 && i > 0) { t = 'hall'; nm = 'Hall'; label = !out.some((o) => o.type === 'hall' && o.label !== false) }
      out.push({ id: `${t}${out.length}`, name: label ? nm : '', type: t, rect, floor: t === 'bath' ? 'bath' : 'parquet', ceiling: t === 'bath' ? Math.min(2.3, ceiling) : ceiling, ...(label ? {} : { label: false }) })
    })
  })
  out.shafts = shafts // small enclosed voids (ventilation shafts etc.): solid in 3D
  return out
}
