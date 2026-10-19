// Export an apartment + layout for baking in Blender.
//   node dev/bake.mjs <apartment-id> <layout-key> [hour]      (dev server must be running on :5190)
// writes dev/bake-work/<id>.glb, .sun.json, .bake.json and .bake.bin (bake.sh publishes them when done)
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [id = 'apartment-1', layout = 'mine', hour = '15'] = process.argv.slice(2)
// layout: a key in the spec's layouts, or @path/to/items.json (the app's current furniture)
const items = layout.startsWith('@') ? JSON.parse(readFileSync(layout.slice(1), 'utf8')) : null
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 800, height: 600 } })
p.on('pageerror', (e) => console.log('page error:', e.message))
p.on('console', (m) => m.type() === 'warning' && console.log(m.text()))
await p.goto(`http://localhost:5190/app.html?apt=${id}`)
await p.waitForFunction(() => window.__apt && window.__bake, null, { timeout: 60000 })
await p.waitForTimeout(4000) // textures (for albedo averages)
const res = await p.evaluate(async ({ id, layout, hour, items }) => {
  const a = window.__apt, B = window.__bake
  const L = await (await fetch(`/apartments/${id}/spec.json`)).json()
  a.state.baked = false
  a.planner.load(items || L.layouts[layout].items)
  a.state.hour = hour; a.setMode('walk'); a.updateSun()
  const d = a.state.date
  const meta = { layout: items ? 'current' : layout, hour, month: d.getMonth() + 1, day: d.getDate(), curtains: a.state.curtains, intensity: 9 }
  const { glb, json, bin } = await B.exportBake(meta)
  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s) }
  const A = a.apt.anchors || {}
  // windowless rooms keep their ceiling light on in walk mode → bake it in
  const lamps = A.bath ? [{ pos: A.bath, color: [1, 0.96, 0.9], power: 2.5 }] : []
  // windowless hall / entry: their ceiling spots are on too, otherwise the far end of the hall bakes near-black
  const roomAt = (x, z) => L.rooms.find((r) => x >= r.rect[0] && x <= r.rect[2] && z >= r.rect[1] && z <= r.rect[3])
  for (const l of L.lights || []) {
    const r = roomAt(l.x, l.z)
    if (r && (r.type === 'hall' || r.type === 'entry')) lamps.push({ pos: [l.x, (r.ceiling || L.ceiling || 2.5) - 0.05, l.z], color: [1, 0.95, 0.88], power: 1.6 })
  }
  const sun = { dir: B.sunDir.toArray(), color: B.sun.color.toArray(), intensity: B.sun.intensity, envRotation: a.scene.environmentRotation.y, lamps }
  return { glb: b64(glb), bin: b64(bin), json, sun }
}, { id, layout, hour: Number(hour), items })
mkdirSync(join(root, 'dev/bake-work'), { recursive: true })
writeFileSync(join(root, `dev/bake-work/${id}.glb`), Buffer.from(res.glb, 'base64'))
writeFileSync(join(root, `dev/bake-work/${id}.sun.json`), JSON.stringify(res.sun, null, 1))
writeFileSync(join(root, `dev/bake-work/${id}.bake.json`), JSON.stringify(res.json)) // published by bake.sh once Blender is done
writeFileSync(join(root, `dev/bake-work/${id}.bake.bin`), Buffer.from(res.bin, 'base64'))
console.log(`${res.json.meshes.length} baked meshes, ${Math.round(res.json.density)} texels/m, glb ${(res.glb.length * 0.75 / 1e6).toFixed(1)} MB`)
console.log('sun', JSON.stringify(res.sun))
await b.close().catch(() => {}); process.exit(0)
