// Apartment library: built-in specs in /public/apartments + the user's own (IndexedDB).
// A user apartment = { id, spec, plan: Blob (the floor-plan image), updated }.
const DB = 'apartments-db', OS = 'apartments'
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(OS, { keyPath: 'id' })
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
}
const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(OS, mode); const q = fn(t.objectStore(OS)); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error) }) }

export const userList = () => tx('readonly', (s) => s.getAll())
export const userGet = (id) => tx('readonly', (s) => s.get(id))
export const userPut = (rec) => tx('readwrite', (s) => s.put({ ...rec, updated: Date.now() }))
export const userDelete = (id) => tx('readwrite', (s) => s.delete(id))

export async function builtinList() {
  const ids = await fetch('/apartments/index.json').then((r) => r.json()).catch(() => [])
  return Promise.all(ids.map((id) => fetch(`/apartments/${id}/spec.json`).then((r) => r.json())))
}

// a spec ready to build: user copies win over built-ins (so built-ins can be edited)
export async function loadSpec(id) {
  const u = await userGet(id).catch(() => null)
  if (u) {
    const spec = structuredClone(u.spec)
    if (u.plan) spec.floorplan = { ...spec.floorplan, src: URL.createObjectURL(u.plan) }
    return spec
  }
  const r = await fetch(`/apartments/${id}/spec.json`)
  return r.ok ? r.json() : null
}

export const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'apartment'

// "Hide address": for screenshots you want to share. Remembered on this device, synced across open tabs.
const PRIVATE_KEY = 'hemma-hide-address'
export const isPrivate = () => localStorage.getItem(PRIVATE_KEY) === '1'
export function setPrivate(on) {
  localStorage.setItem(PRIVATE_KEY, on ? '1' : '0')
  dispatchEvent(new CustomEvent('hemma-private', { detail: on }))
}
addEventListener('storage', (e) => { if (e.key === PRIVATE_KEY) dispatchEvent(new CustomEvent('hemma-private', { detail: isPrivate() })) })

// how an apartment is presented: a street title, the flat number + area underneath, and title-block cells
export function describe(spec, hide = isPrivate()) {
  if (hide) {
    const n = spec.rooms_count ?? 1, floor = spec.floors || (spec.floor === 0 ? 'Ground' : spec.floor ?? '')
    return {
      title: `${n} room apartment`, sub: '', hidden: true,
      cells: [['Rooms', n], ['Area', spec.area ? `${spec.area} m²` : ''], ['Floor', floor], ['Ceiling', spec.ceiling ? `${spec.ceiling} m` : '']],
    }
  }
  const parts = String(spec.name || spec.id).split(/\s*[·,]\s*/)
  const street = (spec.address || '').split(',')[0].trim() || parts[0]
  const flat = parts.find((p) => /\d{2}-\d{3,4}/.test(p)) || (parts.length > 1 ? parts[parts.length - 1] : '')
  const town = (spec.address || '').split(',').slice(1).join(',').trim()
  const floor = spec.floors || (spec.floor === 0 ? 'Ground' : spec.floor ?? '')
  return {
    title: street,
    sub: [flat && `Lgh ${flat}`, town].filter(Boolean).join(', '),
    cells: [['Rooms', spec.rooms_count ?? 1], ['Area', spec.area ? `${spec.area} m²` : ''], ['Floor', floor], ['Ceiling', spec.ceiling ? `${spec.ceiling} m` : '']],
  }
}
