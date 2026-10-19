// Home: each apartment is a drawing sheet: its plan with the flat marked in highlighter yellow (like the key plan on
// a listing), and a title block underneath. Dropping or picking a plan image starts a new one in the editor.
import { hydrateIcons, icon } from './icons.js'
import { builtinList, userList, userDelete, userPut, describe, isPrivate, setPrivate } from './store.js'

hydrateIcons()
const grid = document.getElementById('grid')
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

async function render() {
  const [builtins, mine] = await Promise.all([builtinList(), userList().catch(() => [])])
  const own = mine.filter((u) => !u.id.startsWith('__') && u.spec)
  const ownIds = new Set(own.map((u) => u.id))
  const list = [
    ...own.sort((a, b) => (b.updated || 0) - (a.updated || 0)).map((u) => ({ spec: u.spec, plan: u.plan, mine: true, edited: builtins.some((b) => b.id === u.id) })),
    ...builtins.filter((b) => !ownIds.has(b.id)).map((spec) => ({ spec })),
  ]
  grid.innerHTML = ''
  for (const c of list) grid.appendChild(sheet(c))
  grid.appendChild(newSheet())
}

function sheet({ spec, plan, mine, edited }) {
  const el = document.createElement('article'); el.className = 'sheet'
  const id = encodeURIComponent(spec.id), d = describe(spec), href = `/app.html?apt=${id}`
  el.innerHTML = `
    <div class="plan"><canvas></canvas>${mine ? `<span class="tag">${edited ? 'Your edit' : 'Yours'}</span>` : ''}<span class="open3d">${icon('house')} Open in 3D</span></div>
    <div class="tb">
      <div class="tb-title"><h2><a href="${href}">${esc(d.title)}</a></h2><div class="sub">${esc(d.sub)}</div></div>
      <div class="tb-act">
        <a href="/editor.html?apt=${id}" title="Edit walls, doors and rooms">${icon('blueprint')} Edit</a>
        ${mine ? `<button class="danger" title="${edited ? 'Throw away your edits' : 'Delete'}">${icon('trash')}</button>` : ''}
      </div>
      <dl>${d.cells.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    </div>`
  const del = el.querySelector('button.danger')
  if (del) del.onclick = async () => {
    if (!confirm(edited ? `Throw away your edits to ${d.title}?` : `Delete ${d.title}? This can't be undone.`)) return
    await userDelete(spec.id); render()
  }
  drawPlan(el.querySelector('canvas'), spec, plan)
  return el
}

// a dashed sheet that takes a plan image: click to pick one, or drop it here (or anywhere on the page)
function newSheet() {
  const el = document.createElement('label'); el.className = 'sheet new'; el.htmlFor = 'pick'
  el.innerHTML = `
    <svg class="glyph" viewBox="0 0 108 86" fill="none" stroke="#1f2421" aria-hidden="true">
      <rect x="1.5" y="1.5" width="105" height="83" stroke-width="3" stroke-dasharray="6 5"/>
      <path d="M22 18h64v50H22z" stroke-width="5"/><path d="M54 18v22h32" stroke-width="3"/><path d="M38 68v-6" stroke-width="3"/>
      <rect x="54" y="40" width="32" height="28" fill="#f4c430" stroke="none" opacity=".75"/>
    </svg>
    <b>Add a floor plan</b>
    <span>Drop the plan image from the listing here, or click to choose one.</span>
    <ol class="steps"><li><i>1</i>Click both ends of the scale bar</li><li><i>2</i>Walls, doors and rooms are found for you</li><li><i>3</i>Add the kitchen and bathroom, then open it in 3D</li></ol>`
  return el
}
async function startWith(file) {
  if (!file || !file.type.startsWith('image/')) return
  await userPut({ id: '__pending', plan: file })
  location.href = '/editor.html?pending=1'
}
document.getElementById('pick').onchange = (e) => startWith(e.target.files[0])
addEventListener('dragover', (e) => { e.preventDefault(); document.querySelector('.sheet.new')?.classList.add('drag') })
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.querySelector('.sheet.new')?.classList.remove('drag') })
addEventListener('drop', (e) => { e.preventDefault(); startWith(e.dataTransfer.files[0]) })
addEventListener('paste', (e) => { const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/')); if (it) startWith(it.getAsFile()) })

// the drawing, cropped to the flat, with the flat marked in highlighter yellow
async function drawPlan(cv, spec, planBlob) {
  const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1)
  const W = Math.round((r.width || 400) * dpr), H = Math.round((r.height || 320) * dpr)
  cv.width = W; cv.height = H
  const g = cv.getContext('2d')
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H)
  const F = spec.floorplan || {}
  let img
  try { img = await createImageBitmap(planBlob || (await fetch(F.src).then((x) => x.blob()))) } catch { return }
  const ppm = F.pxPerM || 100, o = F.origin || [0, 0]
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity
  for (const q of [...(spec.walls || []), ...(spec.rooms || []).map((rm) => rm.rect), ...(spec.balcony ? [spec.balcony.rect] : [])]) {
    x1 = Math.min(x1, q[0]); z1 = Math.min(z1, q[1]); x2 = Math.max(x2, q[2]); z2 = Math.max(z2, q[3])
  }
  if (!isFinite(x1)) { x1 = 0; z1 = 0; x2 = img.width / ppm; z2 = img.height / ppm }
  const pad = 1.0
  const sx = o[0] + (x1 - pad) * ppm, sy = o[1] + (z1 - pad) * ppm, sw = (x2 - x1 + 2 * pad) * ppm, sh = (z2 - z1 + 2 * pad) * ppm
  const k = Math.min(W / sw, H / sh), dw = sw * k, dh = sh * k, dx = (W - dw) / 2, dy = (H - dh) / 2
  // highlighter under the ink: rooms in yellow, then the drawing multiplied on top
  const P = (x, z) => [dx + (o[0] + x * ppm - sx) * k, dy + (o[1] + z * ppm - sy) * k]
  const rect = (q) => { const a = P(q[0], q[1]), b = P(q[2], q[3]); return [a[0], a[1], b[0] - a[0], b[1] - a[1]] }
  g.fillStyle = 'rgba(244, 196, 48, 0.55)'
  for (const rm of spec.rooms || []) if (rm.type !== 'balcony') g.fillRect(...rect(rm.rect))
  g.globalCompositeOperation = 'multiply'
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
  g.globalCompositeOperation = 'source-over'
}

// hide the address on every card, e.g. before taking a screenshot to share
const pb = document.getElementById('privacyBtn')
function syncPrivacy() {
  const on = isPrivate()
  pb.innerHTML = icon(on ? 'eye-slash' : 'eye')
  pb.setAttribute('aria-pressed', String(on))
  pb.title = pb.ariaLabel = on ? 'Show address' : 'Hide address'
}
pb.onclick = () => setPrivate(!isPrivate())
addEventListener('hemma-private', () => { syncPrivacy(); render() })
syncPrivacy()
render()
