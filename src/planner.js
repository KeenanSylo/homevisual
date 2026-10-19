import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { CATALOG, onModelLoaded } from './furniture.js'

// per-apartment storage
let STORE = 'apt-apartment-1-layout'
let SAVED = 'apt-apartment-1-saved-layouts'
let SPAWN = [3.3, 4.4]
export function configurePlanner(id, spawn) {
  STORE = `apt-${id}-layout`; SAVED = `apt-${id}-saved-layouts`
  if (spawn) SPAWN = spawn
}
let uid = 1

// Furniture placement: add / select / drag / rotate / resize, clearance read-outs.
export class Planner {
  constructor(scene, overlay, getStatic) {
    this.scene = scene
    this.getStatic = getStatic // () => Object3D to raycast for clearances
    this.group = new THREE.Group(); this.group.name = 'furniture'
    scene.add(this.group)
    this.items = []
    this.selected = null
    this.listeners = new Set()
    this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0xff7a1a)
    this.selBox.visible = false
    this.selBox.material.depthTest = false; this.selBox.renderOrder = 10
    overlay.add(this.selBox)
    // clearance lines
    this.clear = new THREE.Group(); overlay.add(this.clear)
    this.clearLines = []
    for (let i = 0; i < 4; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff7a1a, depthTest: false, transparent: true }))
      line.renderOrder = 11
      const el = document.createElement('div'); el.className = 'clear-label'
      const label = new CSS2DObject(el)
      line.add(label)
      this.clear.add(line)
      this.clearLines.push({ line, label, el })
    }
    this.clear.visible = false
    this.ray = new THREE.Raycaster()
    onModelLoaded(() => { for (const it of this.items) if (CATALOG[it.type].uniform) this.rebuild(it); this.emit() })
  }

  onChange(fn) { this.listeners.add(fn) }
  emit() { for (const fn of this.listeners) fn(this) }

  add(type, o = {}) {
    const def = CATALOG[type]; if (!def) return null
    const item = {
      id: uid++, type,
      x: o.x ?? SPAWN[0], z: o.z ?? SPAWN[1], rot: o.rot ?? 0,
      w: o.w ?? def.w, d: o.d ?? def.d, h: o.h ?? def.h,
      elev: o.elev ?? def.elev ?? 0,
      color: o.color ?? def.color,
      obj: null,
    }
    this.items.push(item)
    this.rebuild(item)
    return item
  }

  rebuild(item) {
    if (item.obj) { this.group.remove(item.obj); item.obj.traverse((m) => m.geometry && m.geometry.dispose()) }
    const def = CATALOG[item.type]
    const obj = def.build(item.w, item.d, item.h, item.color)
    obj.traverse((m) => { m.userData.item = item })
    item.obj = obj
    this.group.add(obj)
    this.place(item)
  }

  // things standing on or inside a piece (TV on KALLAX, monitor on the desk, a box on a shelf): their
  // centre is over its footprint and they sit above its base, up to its top
  riders(base, pose) {
    const c = Math.cos(pose.rot), s = Math.sin(pose.rot)
    return this.items.filter((o) => {
      if (o === base || o.elev <= pose.elev + 0.01 || o.elev > pose.elev + pose.h + 0.05) return false
      const dx = o.x - pose.x, dz = o.z - pose.z
      return Math.abs(dx * c - dz * s) <= pose.w / 2 + 0.02 && Math.abs(dx * s + dz * c) <= pose.d / 2 + 0.02
    })
  }

  place(item) {
    // whatever rides on this piece keeps its spot on it: same offset, turn and height above the top
    const was = item.pose, now = { x: item.x, z: item.z, rot: item.rot, elev: item.elev, w: item.w, d: item.d, h: item.h }
    item.pose = now
    if (was && (was.x !== now.x || was.z !== now.z || was.rot !== now.rot || was.elev !== now.elev || was.h !== now.h)) {
      const c0 = Math.cos(was.rot), s0 = Math.sin(was.rot), c1 = Math.cos(now.rot), s1 = Math.sin(now.rot)
      // who rides is decided when a move starts and kept until it's saved, so dragging a desk past the
      // KALLAX doesn't scoop up the TV on the way
      if (!this.riding) this.riding = new Map()
      if (!this.riding.has(item)) this.riding.set(item, this.riders(item, was))
      for (const o of this.riding.get(item)) {
        const dx = o.x - was.x, dz = o.z - was.z
        const lx = dx * c0 - dz * s0, lz = dx * s0 + dz * c0 // in the piece's own frame
        o.x = now.x + lx * c1 + lz * s1; o.z = now.z - lx * s1 + lz * c1
        o.rot = (o.rot + now.rot - was.rot + Math.PI * 4) % (Math.PI * 2)
        // on top: follows the top (also when the piece is made taller); inside, on a shelf: follows the base
        const onTop = o.elev > was.elev + was.h - 0.05
        o.elev = Math.max(0, o.elev + (onTop ? now.elev + now.h - was.elev - was.h : now.elev - was.elev))
        if (o.obj) this.place(o)
      }
    }
    item.obj.position.set(item.x, item.elev, item.z)
    item.obj.rotation.y = item.rot
    item.obj.updateMatrixWorld(true)
    if (item === this.selected) this.updateSelection()
  }

  remove(item) {
    if (!item) return
    this.group.remove(item.obj)
    this.items = this.items.filter((i) => i !== item)
    if (this.selected === item) this.select(null)
    this.save(); this.emit()
  }

  duplicate(item) {
    if (!item) return
    const c = this.add(item.type, { ...item, x: item.x + 0.3, z: item.z + 0.3 })
    this.select(c); this.save()
  }

  clearAll() { for (const i of [...this.items]) this.group.remove(i.obj); this.items = []; this.select(null); this.save(); this.emit() }

  select(item) {
    this.selected = item
    this.riding = null
    this.updateSelection()
    this.emit()
  }

  updateSelection() {
    const it = this.selected
    this.selBox.visible = !!it
    this.clear.visible = !!it
    if (!it) return
    this.selBox.box.setFromObject(it.obj)
    this.updateClearance()
  }

  // distances from the selected item's sides to the nearest obstacle
  updateClearance() {
    const it = this.selected; if (!it) return
    const targets = [this.getStatic(), ...this.items.filter((i) => i !== it && !CATALOG[i.type].noCollide && i.type !== 'rug').map((i) => i.obj)]
    const y = it.elev + Math.min(0.3, Math.max(0.08, it.h * 0.5))
    const c = Math.cos(it.rot), s = Math.sin(it.rot)
    const ax = new THREE.Vector3(c, 0, -s) // local +x in world
    const az = new THREE.Vector3(s, 0, c) // local +z in world
    const sides = [
      [ax, it.w / 2], [ax.clone().negate(), it.w / 2],
      [az, it.d / 2], [az.clone().negate(), it.d / 2],
    ]
    sides.forEach(([dir, half], i) => {
      const o = new THREE.Vector3(it.x, y, it.z).addScaledVector(dir, half + 0.002)
      this.ray.set(o, dir); this.ray.far = 8
      const hits = this.ray.intersectObjects(targets, true).filter((h) => h.object.visible && !h.object.material?.transparent)
      const L = this.clearLines[i]
      if (!hits.length) { L.line.visible = false; return }
      const p = hits[0].point
      L.line.visible = true
      L.line.geometry.setFromPoints([o, p])
      L.label.position.copy(o).lerp(p, 0.5).sub(L.line.position)
      const cm = Math.round(hits[0].distance * 100)
      L.el.textContent = cm + ' cm'
      L.el.classList.toggle('tight', cm < 60)
    })
  }

  // footprints for walk-mode collision
  colliders() {
    const out = []
    for (const it of this.items) {
      if (CATALOG[it.type].noCollide || it.type === 'rug' || it.elev > 1.2) continue
      const b = new THREE.Box3().setFromObject(it.obj)
      out.push({ x1: b.min.x, z1: b.min.z, x2: b.max.x, z2: b.max.z })
    }
    return out
  }

  serialize() { return this.items.map(({ type, x, z, rot, w, d, h, elev, color }) => ({ type, x: +x.toFixed(3), z: +z.toFixed(3), rot: +rot.toFixed(4), w, d, h, elev, color })) }
  save() { this.riding = null; try { localStorage.setItem(STORE, JSON.stringify(this.serialize())) } catch { /* ignore */ } this.snapshot() }
  // undo / redo history
  snapshot() {
    const j = JSON.stringify(this.serialize())
    this.hist ||= []; this.future ||= []
    if (this.hist[this.hist.length - 1] === j) return
    this.hist.push(j); if (this.hist.length > 80) this.hist.shift(); this.future = []
  }
  undo() { if (!this.hist || this.hist.length < 2) return; this.future.push(this.hist.pop()); this.applyJSON(this.hist[this.hist.length - 1]) }
  redo() { if (!this.future || !this.future.length) return; const j = this.future.pop(); this.hist.push(j); this.applyJSON(j) }
  applyJSON(j) { this.load(JSON.parse(j)); try { localStorage.setItem(STORE, j) } catch { /* ignore */ } }
  // named layouts the user saved
  savedLayouts() { try { return JSON.parse(localStorage.getItem(SAVED) || '{}') } catch { return {} } }
  saveAs(name) { const all = this.savedLayouts(); all[name] = this.serialize(); localStorage.setItem(SAVED, JSON.stringify(all)) }
  deleteSaved(name) { const all = this.savedLayouts(); delete all[name]; localStorage.setItem(SAVED, JSON.stringify(all)) }
  // does the selected item overlap walls, cabinets or other furniture?
  // real footprint (W×D, rotated) — ignores drapes/leaves that hang over the edge
  footprint(it) {
    const c = Math.abs(Math.cos(it.rot)), sn = Math.abs(Math.sin(it.rot))
    const extra = it.type === 'bed' ? 0.12 : 0 // headboard behind the mattress
    const hw = (it.w * c + (it.d + extra) * sn) / 2, hd = (it.w * sn + (it.d + extra) * c) / 2
    return { x1: it.x - hw, x2: it.x + hw, z1: it.z - hd, z2: it.z + hd }
  }
  overlaps(it, staticColliders) {
    if (!it || CATALOG[it.type].noCollide || it.type === 'rug') return false
    const b = this.footprint(it), m = 0.015
    const hit = (c) => b.x1 + m < c.x2 && b.x2 - m > c.x1 && b.z1 + m < c.z2 && b.z2 - m > c.z1
    if (it.elev < 1.2 && staticColliders.some(hit)) return true
    const tucks = (a, o) => /chair/.test(a.type) && /dining|roundtable|desk/.test(o.type) // chairs slide under tables
    for (const o of this.items) {
      if (o === it || CATALOG[o.type].noCollide || o.type === 'rug' || Math.abs(o.elev - it.elev) > 0.3) continue
      if (tucks(it, o) || tucks(o, it)) continue
      if (hit(this.footprint(o))) return true
    }
    return false
  }

  load(list) { this.riding = null; for (const i of [...this.items]) this.group.remove(i.obj); this.items = []; for (const o of list) this.add(o.type, o); this.select(null); this.emit() }
  restore(fallback) {
    let list = null
    try { list = JSON.parse(localStorage.getItem(STORE) || 'null') } catch { list = null }
    // models are placed at their real size; older saves stored an over-scaled basket
    if (Array.isArray(list)) for (const o of list) if (o.type === 'basket' && o.h > 0.15) { o.h = CATALOG.basket.h; o.w = CATALOG.basket.w; o.d = CATALOG.basket.d }
    this.load(Array.isArray(list) ? list : fallback)
    this.snapshot()
  }
}
