import * as THREE from 'three'

// Procedural textures sized in real metres. All return textures whose
// `userData.metres` = [w, h] the canvas represents, so planar world UVs
// (1 unit = 1 m) can set repeat = 1 / metres.

let rng = 1234567
const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647)
const range = (a, b) => a + (b - a) * rand()

function finish(canvas, metres, srgb = true, maxAniso = 8) {
  const t = new THREE.CanvasTexture(canvas)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = maxAniso
  t.repeat.set(1 / metres[0], 1 / metres[1])
  t.userData.metres = metres
  return t
}

// 3-strip oak parquet ("3-stavs ekparkett"), boards running along z.
export function oakParquet() {
  const MW = 1.2, MH = 2.4, PPM = 900
  const W = Math.round(MW * PPM), H = Math.round(MH * PPM)
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const g = c.getContext('2d')
  const r = document.createElement('canvas'); r.width = W; r.height = H
  const rg = r.getContext('2d')
  const b = document.createElement('canvas'); b.width = W; b.height = H
  const bg = b.getContext('2d')
  bg.fillStyle = '#808080'; bg.fillRect(0, 0, W, H)
  rg.fillStyle = '#7a7a7a'; rg.fillRect(0, 0, W, H)

  const plankW = 0.2, strips = 3
  const sw = (plankW / strips) * PPM
  const cols = Math.round(MW / (plankW / strips))
  for (let ci = 0; ci < cols; ci++) {
    const x = ci * sw
    // strip lengths that exactly fill the column height (seamless tiling)
    const lens = []
    let total = 0
    while (total < MH) { const l = range(0.32, 0.62); lens.push(l); total += l }
    const k = MH / total
    let y = range(0, 0.4) * PPM
    for (const l0 of lens) {
      const l = l0 * k * PPM
      const hue = range(28, 36), sat = range(32, 48), lig = range(56, 70)
      for (const yy of [y, y - H]) {
        const grd = g.createLinearGradient(x, 0, x + sw, 0)
        grd.addColorStop(0, `hsl(${hue},${sat}%,${lig - 2}%)`)
        grd.addColorStop(0.5, `hsl(${hue + 1},${sat + 2}%,${lig + 1}%)`)
        grd.addColorStop(1, `hsl(${hue},${sat}%,${lig - 3}%)`)
        g.fillStyle = grd
        g.fillRect(x, yy, sw, l)
        // grain
        const n = Math.round(range(10, 22))
        for (let i = 0; i < n; i++) {
          const gx = x + range(2, sw - 2)
          g.strokeStyle = `hsla(${hue - 4},${sat + 8}%,${lig - range(10, 22)}%,${range(0.12, 0.35)})`
          g.lineWidth = range(0.5, 1.6)
          g.beginPath(); g.moveTo(gx, yy)
          const amp = range(0.5, 3), freq = range(0.004, 0.012), ph = range(0, 6)
          for (let t = 0; t <= l; t += 12) g.lineTo(gx + Math.sin(t * freq + ph) * amp, yy + t)
          g.stroke()
        }
        // a couple of knots / flecks (oak rays)
        for (let i = 0; i < Math.round(range(0, 4)); i++) {
          g.fillStyle = `hsla(${hue - 6},50%,${lig - 25}%,${range(0.15, 0.4)})`
          g.beginPath(); g.ellipse(x + range(4, sw - 4), yy + range(0, l), range(0.8, 2.5), range(3, 9), 0, 0, Math.PI * 2); g.fill()
        }
        rg.fillStyle = `rgb(${Math.round(range(100, 140))},0,0)`
        rg.fillRect(x, yy, sw, l)
        // end joints
        g.fillStyle = 'rgba(60,40,20,0.55)'; g.fillRect(x, yy, sw, 1.5)
        bg.fillStyle = '#3a3a3a'; bg.fillRect(x, yy, sw, 2)
      }
      y += l
    }
    // long joints, a bit deeper between planks
    const isPlank = ci % strips === 0
    g.fillStyle = isPlank ? 'rgba(50,32,15,0.7)' : 'rgba(70,45,25,0.35)'
    g.fillRect(x, 0, isPlank ? 2 : 1, H)
    bg.fillStyle = isPlank ? '#202020' : '#555'
    bg.fillRect(x, 0, isPlank ? 2.5 : 1.2, H)
  }
  // roughness: map red channel → grayscale
  const id = rg.getImageData(0, 0, W, H)
  for (let i = 0; i < id.data.length; i += 4) { const v = id.data[i]; id.data[i + 1] = v; id.data[i + 2] = v }
  rg.putImageData(id, 0, 0)
  return { map: finish(c, [MW, MH]), roughnessMap: finish(r, [MW, MH], false), bumpMap: finish(b, [MW, MH], false) }
}

// Rectangular tiles. tw, th in metres; grout in metres.
export function tiles({ tw, th, nx, ny, grout = 0.002, base = [0, 0, 92], vary = 2, groutColor = '#c9c9c4', ppm = 600, offsetRows = false }) {
  const MW = tw * nx, MH = th * ny
  const W = Math.round(MW * ppm), H = Math.round(MH * ppm)
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const g = c.getContext('2d')
  const b = document.createElement('canvas'); b.width = W; b.height = H
  const bg = b.getContext('2d')
  g.fillStyle = groutColor; g.fillRect(0, 0, W, H)
  bg.fillStyle = '#202020'; bg.fillRect(0, 0, W, H)
  const gp = Math.max(1.5, grout * ppm)
  for (let j = 0; j < ny; j++) {
    for (let i = -1; i <= nx; i++) {
      const off = offsetRows && j % 2 ? 0.5 : 0
      const x = (i + off) * tw * ppm, y = j * th * ppm
      const [h, s, l] = base
      const L = l + range(-vary, vary)
      const grd = g.createLinearGradient(x, y, x + tw * ppm, y + th * ppm)
      grd.addColorStop(0, `hsl(${h},${s}%,${L + 0.8}%)`)
      grd.addColorStop(1, `hsl(${h},${s}%,${L - 0.8}%)`)
      g.fillStyle = grd
      g.fillRect(x + gp / 2, y + gp / 2, tw * ppm - gp, th * ppm - gp)
      bg.fillStyle = '#d0d0d0'
      bg.fillRect(x + gp / 2, y + gp / 2, tw * ppm - gp, th * ppm - gp)
    }
  }
  return { map: finish(c, [MW, MH]), bumpMap: finish(b, [MW, MH], false) }
}

// Light speckled noise (for render / stone)
export function speckle({ base = '#d9c6b2', dots = 'rgba(0,0,0,0.05)', metres = 1, ppm = 256, n = 4000 }) {
  const W = Math.round(metres * ppm)
  const c = document.createElement('canvas'); c.width = c.height = W
  const g = c.getContext('2d')
  g.fillStyle = base; g.fillRect(0, 0, W, W)
  for (let i = 0; i < n; i++) {
    g.fillStyle = rand() > 0.5 ? dots : 'rgba(255,255,255,0.06)'
    g.fillRect(rand() * W, rand() * W, range(0.6, 2), range(0.6, 2))
  }
  return finish(c, [metres, metres])
}

// Facade with a window grid (used for the surrounding courtyard buildings)
export function facadeWindows({ base = '#d8c4b0', bayW = 3.2, floorH = 3.2, bays = 4, floors = 3 }) {
  const ppm = 48
  const MW = bayW * bays, MH = floorH * floors
  const c = document.createElement('canvas'); c.width = MW * ppm; c.height = MH * ppm
  const g = c.getContext('2d')
  g.fillStyle = base; g.fillRect(0, 0, c.width, c.height)
  for (let i = 0; i < bays; i++) for (let j = 0; j < floors; j++) {
    const x = (i * bayW + 0.9) * ppm, y = (j * floorH + 0.8) * ppm
    const w = 1.4 * ppm, h = 1.7 * ppm
    g.fillStyle = '#f2efe9'; g.fillRect(x - 4, y - 4, w + 8, h + 8)
    const grd = g.createLinearGradient(x, y, x + w, y + h)
    grd.addColorStop(0, '#6f7f8c'); grd.addColorStop(1, '#3d4852')
    g.fillStyle = grd; g.fillRect(x, y, w, h)
    g.fillStyle = '#f2efe9'; g.fillRect(x + w / 2 - 2, y, 4, h)
  }
  return finish(c, [MW, MH])
}

// Normal map from a height texture (canvas-based); strength ~ slope scale
export function heightToNormal(heightTex, strength = 2) {
  const src = heightTex.image
  const w = src.width, h = src.height
  const g = src.getContext('2d')
  const d = g.getImageData(0, 0, w, h).data
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const out = c.getContext('2d').createImageData(w, h)
  const H = (x, y) => d[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength
    const dy = (H(x, y + 1) - H(x, y - 1)) * strength
    const len = Math.hypot(dx, dy, 1)
    const i = (y * w + x) * 4
    out.data[i] = (-dx / len * 0.5 + 0.5) * 255
    out.data[i + 1] = (dy / len * 0.5 + 0.5) * 255
    out.data[i + 2] = (1 / len * 0.5 + 0.5) * 255
    out.data[i + 3] = 255
  }
  c.getContext('2d').putImageData(out, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.NoColorSpace
  t.repeat.copy(heightTex.repeat)
  t.anisotropy = heightTex.anisotropy
  return t
}

// Image texture with real-world size in metres (repeat = 1 / metres)
const loader = new THREE.TextureLoader()
const cache = new Map()
export function tex(path, { srgb = false, metres = [1, 1], aniso = 8 } = {}) {
  const key = path + metres.join('x') + srgb
  if (cache.has(key)) return cache.get(key)
  const t = loader.load(path)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = aniso
  t.repeat.set(1 / metres[0], 1 / metres[1])
  cache.set(key, t)
  return t
}
