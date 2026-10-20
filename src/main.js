import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { GroundedSkybox } from 'three/examples/jsm/objects/GroundedSkybox.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { N8AOPass } from 'n8ao'
import { bakeHours, loadBake, applyBake, applyFurniture, clearBake, exportBake } from './lightmap.js'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
import { WebGLPathTracer, DenoiseMaterial } from 'three-gpu-pathtracer'
import * as P from './plan.js'
import { makeMaterials, buildApartment } from './builder.js'
import { buildContext, GROUND } from './context.js'
import { CATALOG, setOakMaterial, withModel, STYLES, setTheme, theme, glowMats } from './furniture.js'
import { Planner, configurePlanner } from './planner.js'
import { isPrivate } from './store.js'
import { solarPosition, sunVector, northVector, setFacadeAzimuth } from './sun.js'
import { hydrateIcons, icon } from './icons.js'
import { RoomEnvironment as ThumbEnv } from 'three/examples/jsm/environments/RoomEnvironment.js'
hydrateIcons()
import { Avatar, setWalkArea } from './avatar.js'
import { footstep, unlockAudio } from './footsteps.js'
import { makeSunAnalyser, fmtTime, fmtDur } from './sunreport.js'

RectAreaLightUniformsLib.init()
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast
const $ = (id) => document.getElementById(id)
const host = $('viewport')
const isNarrow = () => innerWidth < 760
const DRAWER_W = 380
let PANEL = 0 // width of the open drawer on the right (0 when closed / on phones)
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
// apartment geometry comes from the spec (plan.js)
setFacadeAzimuth(P.FACADE_AZIMUTH)
setWalkArea(P.BOUNDS)
const BB = P.BOUNDS, CX = BB.cx, CZ = BB.cz, SCALE = Math.max(1, Math.max(BB.w, BB.d) / 8)
configurePlanner(P.ID, P.LIVING ? [(P.LIVING.rect[0] + P.LIVING.rect[2]) / 2, (P.LIVING.rect[1] + P.LIVING.rect[3]) / 2] : [CX, CZ])
// overview camera: from the window / balcony side, a little to the right
const FACING = (() => {
  const v = P.OPENINGS.filter((o) => o.kind === 'window' || o.kind === 'balconyDoor').reduce((a, o) => [a[0] + o.out[0], a[1] + o.out[1]], [0, 0])
  const L = Math.hypot(v[0], v[1]); return L > 0.01 ? [v[0] / L, v[1] / L] : [0, 1]
})()
const HOME_CAM = [CX + (FACING[0] * 7.9 + FACING[1] * 5.9) * SCALE, 10.4 * SCALE, CZ + (FACING[1] * 7.9 - FACING[0] * 5.9) * SCALE]

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
// One stable render resolution (changing it reallocates every buffer = a visible flash).
// Starts at a sensible level and only steps down — rarely, and remembered — if the GPU can't keep up.
const DPR_MAX = Math.min(devicePixelRatio, 2)
// new key: older versions could remember a very low value (0.75 = blocky picture)
const DPR_MIN = Math.min(devicePixelRatio, 1.25)
let dprMove = Math.max(DPR_MIN, Math.min(DPR_MAX, parseFloat(localStorage.getItem('apt-dpr2')) || Math.min(devicePixelRatio, 1.5)))
renderer.setPixelRatio(dprMove)
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
renderer.shadowMap.autoUpdate = false // only re-rendered when something changes
renderer.toneMapping = THREE.AgXToneMapping
renderer.toneMappingExposure = 1.0
host.appendChild(renderer.domElement)

const labelRenderer = new CSS2DRenderer()
labelRenderer.setSize(innerWidth, innerHeight)
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' })
host.appendChild(labelRenderer.domElement)

const scene = new THREE.Scene() // everything "real" (raster + path tracer)
const overlay = new THREE.Scene() // helpers drawn on top: labels, measurements, selection, cursor

const M = makeMaterials(renderer.capabilities.getMaxAnisotropy())
setOakMaterial(M.oak)
// metals & glossy surfaces reflect a neutral indoor room, not the outdoor sky (looked navy/black)
const pmrem = new THREE.PMREMGenerator(renderer)
const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.03).texture
const INDOOR_REFL = ['steel', 'steelDark', 'chrome', 'sinkSteel', 'fridgeSteel', 'mirror', 'porcelain', 'bathWall', 'splash', 'hob', 'blackGlass', 'ovenWindow', 'appliance', 'applianceGrey', 'washerGlass', 'drain', 'trim', 'amberGlass', 'ceramic', 'cabinet', 'counter', 'door']
for (const k of INDOOR_REFL) if (M[k]) { M[k].envMap = roomEnv; M[k].envMapIntensity = 0.8; M[k].needsUpdate = true }

// ------------------------------------------------------------------ cameras & controls
const persp = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.03, 500)
persp.position.set(...HOME_CAM)
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200)
ortho.up.set(0, 0, -1)
ortho.position.set(CX, 60, CZ)
ortho.lookAt(CX, 0, CZ)

const orbitP = new OrbitControls(persp, renderer.domElement)
orbitP.target.set(CX, 0.5, CZ - 0.25)
orbitP.enableDamping = true; orbitP.dampingFactor = 0.08
orbitP.maxPolarAngle = Math.PI * 0.49; orbitP.minDistance = 2; orbitP.maxDistance = 40
const orbitO = new OrbitControls(ortho, renderer.domElement)
orbitO.target.set(CX, 0, CZ)
orbitO.enableRotate = false; orbitO.screenSpacePanning = true
orbitO.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
orbitO.minZoom = 0.5; orbitO.maxZoom = 8
orbitO.enabled = false

// ------------------------------------------------------------------ raster pipeline (used while moving)
// Panini projection: shows a human-like ~120° view while keeping verticals straight and edges unstretched.
// The scene is rendered with a wide rectilinear camera, then each output pixel looks up its direction.
const PaniniShader = {
  uniforms: { tDiffuse: { value: null }, X: { value: 1 }, Y: { value: 1 }, tanH: { value: 1 }, tanV: { value: 1 }, texel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) }, sharp: { value: 0.0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float X, Y, tanH, tanV, sharp; uniform vec2 texel; varying vec2 vUv;
    void main(){
      vec2 p = (vUv * 2.0 - 1.0) * vec2(X, Y);
      float phi = 2.0 * atan(p.x * 0.5);
      float c = cos(phi);
      float h = p.y * (1.0 + c) * 0.5;
      vec2 r = vec2(tan(phi) / tanH, (h / c) / tanV);
      vec2 uv = r * 0.5 + 0.5;
      // contrast-adaptive sharpening: the warp magnifies the centre ~1.5×, so restore crisp edges
      vec3 c0 = texture2D(tDiffuse, uv).rgb;
      vec3 n = texture2D(tDiffuse, uv + vec2(0.0, texel.y)).rgb, s2 = texture2D(tDiffuse, uv - vec2(0.0, texel.y)).rgb;
      vec3 e = texture2D(tDiffuse, uv + vec2(texel.x, 0.0)).rgb, w = texture2D(tDiffuse, uv - vec2(texel.x, 0.0)).rgb;
      vec3 mn = min(c0, min(min(n, s2), min(e, w))), mx = max(c0, max(max(n, s2), max(e, w)));
      vec3 amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
      vec3 wgt = -amp * mix(0.06, 0.2, sharp); // gentle: crisp detail without re-sharpening stair-steps
      vec3 col = (c0 + (n + s2 + e + w) * wgt) / (1.0 + 4.0 * wgt);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
}
const proj = { panini: true, X: 1, Y: 1, tanH: 1, tanV: 1 }
function makeComposer(cam) {
  const rt = new THREE.WebGLRenderTarget(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio(), { type: THREE.HalfFloatType, samples: 0 })
  const c = new EffectComposer(renderer, rt)
  const ao = new N8AOPass(scene, cam, innerWidth, innerHeight)
  Object.assign(ao.configuration, { aoRadius: 0.5, distanceFalloff: 0.5, intensity: 4.5, aoSamples: 12, denoiseSamples: 6, denoiseRadius: 10, aoTones: 0, gammaCorrection: false, transparencyAware: true, halfRes: true, depthAwareUpsampling: true })
  const plain = new RenderPass(scene, cam); plain.enabled = false
  c.addPass(plain)
  c.addPass(ao)
  // glow around bright light sources (half-res → cheap)
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 3, innerHeight / 3), 0.35, 0.55, 0.92)
  c.addPass(bloom)
  // edge anti-aliasing (the AO pass re-renders the scene without MSAA, so smooth edges here, before the warp)
  const smaa = new SMAAPass(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio())
  c.addPass(smaa)
  const panini = new ShaderPass(PaniniShader); panini.enabled = false
  c.addPass(panini)
  c.addPass(new OutputPass())
  return { c, ao, plain, panini, bloom }
}
const compP = makeComposer(persp)
const compO = makeComposer(ortho)
setTimeout(() => updatePaniniTexel(), 0)

// ------------------------------------------------------------------ path tracer (photoreal when the view is still)
const pt = new WebGLPathTracer(renderer)
pt.bounces = 6
pt.transmissiveBounces = 4
pt.filterGlossyFactor = 1
pt.minSamples = 2
pt.renderDelay = 180
pt.fadeDuration = 350
pt.renderScale = Math.min(1, 1.1 / renderer.getPixelRatio())
pt.tiles.set(2, 2)
pt.rasterizeScene = true
pt.rasterizeSceneCallback = () => compP.c.render()
// edge-aware denoise on the way to the screen
const denoise = new DenoiseMaterial({ map: null, transparent: true, blending: THREE.NormalBlending })
denoise.uniforms.sigma.value = 5; denoise.uniforms.kSigma.value = 1.5; denoise.uniforms.threshold.value = 0.12
pt.renderToCanvasCallback = (target, r, quad) => {
  const orig = quad.material
  denoise.map = target.texture; denoise.opacity = orig.opacity
  quad.material = denoise
  const ac = r.autoClear; r.autoClear = false; quad.render(r); r.autoClear = ac
  quad.material = orig
}
let assetsLoaded = false
THREE.DefaultLoadingManager.onLoad = () => { assetsLoaded = true; markDirty(); setTimeout(() => prewarm(), 300) }

// ------------------------------------------------------------------ lights
const sun = new THREE.DirectionalLight(0xffffff, 3)
sun.castShadow = true
sun.shadow.mapSize.set(4096, 4096)
const SH = Math.max(6, Math.hypot(BB.w, BB.d) / 2 + 1)
Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 20, far: 75 }) // tight on the apartment → ~3 mm texels
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.015; sun.shadow.radius = 2
sun.target.position.set(CX, 0, CZ + 0.6)
scene.add(sun, sun.target)

// sky light through each opening (raster only — the path tracer gets it from the HDRI)
const windowLights = []
{
  for (const o of P.OPENINGS.filter((o) => o.kind === 'window' || o.kind === 'balconyDoor')) {
    // sky light through the opening: a wide soft spot just outside the glass, aimed into the room
    const y1 = o.kind === 'window' ? o.sill : 0.1, cy = (y1 + o.head) / 2, area = o.L * (o.head - y1)
    const p = P.toWorld(o.origin, o.theta, o.L / 2, 0.43), t = P.toWorld(o.origin, o.theta, o.L / 2, -3.02)
    const L = new THREE.SpotLight(0xeef3ff, 1, 9, Math.PI * 0.42, 1, 1.6)
    L.position.set(p[0], cy + 0.25, p[1]); L.target.position.set(t[0], 0.4, t[1])
    L.userData.area = area
    scene.add(L, L.target); windowLights.push(L)
  }
}

// fake bounce light: real interiors are lit mostly by light bouncing off the floor and walls.
// Two big soft area lights (floor → ceiling, back wall → windows) stand in for that GI.
// floor bounce: hemisphere lit only from below (warm), i.e. light coming up off the sunny floor
const bounceFloor = new THREE.HemisphereLight(0x000000, 0xffe2c4, 0)
// cheap ambient fill: warm from the floor, neutral from the ceiling
const fill = new THREE.HemisphereLight(0xfffaf2, 0xd9b48a, 0)
scene.add(bounceFloor, fill)

const bathLight = new THREE.PointLight(0xfff4e6, 0, 6, 2)
bathLight.position.set(0, -50, 0); bathLight.castShadow = false // placed by rebuild() from the builder's anchors
scene.add(bathLight)
const bathFill = { intensity: 0 } // (merged into bathLight)

const lamps = []
const WARM = 0xffd3a3
for (const L of P.LIGHTS.filter((l) => l.kind !== 'dome')) {
  const dy = L.kind === 'pendant' ? 0.62 : L.kind === 'dome' ? 0.12 : 0.08
  const pl = new THREE.PointLight(WARM, 0, 9, 2)
  pl.position.set(L.x, L.y - dy, L.z)
  pl.userData.base = L.kind === 'pendant' ? 12 : L.kind === 'dome' ? 9 : 7
  scene.add(pl); lamps.push(pl)
}
// under-cabinet LED strip → two small point lights over the worktop
const kitchenLight = new THREE.PointLight(0xffe2bd, 0, 2.2, 2)
kitchenLight.position.set(0, -50, 0); kitchenLight.userData.base = P.KITCHEN ? 2.2 : 0
scene.add(kitchenLight); lamps.push(kitchenLight)
const mirrorL = new THREE.PointLight(0xfff1de, 0, 3, 2)
mirrorL.position.set(0, -50, 0)
mirrorL.userData.base = 3
scene.add(mirrorL); lamps.push(mirrorL)

// ------------------------------------------------------------------ environment (real HDRI)
const env = { day: null, night: null, sunAngle: 0, skybox: null, current: null }
const hdr = new HDRLoader()
function hdrSunAngle(t) {
  // brightest texel in the upper hemisphere → horizontal angle of the HDRI's sun
  const { data, width, height } = t.image
  const half = data instanceof Uint16Array
  let best = -1, bx = 0
  for (let y = 0; y < height / 2; y++) for (let x = 0; x < width; x += 2) {
    const i = (y * width + x) * 4
    const r = half ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]
    const g = half ? THREE.DataUtils.fromHalfFloat(data[i + 1]) : data[i + 1]
    if (r + g > best) { best = r + g; bx = x }
  }
  const u = (bx + 0.5) / width
  return Math.atan2(-Math.sin(2 * Math.PI * u), -Math.cos(2 * Math.PI * u))
}
// the sun is a real DirectionalLight, so clip the HDRI's sun disk (kills path-tracing fireflies)
function clampHDR(t, maxLum) {
  const d = t.image.data, half = d instanceof Uint16Array
  const get = (i) => (half ? THREE.DataUtils.fromHalfFloat(d[i]) : d[i])
  const set = (i, v) => { d[i] = half ? THREE.DataUtils.toHalfFloat(v) : v }
  for (let i = 0; i < d.length; i += 4) {
    const r = get(i), g = get(i + 1), b = get(i + 2)
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (l > maxLum) { const k = maxLum / l; set(i, r * k); set(i + 1, g * k); set(i + 2, b * k) }
  }
  t.needsUpdate = true
}
hdr.load('/hdri/je_gray_park_2k.hdr', (t) => {
  t.mapping = THREE.EquirectangularReflectionMapping
  env.sunAngle = hdrSunAngle(t)
  clampHDR(t, 4)
  env.day = t
  const sky = new GroundedSkybox(t, 1.8, 90, 96)
  sky.position.y = GROUND + 1.8
  sky.name = 'skybox'
  env.skybox = sky
  scene.add(sky)
  updateSun(); markDirty()
})
hdr.load('/hdri/moonless_golf_1k.hdr', (t) => { t.mapping = THREE.EquirectangularReflectionMapping; env.night = t; updateSun() })

// ------------------------------------------------------------------ scene content
const context = buildContext(M)
scene.add(context.root)
const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: '#e7e5e1', roughness: 1 }))
ground.rotation.x = -Math.PI / 2; ground.position.set(CX, -0.27, CZ); ground.receiveShadow = true
scene.add(ground)

// pendant lamp over the dining table (Poly Haven model)
const pendant = new THREE.Group(); scene.add(pendant)
withModel('modern_ceiling_lamp_01', ({ scene: s, box }) => {
  const L = P.LIGHTS.find((l) => l.kind === 'pendant')
  if (!L) return
  s.position.set(L.x, L.y - box.max.y, L.z)
  s.traverse((o) => {
    if (o.isMesh && /globe|glass/i.test(o.material.name)) {
      o.material = o.material.clone(); o.material.emissive = new THREE.Color('#ffd7a6'); o.material.emissiveIntensity = 0
      o.material.userData.lampShade = true
    }
  })
  pendant.add(s); updateSun(); markDirty()
})

// floor-plan drawing overlay (exactly scaled)
const planOverlay = (() => {
  // the plan drawing itself: dark lines → blue ink, white paper → transparent
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, opacity: { value: 0.75 }, crop: { value: new THREE.Vector4(0, 0, 1, 1) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D map; uniform float opacity; uniform vec4 crop; varying vec2 vUv; void main(){ vec3 c = texture2D(map, crop.xy + vUv * crop.zw).rgb; float ink = 1.0 - dot(c, vec3(0.299, 0.587, 0.114)); gl_FragColor = vec4(0.08, 0.16, 0.55, smoothstep(0.12, 0.55, ink) * opacity); }',
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  })
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
  m.rotation.x = -Math.PI / 2
  m.visible = false
  const F = P.FLOORPLAN
  // full sheet normally; with the address hidden, only the part of the drawing around the flat
  const fit = () => {
    const t = mat.uniforms.map.value; if (!t) return
    const W = t.image.width / F.pxPerM, H = t.image.height / F.pxPerM, ox = F.origin[0] / F.pxPerM, oy = F.origin[1] / F.pxPerM
    let x1 = -ox, z1 = -oy, x2 = W - ox, z2 = H - oy
    if (isPrivate()) { x1 = Math.max(x1, BB.x1 - 1.2); z1 = Math.max(z1, BB.z1 - 1.2); x2 = Math.min(x2, BB.x2 + 1.2); z2 = Math.min(z2, BB.z2 + 1.2) }
    m.scale.set(x2 - x1, z2 - z1, 1); m.position.set((x1 + x2) / 2, 0.008, (z1 + z2) / 2)
    // plane UV v=1 is the top edge (smaller z); the texture is flipped, so v = 1 − (z + oy) / H
    mat.uniforms.crop.value.set((x1 + ox) / W, 1 - (z2 + oy) / H, (x2 - x1) / W, (z2 - z1) / H)
    markDirty()
  }
  if (F) new THREE.TextureLoader().load(F.src, (t) => { t.anisotropy = 8; mat.uniforms.map.value = t; fit() })
  addEventListener('hemma-private', fit)
  overlay.add(m)
  return m
})()

// room labels
const labelGroup = new THREE.Group(); overlay.add(labelGroup)
for (const r of P.ROOMS.filter((r) => r.label !== false && r.name)) {
  const [x1, z1, x2, z2] = r.labelRect || r.rect, area = (x2 - x1) * (z2 - z1)
  const el = document.createElement('div'); el.className = 'room-label'
  el.innerHTML = `<b>${r.name}</b><span>${area > 3 && r.type !== 'hall' ? Math.round(area * 10) / 10 + ' m², ' : ''}${(x2 - x1).toFixed(2)} × ${(z2 - z1).toFixed(2)} m${r.type !== 'balcony' ? ', ceiling ' + r.ceiling + ' m' : ''}</span>`
  const o = new CSS2DObject(el); o.position.set((x1 + x2) / 2, 0.05, (z1 + z2) / 2)
  labelGroup.add(o)
}

// walk cursor (ring on the floor, like a 3D tour)
const cursor = new THREE.Mesh(new THREE.RingGeometry(0.13, 0.17, 48), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthTest: false, toneMapped: false }))
cursor.rotation.x = -Math.PI / 2; cursor.visible = false; cursor.renderOrder = 20; cursor.userData.noPick = true
scene.add(cursor)

// ------------------------------------------------------------------ state
let apt = null
let doors = []
const state = {
  me: true, steps: true, view: localStorage.getItem('apt-viewmode') || 'first',
  mode: 'dollhouse', date: new Date(), hour: 15, lights: 'auto', cut: 2.45,
  labels: true, ao: true, photoreal: false, baked: localStorage.getItem('apt-baked') !== '0', curtains: P.SPEC.curtains !== false, tool: 'select', playing: false, lampsOn: false,
}

// ------------------------------------------------------------------ path tracer bookkeeping
var probeDirty = true
let ptDirty = true, ptDirtyAt = 0, ptReady = false
function markDirty() { probeDirty = true; ptDirty = true; ptDirtyAt = performance.now(); ptReady = false; invalidate(true) }
// render-on-demand: nothing is drawn while the view is idle
let renderFrames = 2, shadowDirty = true, lastMoveAt = 0, sharp = true
function invalidate(shadows = false) { renderFrames = Math.max(renderFrames, 2); if (shadows) shadowDirty = true }
const usePT = () => state.photoreal && state.mode !== 'plan'
function syncPathTracer() {
  // the grounded skybox is a raster-only trick; the path tracer samples the HDRI directly
  const sky = env.skybox, skyVis = sky && sky.visible
  if (sky) sky.visible = false
  pt.setScene(scene, persp)
  if (sky) sky.visible = skyVis
  ptDirty = false; ptReady = true
}

function rebuild() {
  const prev = new Map(doors.map((d) => [d.name, d.open]))
  clearBake(bake)
  if (apt) {
    scene.remove(apt.root)
    apt.root.traverse((o) => o.geometry && o.geometry.dispose())
  }
  const cut = state.mode === 'walk' ? Infinity : state.mode === 'plan' ? 1.3 : state.cut
  apt = buildApartment(M, { cut, ceilings: state.mode === 'walk', curtains: state.curtains })
  scene.add(apt.root)
  doors = apt.doors
  const A = apt.anchors, far = [0, -50, 0]
  bathLight.position.set(...(A.bath || far)); mirrorL.position.set(...(A.mirror || far)); kitchenLight.position.set(...(A.kitchenLed || far))
  for (const d of doors) {
    if (prev.has(d.name)) d.open = prev.get(d.name)
    d.target = d.open ? d.openAngle : 0
    d.angle = d.target
    d.group.rotation.y = d.base + d.angle
  }
  if (planner) planner.updateSelection()
  syncBake()
  markDirty()
}

// ------------------------------------------------------------------ baked light (Blender lightmap)
// used in walk mode while the clock, lamps and curtains match what was baked. There's one bake per baked
// hour; only the one for the clock is downloaded (about 11 MB each)
let bake = null, bakeTimer = 0, bakeList = []
const bakeCache = new Map()
const hhmm = (h) => `${String(h).padStart(2, '0')}:00`
function nearestBakeHour() { return bakeList.reduce((b, h) => (b == null || Math.abs(h - state.hour) < Math.abs(b - state.hour) ? h : b), null) }
function getBake(h) { if (!bakeCache.has(h)) bakeCache.set(h, loadBake(P.ID, h).catch(() => null)); return bakeCache.get(h) }
function useBake(b) { if (b && b !== bake) { clearBake(bake); bake = b; syncBake() } }
// swap to the bake for the clock once it's within half an hour of one
async function pickBake() {
  const h = nearestBakeHour()
  if (h == null || (bake && Math.abs(state.hour - h) > 0.5)) return
  const b = await getBake(h)
  if (h === nearestBakeHour()) useBake(b)
}
function bakeFits() {
  const j = bake && bake.json
  if (!j || !state.baked || state.mode !== 'walk' || usePT() || state.lampsOn || (state.mood && state.mood !== 'auto')) return false
  if (Math.abs(state.hour - j.hour) > 0.5 || state.curtains !== j.curtains) return false
  const d = new Date(state.date.getFullYear(), j.month - 1, j.day)
  return Math.abs(d - new Date(state.date.getFullYear(), state.date.getMonth(), state.date.getDate())) / 864e5 <= 45
}
function syncBake() {
  clearTimeout(bakeTimer)
  if (!bake || !apt || !planner) return
  if (bakeFits()) applyBake(bake, apt.root, planner); else clearBake(bake)
  updateBakeStatus()
  invalidate(true)
}
// one switch: on means everything the bake needs is set (Walk mode, its time and season, daylight, lamps off);
// changing any of those later switches it off again, and the switch shows that
function updateBakeStatus() {
  const st = $('bakeStatus'), chip = $('bakeChip'), tog = $('bakeToggle')
  if (!st) return
  chip.hidden = !bake; tog.hidden = !bake
  if (!bake) { st.textContent = 'Not baked yet. Press Re-bake lighting.'; return }
  const j = bake.json, hh = hhmm(j.hour), on = bakeFits()
  const all = bakeList.length > 1 ? bakeList.map(hhmm).join(', ').replace(/, ([^,]*)$/, ' and $1') : hh
  chip.setAttribute('aria-pressed', on); tog.setAttribute('aria-pressed', on)
  $('bakeChipState').textContent = on ? 'On' : 'Off'
  $('bakeToggleLabel').textContent = on ? 'Turn off baked light' : 'Turn on baked light'
  const why = !state.baked ? '' : state.mode !== 'walk' ? 'It only shows in Walk mode.'
    : Math.abs(state.hour - j.hour) > 0.5 ? 'The clock is between baked times.'
    : state.mood && state.mood !== 'auto' ? 'An evening mood is on.'
    : state.lampsOn ? 'The lamps are on.'
    : state.curtains !== j.curtains ? 'The curtains setting changed.'
    : usePT() ? 'Path tracing is on.' : 'The date is far from the bake.'
  st.textContent = on ? `Blender light for ${hh}. Move the furniture freely, it stays lit correctly.`
    : `Baked for ${all}. ${why} Turning it on sets everything up for you.`.replace('  ', ' ')
}
// turn the baked light on: set every condition it needs at once
async function enableBaked() {
  if (!bake) return
  useBake(await getBake(nearestBakeHour()))
  const j = bake.json
  state.baked = true; localStorage.setItem('apt-baked', '1')
  if (state.playing) $('play').onclick()
  if (state.photoreal) { state.photoreal = false; $('photoreal').checked = false; applyWalkFov() }
  if (state.mood && state.mood !== 'auto') { state.mood = 'auto'; $('mood').value = 'auto'; localStorage.setItem('apt-mood', 'auto') }
  if (state.lights === 'on') { state.lights = 'auto'; $('lights').value = 'auto' }
  if (Math.abs(state.hour - j.hour) > 0.5) { state.hour = j.hour; setTimeUI() }
  const today = new Date(state.date.getFullYear(), state.date.getMonth(), state.date.getDate()), want = new Date(state.date.getFullYear(), j.month - 1, j.day)
  if (Math.abs(want - today) / 864e5 > 45) { state.date = want; $('date').valueAsDate = new Date(Date.UTC(want.getFullYear(), want.getMonth(), want.getDate())) }
  if (state.curtains !== j.curtains) { state.curtains = j.curtains; $('curtains').checked = j.curtains; rebuild() }
  if (state.mode !== 'walk') setMode('walk')
  updateSun()
  if (state.lampsOn) { state.lights = 'off'; $('lights').value = 'off'; updateSun() }
  syncBake(); markDirty()
}
function toggleBaked() {
  if (bakeFits()) { state.baked = false; localStorage.setItem('apt-baked', '0'); syncBake() } else enableBaked()
}

const planner = new Planner(scene, overlay, () => apt.root)
const avatar = new Avatar(scene, overlay, () => { syncAvatarVisibility(); invalidate(true) })
function syncAvatarVisibility() {
  avatar.topView = state.mode === 'plan'; avatar.updateLabel(); avatar.group.visible = state.mode === 'walk' ? state.view === 'third' : state.me; avatar.label.visible = avatar.group.visible && state.labels && state.mode !== 'walk' }
// the door leaf blocks you in whatever position it's in (closed, open or half-way): a row of small boxes along it
function doorBoxes(d) {
  const rot = d.base + d.angle, dx = Math.cos(rot), dz = -Math.sin(rot), out = []
  for (let k = 0; k <= 6; k++) {
    const t = (k / 6) * d.len, x = d.pivot[0] + dx * t, z = d.pivot[1] + dz * t
    out.push({ x1: x - 0.06, x2: x + 0.06, z1: z - 0.06, z2: z + 0.06 })
  }
  return out
}
function blockers() { return [...apt.colliders, ...doors.flatMap(doorBoxes), ...furnColliders] }
rebuild()
SPOTS = makeSpots()
avatar.place(SPOTS.living.p[0] + 0.3, SPOTS.living.p[1] + 0.35, 2.1)
planner.restore(P.SAMPLE_FURNITURE)
// furniture reads the baked light probes wherever it stands: after a move only its materials are re-pointed
planner.onChange(() => { markDirty(); clearTimeout(bakeTimer); bakeTimer = setTimeout(() => { if (bake && bake.room.length) { applyFurniture(bake, planner); invalidate(true) } else syncBake() }, 150) })
bakeHours(P.ID).then((hs) => { bakeList = hs; return pickBake() }).catch((e) => console.warn('no baked light', e))

// outside / under-floor surfaces stay live-lit (they'd only waste lightmap resolution)
for (const k of ['slab', 'concrete', 'render']) if (M[k]) M[k].userData.noBake = true
// floor: subtle lacquer sheen from the neutral indoor room map
M.parquet.envMap = roomEnv; M.parquet.envMapIntensity = 0.5; M.parquet.needsUpdate = true
function captureProbe() {}

// ------------------------------------------------------------------ lighting moods & accent lights
const MOODS = {
  auto: { name: 'Auto (time of day)' },
  warm: { name: 'Cozy evening', ceiling: 0.35, tint: 0xffb46b, string: 1, candle: 0.6, screen: 0.15, rgb: 0.3, evening: true },
  cinema: { name: 'Movie night', ceiling: 0, tv: 1, screen: 1, string: 0.35, candle: 0, rgb: 0.8, evening: true },
  candles: { name: 'Candles', ceiling: 0, candle: 1, string: 0.5, screen: 0, rgb: 0, tv: 0, evening: true },
  bright: { name: 'Bright (all on)', ceiling: 1.3, tint: 0xfff1de, string: 1, candle: 0, screen: 0.4, rgb: 0.5 },
}
const moodLights = []
// one small light per glowing item (string lights, candles, monitor, PC) + a TV backlight strip behind every TV
// level a kind of accent light has in the current mood (0 = off → no light object at all)
function moodLevel(k) { const mood = MOODS[state.mood] || MOODS.auto; return mood[k] ?? (state.accent || 0) }
let moodKey = ''
function rebuildMoodLights() {
  moodKey = ['string', 'candle', 'screen', 'rgb', 'tv'].map((k) => (moodLevel(k) > 0.02 ? 1 : 0)).join('')
  for (const L of moodLights) scene.remove(L)
  moodLights.length = 0
  const mk = (kind, color, base, dist, pos) => { const L = new THREE.PointLight(color, 0, dist, 2); L.position.copy(pos); L.userData = { kind, base }; scene.add(L); moodLights.push(L) }
  const on = (k) => moodLevel(k) > 0.02
  for (const it of planner.items) {
    const src = it.obj.userData.lightSource
    if (src && !on(src.kind)) continue
    if (it.type === 'tv' && !on('tv')) continue
    const p = new THREE.Vector3(it.x, it.elev + it.h * 0.6, it.z)
    if (src?.kind === 'string') mk('string', src.color, 1.2 * Math.max(1, it.w), 3.2, p.setY(it.elev + it.h * 0.3))
    if (src?.kind === 'candle') { const L = mk('candle', src.color, 0.7, 2.4, p.setY(it.elev + 0.2)) }
    if (src?.kind === 'screen') mk('screen', src.color, 0.9, 2, p)
    if (src?.kind === 'rgb') mk('rgb', src.color, 0.6, 1.6, p)
    if (it.type === 'tv') { // LED strip glow on the wall behind the TV
      const back = new THREE.Vector3(-Math.sin(it.rot), 0, -Math.cos(it.rot)).multiplyScalar(0.22)
      mk('tv', 0x6a5cff, 2.4, 2.6, new THREE.Vector3(it.x, it.elev + it.h * 0.55, it.z).add(back))
    }
  }
  updateSun()
}
planner.onChange(() => { clearTimeout(rebuildMoodLights.t); rebuildMoodLights.t = setTimeout(rebuildMoodLights, 60) })

// ------------------------------------------------------------------ styles
function applyStyle(k, restyle = true) {
  setTheme(k); state.style = k; localStorage.setItem('apt-style', k)
  M.curtain.color.set(theme.curtain); M.curtain.sheenColor?.set(theme.curtain)
  document.querySelectorAll('#styles button').forEach((b) => b.classList.toggle('on', b.dataset.style === k))
  if (restyle) for (const it of planner.items) {
    if (it.type === 'sofa') it.color = theme.sofa
    if (it.type === 'armchair') it.color = theme.armchair
    if (it.type === 'rug') it.color = theme.rug
  }
  for (const it of planner.items) planner.rebuild(it)
  planner.save(); planner.emit(); markDirty()
  setTimeout(renderThumbs, 30)
}

// ------------------------------------------------------------------ sun / time / environment
const sunDir = new THREE.Vector3()
const warm = new THREE.Color('#ffb27a'), white = new THREE.Color('#fff6ea')
const bgDay = new THREE.Color('#e8eae5'), bgNight = new THREE.Color('#1b201d')
const compassLong = (a) => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(a / 45) % 8]
const compassName = (a) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(a / 45) % 8]
let dayFactor = 1, lastSunDay = '', sunA = null

function applyEnvironment() {
  const night = dayFactor < 0.08 && env.night
  const t = night ? env.night : env.day
  if (!t) return
  if (env.current !== t) { env.current = t; scene.environment = t; markDirty() }
  // rotate the HDRI so its sun sits where the real sun is
  const rot = night ? 0 : env.sunAngle - Math.atan2(sunDir.z, sunDir.x)
  scene.environmentRotation.set(0, rot, 0)
  scene.backgroundRotation.set(0, rot, 0)
  const walk = state.mode === 'walk'
  if (env.skybox) {
    env.skybox.material.map = t
    env.skybox.rotation.y = rot
    env.skybox.visible = walk
  }
  if (walk) scene.background = t
  if (usePT()) pt.updateEnvironment()
}

function updateSun() {
  const { elevation: el, azimuth: az } = solarPosition(state.date, state.hour)
  sunVector(el, az, sunDir)
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 45)
  const day = smooth(-6, 12, el)
  dayFactor = day
  const direct = smooth(-0.5, 5, el)
  const walk = state.mode === 'walk'
  sun.intensity = (walk ? 7.5 : 3.6) * direct
  sun.color.copy(warm).lerp(white, smooth(2, 30, el))
  // path-traced interiors: sky light comes through the window "portal" lights (directly sampled,
  // far less noise); the HDRI stays visible outside and in reflections at low strength
  scene.environmentIntensity = walk ? (usePT() ? 0.03 + 0.05 * day : 0.05 + 0.2 * day) : 0.15 + 0.5 * day
  scene.backgroundIntensity = 0.06 + 0.94 * day
  for (const L of windowLights) L.intensity = (walk ? 5.5 : 4) * L.userData.area * day
  const bounce = usePT() ? 0 : walk ? 1 : 0.35
  // bounce: mostly from the sunlit floor patches (direct), very little ambient → real contrast
  bounceFloor.intensity = bounce * (0.25 * day + 0.8 * direct)
  fill.intensity = bounce * (0.1 * day + 0.04)
  renderer.toneMappingExposure = walk ? 0.85 + 0.55 * day : 0.85 + 0.15 * day
  state.lampsOn = state.lights === 'on' || (state.lights === 'auto' && el < 5)
  // lighting mood: how much of the ceiling light is on, and which accent lights glow
  const mood = MOODS[state.mood] || MOODS.auto
  const night = 1 - day
  const ceil = state.lights === 'off' ? 0 : state.lights === 'on' ? 1 : mood.ceiling ?? (state.lampsOn ? 1 : 0)
  const eveningDim = 0.55 + 0.45 * day // lamps at night are pools of light, not floodlights
  for (const L of lamps) { L.intensity = L.userData.base * ceil * eveningDim; L.color.set(mood.tint || 0xffc48a) }
  state.lampsOn = ceil > 0.05
  state.accent = mood.accent ?? (state.lampsOn ? 0.6 : 0)
  { const key = ['string', 'candle', 'screen', 'rgb', 'tv'].map((k) => (moodLevel(k) > 0.02 ? 1 : 0)).join(''); if (key !== moodKey) { moodKey = key; setTimeout(rebuildMoodLights, 0) } }
  for (const L of moodLights) {
    const k = L.userData.kind, a = (mood[k] ?? state.accent) * (k === 'string' || k === 'candle' ? 0.6 + 0.4 * night : 1)
    L.userData.on = a; L.intensity = L.userData.base * a
  }
  for (const cp of [compP, compO]) { cp.bloom.strength = 0.32 * (1 - day) * (state.lampsOn || state.accent > 0 ? 1 : 0.4); cp.bloom.threshold = 4; cp.bloom.radius = 0.35; /* only real light sources (HDR > 4) glow, never lit walls */ cp.bloom.enabled = cp.bloom.strength > 0.05 /* off in daylight → no cost */ }
  for (const m of glowMats) { const k = m.userData.glow === 'flame' ? 'candle' : m.userData.glow === 'screen' ? 'screen' : m.userData.glow === 'rgb' ? 'rgb' : 'string'; m.emissiveIntensity = (mood[k] ?? state.accent) * (k === 'screen' ? 1.4 : 10) }
  // windowless bathroom: its ceiling light is always on when you're inside
  bathLight.intensity = state.lights === 'off' ? 0 : walk ? 17 : state.lampsOn ? 9 : 0
  bathFill.intensity = state.lights === 'off' ? 0 : walk ? 4 : 0
  const lit = ceil
  const refl = 0.15 + 0.75 * Math.max(day, lit * 0.55)
  for (const k of INDOOR_REFL) if (M[k]) M[k].envMapIntensity = refl * (/cabinet|counter|door|trim|bathWall|splash/.test(k) ? 0.45 : 1)
  M.lampShade.emissiveIntensity = 7 * lit
  M.led.emissiveIntensity = 9 * lit
  scene.traverse((o) => { if (o.material && o.material.userData && o.material.userData.lampShade) o.material.emissiveIntensity = 7 * lit })
  if (!walk) scene.background = bgNight.clone().lerp(bgDay, day)
  applyEnvironment()
  if (usePT()) { pt.updateLights(); pt.updateMaterials() }
  if (bakeList.length) pickBake()
  if (bake && bakeFits() !== bake.applied.length > 0) syncBake(); else updateBakeStatus()
  invalidate(true)
  const facing = Math.abs(((az - P.FACADE_AZIMUTH + 540) % 360) - 180) < 90 && el > 0
  if (sunA) { if (lastSunDay !== state.date.toDateString()) { lastSunDay = state.date.toDateString(); sunReport() } }
  const inLiving = el > 0.5 && sunA && sunA.nowLit(state.date, state.hour)
  $('sunInfo').textContent = inLiving ? 'Sun is shining in' : el > 0 ? `Sun in the ${compassLong(az)}${facing ? ', on the window side' : ''}` : 'After sunset'
  $('sunChipNote').textContent = inLiving ? 'Sun inside' : el > 0 ? '' : 'Night'
  $('sunChip').classList.toggle('lit', !!inLiving)
}

function setTimeUI() {
  const h = Math.floor(state.hour), m = Math.round((state.hour - h) * 60)
  $('timeLabel').textContent = $('sunChipTime').textContent = `${String(h).padStart(2, '0')}:${String(m === 60 ? 0 : m).padStart(2, '0')}`
  $('time').value = state.hour
}

// ------------------------------------------------------------------ sunlight report
// analysis uses the full building (all walls + ceiling), independent of the dollhouse cut
const sunApt = buildApartment(M, { cut: Infinity, ceilings: true, curtains: false })
sunApt.root.updateMatrixWorld(true); context.root.updateMatrixWorld(true)
sunA = makeSunAnalyser([sunApt.root, context.root], { living: P.LIVING?.rect, balcony: (P.ROOMS.find((r) => r.type === 'balcony') || P.BALCONY)?.rect })
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
let monthly = null, sunTimer = 0
function sunReport() {
  clearTimeout(sunTimer)
  sunTimer = setTimeout(() => {
    const d = state.date
    const L = sunA.living(d), B = sunA.balcony(d)
    const span = (r) => (r.mins ? `<b>${fmtTime(r.first)}–${fmtTime(r.last + 10)}</b>, ${fmtDur(r.mins)}` : '<b>no direct sun</b>')
    $('sunDate').textContent = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    $('sunReport').innerHTML = `Living room: ${span(L)}<br>Balcony: ${span(B)}`
    if (!monthly || monthly.year !== d.getFullYear()) {
      monthly = { year: d.getFullYear(), v: MONTHS.map((_, m) => sunA.living(new Date(d.getFullYear(), m, 15))) }
    }
    const max = Math.max(...monthly.v.map((r) => r.mins), 60)
    const cur = d.getMonth()
    $('sunChart').innerHTML = monthly.v.map((r, m) =>
      `<div class="bar${m === cur ? ' cur' : ''}" data-m="${m}">${m === cur ? `<span class="v">${(r.mins / 60).toFixed(1)}h</span>` : ''}<div class="fill" style="height:${Math.max(1, (r.mins / max) * 46)}px"></div><span class="m">${MONTHS[m]}</span></div>`).join('')
  }, 120)
}
$('sunChart').addEventListener('pointermove', (e) => {
  const b = e.target.closest('.bar'), tip = $('sunTip')
  if (!b || !monthly) { tip.classList.add('hidden'); return }
  const m = +b.dataset.m, r = monthly.v[m]
  tip.innerHTML = `${MONTH_NAMES[m]} 15: ${r.mins ? `${fmtTime(r.first)}–${fmtTime(r.last + 10)}, ${fmtDur(r.mins)}` : 'no direct sun'}`
  tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY - 30 + 'px'; tip.classList.remove('hidden')
})
$('sunChart').addEventListener('pointerleave', () => $('sunTip').classList.add('hidden'))
$('sunChart').addEventListener('click', (e) => {
  const b = e.target.closest('.bar'); if (!b) return
  state.date = new Date(state.date.getFullYear(), +b.dataset.m, 15)
  dateEl.valueAsDate = new Date(Date.UTC(state.date.getFullYear(), +b.dataset.m, 15)); updateSun()
})

// ------------------------------------------------------------------ modes
const hints = {
  dollhouse: [['Drag', 'to spin'], ['Scroll', 'to zoom'], ['Drag furniture', 'to move it']],
  plan: [['Drag', 'to move around'], ['Scroll', 'to zoom'], ['Drag furniture', 'to move it']],
  walk: [['Drag', 'to look'], ['Click the floor', 'to walk there'], ['Walk into a door', 'to open it']],
  measure: [['Click two points', 'to measure'], ['Shift', 'keeps it straight'], ['Esc', 'to stop']],
  place: [['Click the floor', 'to put it down'], ['Scroll', 'to turn it'], ['Esc', 'to cancel']],
}
const isTouch = matchMedia('(pointer: coarse)').matches
if (isTouch) Object.assign(hints, {
  walk: [['Drag', 'to look'], ['Tap the floor', 'to walk there'], ['Pinch', 'to widen the view']],
  dollhouse: [['Drag', 'to spin'], ['Two fingers', 'to pan and zoom']],
  plan: [['Drag', 'to pan'], ['Pinch', 'to zoom']],
})
// shown for a few seconds after each change, then it fades
let hintTimer = 0
function showHint(list) {
  const el = $('hint')
  el.innerHTML = list.map(([a, b]) => `<span><b>${a}</b> ${b}</span>`).join('')
  el.classList.remove('fade'); clearTimeout(hintTimer)
  if (list !== hints.place && list !== hints.measure) hintTimer = setTimeout(() => el.classList.add('fade'), 6000)
}
function updateHint() { showHint(state.tool === 'measure' && state.mode !== 'walk' ? hints.measure : hints[state.mode]) }

let panelOff = PANEL // animated towards PANEL so the view glides instead of jumping
function applyViewOffset() {
  const off = state.mode === 'walk' ? 0 : panelOff / 2
  if (off) { // drawer on the right: keep the apartment centred in the space that's left
    persp.setViewOffset(innerWidth, innerHeight, off, 0, innerWidth, innerHeight)
    ortho.setViewOffset(innerWidth, innerHeight, off, 0, innerWidth, innerHeight)
  } else { persp.clearViewOffset(); ortho.clearViewOffset() }
}

function fitOrtho() {
  const aspect = innerWidth / innerHeight, hh = 5.4 * SCALE
  ortho.left = -hh * aspect; ortho.right = hh * aspect; ortho.top = hh; ortho.bottom = -hh
  ortho.updateProjectionMatrix()
}

function setMode(mode) {
  if (mode === state.mode) return
  const was = state.mode
  state.mode = mode
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode))
  if (was === 'walk') { avatar.place(player.x, player.z, state.view === 'third' ? avatar.heading : look.yaw + Math.PI); avatar.setOpacity(1) }
  if (was === 'walk') { persp.fov = 40; persp.position.set(...HOME_CAM); orbitP.target.set(CX, 0.5, CZ - 0.25); persp.lookAt(orbitP.target) }
  orbitP.enabled = mode === 'dollhouse'
  orbitO.enabled = mode === 'plan'
  context.root.visible = mode === 'walk'
  ground.visible = mode !== 'walk'
  if (mode === 'walk') {
    planner.select(null)
    if (was !== 'walk') {
      player.set(avatar.position.x, 0, avatar.position.z)
      look.yaw = avatar.heading + Math.PI; look.pitch = state.view === 'third' ? -0.18 : -0.08; walkTarget = null
      if (state.view === 'third') { look.yaw = roomiestYaw(look.yaw); avatar.place(player.x, player.z, look.yaw + Math.PI) }
      camDist = 1.7
      placeWalkCamera()
    }
  }
  persp.updateProjectionMatrix()
  applyWalkFov()
  $('cut').disabled = mode !== 'dollhouse'
  document.body.classList.toggle('walking', mode === 'walk')
  syncAvatarVisibility()
  cursor.visible = false
  renderer.domElement.style.cursor = mode === 'walk' ? 'grab' : ''
  applyViewOffset()
  rebuild()
  updateSun(); updateHint(); updateLabels()
}

function updateLabels() { labelGroup.visible = state.labels && state.mode !== 'walk' }

// walk-to spots: from the spec if given, otherwise derived from the rooms, kitchen and doors
var SPOTS
function makeSpots() {
  const SPOT_ICON = { hall: 'door', entry: 'door', kitchen: 'cooking-pot', living: 'couch', bedroom: 'bed', bath: 'bathtub', balcony: 'plant', door: 'key', room: 'couch' }
  const free = (x, z, r = 0.38) => !apt.colliders.some((c) => x > c.x1 - r && x < c.x2 + r && z > c.z1 - r && z < c.z2 + r)
  const best = (rect, score, inset = 0.45) => {
    let bp = null, bs = -Infinity
    for (let x = rect[0] + inset; x <= rect[2] - inset + 1e-6; x += 0.1) for (let z = rect[1] + inset; z <= rect[3] - inset + 1e-6; z += 0.1) {
      if (!free(x, z)) continue
      const s = score(x, z); if (s > bs) { bs = s; bp = [x, z] }
    }
    return bp || [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2]
  }
  const center = (r) => [(r.rect[0] + r.rect[2]) / 2, (r.rect[1] + r.rect[3]) / 2]
  const out = {}, given = P.SPEC.spots || {}
  const exterior = P.OPENINGS.filter((o) => o.kind === 'window' || o.kind === 'balconyDoor')
  const windowsOf = (r) => exterior.filter((o) => { const p = P.toWorld(o.origin, o.theta, o.L / 2, -0.15); return P.roomAt(p[0], p[1]) === null ? false : P.roomAt(p[0], p[1]).id === r.id })
  const living = P.LIVING
  for (const r of P.INDOOR_ROOMS) {
    if (r.label === false) continue
    const key = out[r.type] ? r.id : r.type === 'entry' ? 'hall' : r.type
    const c = center(r)
    if (r.type === 'bath') {
      const d = P.DOORS.find((o) => { const a = P.toWorld(o.origin, o.theta, o.L / 2, -0.15), b = P.toWorld(o.origin, o.theta, o.L / 2, o.T + 0.15); return [a, b].some((p) => P.roomAt(p[0], p[1])?.id === r.id) })
      const dc = d ? d.center : c
      const p = best(r.rect, (x, z) => -Math.hypot(x - dc[0], z - dc[1]), 0.3)
      const corners = [[r.rect[0], r.rect[1]], [r.rect[2], r.rect[1]], [r.rect[0], r.rect[3]], [r.rect[2], r.rect[3]]].sort((a, b) => Math.hypot(b[0] - p[0], b[1] - p[1]) - Math.hypot(a[0] - p[0], a[1] - p[1]))
      out[key] = { p, look: [corners[0][0] * 0.8 + c[0] * 0.2, 1.0, corners[0][1] * 0.8 + c[1] * 0.2], label: r.name || 'Bathroom', icon: 'bathtub' }
      continue
    }
    const wins = windowsOf(r)
    if (r.type === 'hall' || r.type === 'entry') {
      const p = best(r.rect, (x, z) => -Math.hypot(x - c[0], z - c[1]))
      const lc = living ? center(living) : c
      out[key] = { p, look: [lc[0], 1.4, lc[1] + (lc[1] > p[1] ? 1 : -1) * 0.8], label: r.name || 'Hall', icon: 'door' }
      continue
    }
    const tgt = wins.length ? wins.reduce((a, o) => [a[0] + o.center[0] / wins.length, a[1] + o.center[1] / wins.length], [0, 0]) : c
    const p = best(r.rect, (x, z) => Math.hypot(x - tgt[0], z - tgt[1]) - 0.6 * Math.hypot(x - c[0], z - c[1]))
    out[key] = { p, look: [tgt[0], 1.1, tgt[1]], label: r.name || 'Room', icon: SPOT_ICON[r.type] || 'couch' }
  }
  if (P.KITCHEN) {
    const K = P.KITCHEN, th = P.fixtureTheta(K.n), run = K.items.reduce((a, i) => a + i.w, 0)
    const r = P.roomAt(...P.toWorld([K.x, K.z], th, run / 2, 1))
    let p = P.toWorld([K.x, K.z], th, run / 2, 2.0)
    if (r) { p = [Math.min(Math.max(p[0], r.rect[0] + 0.45), r.rect[2] - 0.45), Math.min(Math.max(p[1], r.rect[1] + 0.45), r.rect[3] - 0.45)]; if (!free(p[0], p[1])) p = best(r.rect, (x, z) => -Math.hypot(x - p[0], z - p[1])) }
    const l = P.toWorld([K.x, K.z], th, run / 2 + 0.3, 0.1)
    out.kitchen = { p, look: [l[0], 1.1, l[1]], label: 'Kitchen', icon: 'cooking-pot' }
  }
  const bal = P.ROOMS.find((r) => r.type === 'balcony')
  if (bal && P.BALCONY) {
    const c = center(bal), o = P.BALCONY.out
    out.balcony = { p: c, look: [c[0] + o[0] * 10, 0.9, c[1] + o[1] * 10], label: bal.name || 'Balcony', icon: 'plant' }
  }
  if (P.ENTRANCE) {
    const e = P.ENTRANCE, o = e.out
    out.door = { p: [e.center[0] + o[0] * 0.95, e.center[1] + o[1] * 0.95], look: [e.center[0] - o[0] * 3.5, 1.45, e.center[1] - o[1] * 3.5], label: 'Front door', icon: 'key' }
  }
  for (const [k, v] of Object.entries(given)) out[k] = { ...out[k], ...v }
  if (!out.living) out.living = Object.values(out)[0] || { p: [CX, CZ], look: [CX, 1.2, CZ + 2] }
  // buttons
  const el = $('spots')
  if (el) {
    el.innerHTML = ''
    const order = ['hall', 'kitchen', 'living', 'bedroom', 'bath', 'balcony', 'door']
    for (const k of Object.keys(out).sort((a, b) => (order.indexOf(a) + 1 || 50) - (order.indexOf(b) + 1 || 50))) {
      const b = document.createElement('button'); b.dataset.spot = k
      b.innerHTML = `${icon(out[k].icon || SPOT_ICON[k] || 'couch')} ${out[k].label || k}`
      el.appendChild(b)
    }
  }
  return out
}
// eye height = body height − ~11 cm; horizontal field of view is what the screen shows side to side
// eye height ≈ 93.5 % of stature (anthropometric median); HFOV = horizontal field of view
let EYE = 1.61, HFOV = 120
const DEG = Math.PI / 180
function applyWalkFov() {
  const screenAspect = innerWidth / innerHeight
  const usePanini = state.mode === 'walk' && proj.panini && !usePT()
  for (const cp of [compP, compO]) cp.panini.enabled = usePanini
  if (state.mode !== 'walk') { persp.aspect = screenAspect; persp.updateProjectionMatrix(); return }
  const hf = usePanini ? HFOV : Math.min(HFOV, 100)
  if (usePanini) {
    const pm = (hf / 2) * DEG, cm = Math.cos(pm)
    proj.X = 2 * Math.tan(pm / 2); proj.Y = proj.X / screenAspect
    proj.tanH = Math.tan(pm); proj.tanV = (proj.Y * (1 + cm)) / (2 * cm)
    for (const cp of [compP, compO]) { const u = cp.panini.uniforms; u.X.value = proj.X; u.Y.value = proj.Y; u.tanH.value = proj.tanH; u.tanV.value = proj.tanV }
    persp.aspect = proj.tanH / proj.tanV
    persp.fov = 2 * Math.atan(proj.tanV) / DEG
  } else {
    persp.aspect = screenAspect
    persp.fov = 2 * Math.atan(Math.tan((hf / 2) * DEG) / screenAspect) / DEG
  }
  persp.updateProjectionMatrix(); invalidate()
}
// screen NDC → the rectilinear NDC of the wide render camera (for picking through the panini view)
function paniniToRect(v) {
  if (!(state.mode === 'walk' && proj.panini && !usePT())) return v
  const x = v.x * proj.X, y = v.y * proj.Y
  const phi = 2 * Math.atan(x / 2), c = Math.cos(phi), h = (y * (1 + c)) / 2
  v.set(Math.tan(phi) / proj.tanH, h / c / proj.tanV)
  return v
}
const look = { yaw: 0, pitch: 0 }
const euler = new THREE.Euler(0, 0, 0, 'YXZ')
function syncLookFromCamera() { euler.setFromQuaternion(persp.quaternion, 'YXZ'); look.yaw = euler.y; look.pitch = euler.x }
function applyLook() { euler.set(look.pitch, look.yaw, 0, 'YXZ'); persp.quaternion.setFromEuler(euler) }
let walkTarget = null
function jumpTo(name, switchMode = true) {
  if (switchMode && state.mode !== 'walk') setMode('walk')
  const s = SPOTS[name]
  player.set(s.p[0], 0, s.p[1])
  persp.position.set(s.p[0], EYE, s.p[1])
  persp.lookAt(s.look[0], s.look[1], s.look[2])
  syncLookFromCamera()
  if (third()) { look.pitch = -0.18; look.yaw = roomiestYaw(look.yaw) }
  avatar.place(s.p[0], s.p[1], look.yaw + Math.PI)
  walkTarget = null; camDist = 1.7
  placeWalkCamera()
  if (name === 'door' || name === 'balcony') {
    const d = doors.find((d) => d.name === (name === 'door' ? 'Ytterdörr' : 'Balkongdörr'))
    if (d && !d.open) toggleDoor(d)
  }
}

function toggleDoor(d) { d.open = !d.open; d.target = d.open ? d.openAngle : 0; d.moving = true }

// ------------------------------------------------------------------ walk movement & collision
const keys = new Set()
let furnColliders = []
planner.onChange(() => { furnColliders = planner.colliders() })

function collide(p, r) {
  const list = [...apt.colliders, ...doors.flatMap(doorBoxes), ...furnColliders]
  for (let it = 0; it < 3; it++) {
    for (const b of list) {
      const cx = Math.min(Math.max(p.x, b.x1), b.x2), cz = Math.min(Math.max(p.z, b.z1), b.z2)
      const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz
      if (d2 >= r * r) continue
      if (d2 > 1e-10) { const d = Math.sqrt(d2); p.x += (dx / d) * (r - d); p.z += (dz / d) * (r - d) }
      else {
        const pen = [p.x - b.x1 + r, b.x2 - p.x + r, p.z - b.z1 + r, b.z2 - p.z + r]
        const i = pen.indexOf(Math.min(...pen))
        if (i === 0) p.x -= pen[0]; else if (i === 1) p.x += pen[1]; else if (i === 2) p.z -= pen[2]; else p.z += pen[3]
      }
    }
  }
}

// head bob: ~2.5 cm vertical per step (the head peaks mid-stance), plus a tiny side sway per stride
const bob = { dist: 0, amp: 0, lastStep: 0 }
function bobOffset() {
  if (!state.steps) return 0
  const stepLen = 0.415 * (EYE / 0.935), ph = (bob.dist / stepLen) * Math.PI
  return (Math.abs(Math.sin(ph)) - 0.6) * 0.025 * bob.amp
}
function surfaceAt(x, z) {
  const r = P.roomAt(x, z, 0.02)
  if (r) return r.type === 'balcony' || r.floor === 'tile' || r.floor === 'bath' ? 'tile' : 'wood'
  const o = P.OPENINGS.find((o) => x >= o.x1 - 0.02 && x <= o.x2 + 0.02 && z >= o.z1 - 0.02 && z <= o.z2 + 0.02)
  if (o && o.kind === 'door') { const a = P.toWorld(o.origin, o.theta, o.L / 2, -0.2), b = P.toWorld(o.origin, o.theta, o.L / 2, o.T + 0.2); if ([a, b].some((p) => /tile|bath/.test(P.roomAt(p[0], p[1])?.floor || ''))) return 'tile' }
  if (P.BALCONY && x > P.BALCONY.rect[0] && x < P.BALCONY.rect[2] && z > P.BALCONY.rect[1] && z < P.BALCONY.rect[3]) return 'tile'
  return o && o.kind === 'entrance' ? 'tile' : 'wood'
}
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), vel = new THREE.Vector3(), want = new THREE.Vector3()
// the walker: your feet position on the floor (camera eye in 1st person, character in 3rd person)
const player = new THREE.Vector3(SPOTS.living.p[0], 0, SPOTS.living.p[1])
const third = () => state.view === 'third' && state.mode === 'walk'
const camRay = new THREE.Raycaster()
let camDist = 1.6
// body radius incl. arm swing (shoulders ≈ 45 cm wide) so you don't clip into walls and cabinets
const BODY_R = 0.27
function moving2() { return vel.lengthSq() > 0.04 || avatar.path.length > 0 }
function walk(dt) {
  let mx = 0, mz = 0, turn = 0
  if (keys.has('KeyW') || keys.has('ArrowUp')) mz += 1
  if (keys.has('KeyS') || keys.has('ArrowDown')) mz -= 1
  if (keys.has('KeyA')) mx -= 1
  if (keys.has('KeyD')) mx += 1
  if (keys.has('ArrowLeft') || keys.has('KeyQ')) turn += 1
  if (keys.has('ArrowRight')) turn -= 1
  if (turn) look.yaw += turn * 1.8 * dt
  const ns = avatar.ready ? avatar.naturalSpeed : 1.17
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1.5 : 1) * ns
  fwd.set(-Math.sin(look.yaw), 0, -Math.cos(look.yaw))
  right.set(-fwd.z, 0, fwd.x)
  want.set(0, 0, 0)
  const bx = player.x, bz = player.z
  if (mx || mz) { walkTarget = null; avatar.path = []; want.addScaledVector(fwd, mz).addScaledVector(right, mx).normalize().multiplyScalar(speed) }
  if (avatar.path.length) {
    // following a clicked path (character walks, the camera follows)
    player.x = avatar.position.x; player.z = avatar.position.z
    vel.set(player.x - bx, 0, player.z - bz).divideScalar(Math.max(dt, 1e-3))
  } else {
    if (!(mx || mz) && walkTarget) {
      const dx = walkTarget.x - player.x, dz = walkTarget.z - player.z, dist = Math.hypot(dx, dz)
      if (dist < 0.04) walkTarget = null
      else want.set(dx / dist, 0, dz / dist).multiplyScalar(Math.min(1.6, dist * 3))
    }
    vel.lerp(want, Math.min(1, dt * (want.lengthSq() > vel.lengthSq() ? 4 : 7))) // ~0.4 s to get going, quicker stop
    if (vel.lengthSq() > 1e-6) {
      player.addScaledVector(vel, dt)
      collide(player, third() ? BODY_R : 0.2)
      if (walkTarget && Math.hypot(player.x - bx, player.z - bz) < vel.length() * dt * 0.2) walkTarget = null // blocked
    } else vel.set(0, 0, 0)
    avatar.drive(player.x, player.z, vel.x, vel.z)
  }
  // walking into a closed door opens it
  if (moving2(bx, bz)) for (const d of doors) {
    if (d.open || d.moving) continue
    const cx = (d.collider.x1 + d.collider.x2) / 2, cz = (d.collider.z1 + d.collider.z2) / 2
    if (Math.hypot(player.x - cx, player.z - cz) < 0.62) { const toD = Math.atan2(cx - player.x, cz - player.z), mv = Math.atan2(vel.x, vel.z); if (Math.abs(Math.atan2(Math.sin(toD - mv), Math.cos(toD - mv))) < 1.0) toggleDoor(d) }
  }
  // steps: head bob (1st person) + footstep sounds
  const moved = Math.hypot(player.x - bx, player.z - bz)
  const stepLen = 0.415 * (EYE / 0.935) // step length ≈ 41.5 % of stature
  if (moved > 1e-5) {
    bob.dist += moved
    bob.amp += (Math.min(1, (moved / Math.max(dt, 1e-3)) / 1.2) - bob.amp) * Math.min(1, dt * 6)
    const stepNo = Math.floor(bob.dist / stepLen)
    if (stepNo !== bob.lastStep) { bob.lastStep = stepNo; if (state.steps) footstep(surfaceAt(player.x, player.z), (third() ? 0.22 : 0.35) + 0.25 * bob.amp) }
  } else bob.amp *= Math.max(0, 1 - dt * 8)
  placeWalkCamera(dt)
}

// pick a look direction whose over-the-shoulder camera has the most free space behind you
function roomiestYaw(pref) {
  const head = new THREE.Vector3(player.x, avatar.height * 0.9, player.z)
  let best = pref, bestScore = -1
  for (let k = 0; k < 16; k++) {
    const yaw = pref + (k * Math.PI) / 8
    const freeAt = (dx, dz, far) => {
      camRay.set(head, new THREE.Vector3(dx, dx === 0 && dz === 0 ? 0 : 0.15, dz).normalize()); camRay.far = far
      const hit = camRay.intersectObjects([apt.root, planner.group], true).find(solidHit)
      return hit ? hit.distance : far
    }
    // room for the camera behind you AND a clear view ahead of you
    const back = Math.min(freeAt(Math.sin(yaw), Math.cos(yaw), 2), 1.9)
    const ahead = freeAt(-Math.sin(yaw), -Math.cos(yaw), 6)
    const free = back + 0.5 * Math.min(ahead, 5) - Math.min(k, 16 - k) * 0.02
    if (free > bestScore) { bestScore = free; best = yaw }
  }
  return best
}
// camera: your eyes (1st person) or over your shoulder (3rd person), never through walls
function placeWalkCamera(dt = 0.016) {
  if (!third()) {
    persp.position.set(player.x, EYE + bobOffset(), player.z)
    applyLook()
    return
  }
  look.pitch = Math.max(-1.1, Math.min(0.55, look.pitch))
  const head = new THREE.Vector3(player.x, avatar.height * 0.9, player.z)
  const dir = new THREE.Vector3(Math.sin(look.yaw) * Math.cos(look.pitch), -Math.sin(look.pitch), Math.cos(look.yaw) * Math.cos(look.pitch)) // from head back toward camera
  const side = new THREE.Vector3(Math.cos(look.yaw), 0, -Math.sin(look.yaw)).multiplyScalar(0.22) // over the right shoulder
  const want = 1.7
  camRay.set(head, dir.clone().add(side.clone().multiplyScalar(1 / want)).normalize()); camRay.far = want + 0.3
  const hit = camRay.intersectObjects([apt.root], true).find(solidHit)
  const target = hit ? Math.max(0.2, hit.distance - 0.18) : want
  camDist += (target - camDist) * (target < camDist ? 1 : Math.min(1, dt * 4)) // pull in instantly, ease back out
  const k = camDist / want
  persp.position.copy(head).addScaledVector(dir, camDist).addScaledVector(side, k)
  applyLook()
  // too close to the body (back against a wall): never show the inside of a head — hide the character
  // and look from your eyes until there's room again
  const tooClose = camDist < 0.75
  avatar.group.visible = !tooClose && state.view === 'third'
  if (tooClose) { persp.position.set(player.x, EYE, player.z); applyLook() }
  // (no see-through fade: transparent skin exposed the eyeballs and inner mouth)
}

// ------------------------------------------------------------------ picking
const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()
const activeCam = () => (state.mode === 'plan' ? ortho : persp)
function rayFrom(e) {
  const r = renderer.domElement.getBoundingClientRect()
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  raycaster.setFromCamera(paniniToRect(ndc), activeCam())
  return raycaster
}
const solidHit = (h) => {
  let o = h.object
  if (o.isLine || o.userData.noPick || o.name === 'skybox') return false
  const m = o.material
  if (m && !Array.isArray(m) && m.transparent && m.opacity < 0.5) return false
  while (o) { if (!o.visible) return false; o = o.parent }
  return true
}
function pick(e, objs) { return rayFrom(e).intersectObjects(objs, true).filter(solidHit) }
function planePoint(e, y) {
  const pl = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y)
  const out = new THREE.Vector3()
  return rayFrom(e).ray.intersectPlane(pl, out) ? out : null
}
function walkPick(e) {
  const h = pick(e, [apt.root, planner.group, context.root])
  if (!h.length) return null
  const hit = h[0]
  const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3()
  return { hit, floor: n.y > 0.7 && hit.point.y < 0.3, door: hit.object.userData.door }
}

// ------------------------------------------------------------------ measuring
const measureGroup = new THREE.Group(); overlay.add(measureGroup)
const mMat = new THREE.LineBasicMaterial({ color: 0x1f6feb, depthTest: false, transparent: true })
const dotGeo = new THREE.SphereGeometry(0.025, 12, 8)
const dotMat = new THREE.MeshBasicMaterial({ color: 0x1f6feb, depthTest: false, transparent: true })
let mStart = null, rubber = null
function makeMeasure(a, b) {
  const g = new THREE.Group()
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), mMat)
  g.add(line)
  for (const p of [a, b]) { const d = new THREE.Mesh(dotGeo, dotMat); d.position.copy(p); g.add(d) }
  const el = document.createElement('div'); el.className = 'measure-label'
  const lab = new CSS2DObject(el); lab.position.copy(a).lerp(b, 0.5); g.add(lab)
  g.userData = { line, el, lab }
  setMeasure(g, a, b)
  return g
}
function dropMeasure(g) { if (!g) return; g.userData.el?.remove(); measureGroup.remove(g) }
function setMeasure(g, a, b) {
  const { line, el, lab } = g.userData
  line.geometry.setFromPoints([a, b])
  g.children[1].position.copy(a); g.children[2].position.copy(b)
  lab.position.copy(a).lerp(b, 0.5)
  const d = a.distanceTo(b)
  el.textContent = d >= 1 ? `${d.toFixed(2)} m` : `${Math.round(d * 100)} cm`
}
function measurePoint(e) {
  let p
  if (state.mode === 'plan') p = planePoint(e, 0.01)
  else { const h = pick(e, [apt.root, planner.group]); p = h.length ? h[0].point.clone() : planePoint(e, 0) }
  if (p && mStart && e.shiftKey) {
    const d = p.clone().sub(mStart), ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z)
    if (ax >= ay && ax >= az) { p.y = mStart.y; p.z = mStart.z } else if (ay >= az) { p.x = mStart.x; p.z = mStart.z } else { p.x = mStart.x; p.y = mStart.y }
  }
  return p
}
function setTool(t) {
  state.tool = t
  $('measure').classList.toggle('on', t === 'measure')
  if (t !== 'measure' && rubber) { dropMeasure(rubber); rubber = null; mStart = null }
  renderer.domElement.style.cursor = t === 'measure' ? 'crosshair' : ''
  updateHint()
}

// ------------------------------------------------------------------ pointer interaction
let drag = null, down = null, lookDrag = null
const SNAP = 0.01
host.addEventListener('pointerdown', (e) => {
  unlockAudio()
  // placing from the catalogue: a click on the canvas, or on the item's own toolbar riding along, drops it
  if (placing && e.button === 0 && (e.target === renderer.domElement || e.target.closest('#itemBar'))) { endPlacing(true); e.stopPropagation(); e.preventDefault(); return }
  if (e.target !== renderer.domElement) return
  if (state.mode === 'walk') {
    lookDrag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button }
    renderer.domElement.setPointerCapture(e.pointerId)
    renderer.domElement.style.cursor = 'grabbing'
    return
  }
  if (e.button !== 0) return
  if (placing) { endPlacing(true); e.stopPropagation(); return }
  down = { x: e.clientX, y: e.clientY }
  if (state.tool === 'measure') return
  const hits = pick(e, [planner.group])
  if (!hits.length) return
  const item = hits[0].object.userData.item
  if (!item) return
  planner.select(item)
  const p = planePoint(e, hits[0].point.y)
  drag = { item, y: hits[0].point.y, dx: item.x - p.x, dz: item.z - p.z }
  // keep the pointer on the canvas for the whole drag: the item's toolbar pops up under the cursor for
  // flat things like rugs, and releasing over it must still drop the item
  renderer.domElement.setPointerCapture(e.pointerId)
  orbitP.enabled = false; orbitO.enabled = false
  e.stopPropagation()
}, { capture: true })

host.addEventListener('pointermove', (e) => {
  if (state.mode === 'walk') {
    if (lookDrag) {
      look.yaw += (e.clientX - lookDrag.x) * 0.0042
      look.pitch = Math.max(third() ? -1.1 : -1.35, Math.min(third() ? 0.55 : 1.35, look.pitch + (e.clientY - lookDrag.y) * 0.0042))
      lookDrag.x = e.clientX; lookDrag.y = e.clientY
      applyLook()
      cursor.visible = false
    } else if (e.target === renderer.domElement) {
      pendingHover = { clientX: e.clientX, clientY: e.clientY }
      if (!hoverQueued) { hoverQueued = true; requestAnimationFrame(doHover) }
    }
    return
  }
  if (drag) {
    const p = planePoint(e, drag.y); if (!p) return
    const it = drag.item
    it.x = Math.round((p.x + drag.dx) / SNAP) * SNAP
    it.z = Math.round((p.z + drag.dz) / SNAP) * SNAP
    planner.place(it)
    if (!e.altKey) snapToWalls(it)
    updateEditorPos()
    markDirty()
  } else if (state.tool === 'measure' && mStart) {
    const p = measurePoint(e); if (!p) return
    if (!rubber) { rubber = makeMeasure(mStart, p); measureGroup.add(rubber) } else setMeasure(rubber, mStart, p)
  }
})

function endDrag() {
  drag = null
  orbitP.enabled = state.mode === 'dollhouse'; orbitO.enabled = state.mode === 'plan'
  planner.save(); planner.emit()
}
// a release anywhere (toolbar, panel, outside the window) ends a drag
for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, () => { if (drag && !drag.placing) endDrag() })
host.addEventListener('pointerup', (e) => {
  if (state.mode === 'walk') {
    if (!lookDrag) return
    const moved = Math.hypot(e.clientX - lookDrag.sx, e.clientY - lookDrag.sy) > 5
    const button = lookDrag.button
    lookDrag = null
    renderer.domElement.style.cursor = 'grab'
    if (moved || button !== 0) return
    const w = walkPick(e)
    if (!w) return
    if (w.door) toggleDoor(w.door.userData.doorState)
    else if (w.floor && w.hit.distance < 14) {
      if (third() && avatar.ready && avatar.walkTo(w.hit.point, blockers())) walkTarget = null
      else walkTarget = new THREE.Vector3(w.hit.point.x, 0, w.hit.point.z)
    }
    return
  }
  if (drag && drag.placing) return
  if (drag) { endDrag(); return }
  if (!down || e.target !== renderer.domElement) return
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5
  down = null
  if (moved) return
  if (state.tool === 'measure') {
    const p = measurePoint(e); if (!p) return
    if (!mStart) { mStart = p }
    else { dropMeasure(rubber); rubber = null; measureGroup.add(makeMeasure(mStart, p)); mStart = null }
    return
  }
  const hits = pick(e, [apt.root])
  const door = hits.length && hits[0].object.userData.door
  if (door) { toggleDoor(door.userData.doorState); return }
  planner.select(null)
  if (state.me && avatar.ready && hits.length) {
    const h = hits[0], n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null
    if (n && n.y > 0.7 && h.point.y < 0.3) { if (avatar.walkTo(h.point, blockers())) invalidate(true) }
  }
})
// pinch to change the view width in walk mode (phones)
const touches = new Map()
let pinch0 = 0, pinchFov = 0
renderer.domElement.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') touches.set(e.pointerId, e) })
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId)) return
  touches.set(e.pointerId, e)
  if (touches.size === 2 && state.mode === 'walk') {
    const [a, b] = [...touches.values()], d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    if (!pinch0) { pinch0 = d; pinchFov = HFOV; lookDrag = null }
    HFOV = Math.max(60, Math.min(140, pinchFov * (pinch0 / d))); $('fov').value = Math.round(HFOV); $('fovLabel').textContent = Math.round(HFOV) + '°'; applyWalkFov()
  }
})
for (const ev of ['pointerup', 'pointercancel']) renderer.domElement.addEventListener(ev, (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch0 = 0 })
renderer.domElement.addEventListener('contextmenu', (e) => { if (state.mode === 'walk') e.preventDefault() })
renderer.domElement.addEventListener('pointerleave', () => { cursor.visible = false; invalidate() })
renderer.domElement.addEventListener('wheel', (e) => {
  if (drag && state.mode !== 'walk') {
    e.preventDefault(); e.stopImmediatePropagation()
    const it = drag.item; it.rot = (it.rot + Math.sign(e.deltaY) * Math.PI / 12 + Math.PI * 2) % (Math.PI * 2); planner.place(it); markDirty()
    return
  }
  if (state.mode !== 'walk') return
  e.preventDefault()
  HFOV = Math.max(60, Math.min(140, HFOV + e.deltaY * 0.05)); $('fov').value = Math.round(HFOV); $('fovLabel').textContent = Math.round(HFOV) + '°'; applyWalkFov()
}, { passive: false })

let pendingHover = null, hoverQueued = false
function doHover() {
  hoverQueued = false
  if (!pendingHover || state.mode !== 'walk' || lookDrag) return
  const w = walkPick(pendingHover)
  const vis = !!(w && w.floor && w.hit.distance < 14)
  if (vis || cursor.visible) invalidate()
  cursor.visible = vis
  if (vis) cursor.position.set(w.hit.point.x, w.hit.point.y + 0.01, w.hit.point.z)
  renderer.domElement.style.cursor = w && w.door ? 'pointer' : 'grab'
}

// flush against walls / cabinets when an edge is within 4 cm
function snapToWalls(it) {
  planner.updateClearance()
  const c = Math.cos(it.rot), s = Math.sin(it.rot)
  const dirs = [[c, -s], [-c, s], [s, c], [-s, -c]]
  let moved = false
  planner.clearLines.forEach((L, i) => {
    if (!L.line.visible) return
    const cm = parseInt(L.el.textContent, 10)
    if (cm > 0 && cm <= 4) { it.x += dirs[i][0] * cm / 100; it.z += dirs[i][1] * cm / 100; moved = true }
  })
  if (moved) planner.place(it)
}

// ------------------------------------------------------------------ keyboard
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
  if (state.mode === 'walk') {
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault()
    keys.add(e.code)
    if (e.code === 'KeyE') doorInFront()
    if (e.code === 'KeyV') setView(state.view === 'third' ? 'first' : 'third')
    if (e.key === 'Escape') setMode('dollhouse')
    return
  }
  const it = planner.selected
  if (e.key === 'Escape' && placing) { cancelPlacing(); return }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) planner.redo(); else planner.undo(); markDirty(); return }
  if (e.key === 'Escape') { if (mStart) { dropMeasure(rubber); rubber = null; mStart = null } else if (state.tool === 'measure') setTool('select'); else planner.select(null) }
  if (e.key === 'm' || e.key === 'M') setTool(state.tool === 'measure' ? 'select' : 'measure')
  if (!it) return
  if (e.key === 'r' || e.key === 'R') { rotate(it, e.shiftKey ? -Math.PI / 2 : Math.PI / 2) }
  else if (e.key === 'Delete' || e.key === 'Backspace') { planner.remove(it) }
  else if ((e.metaKey || e.ctrlKey) && e.key === 'd') { e.preventDefault(); planner.duplicate(it) }
  else if (e.key.startsWith('Arrow')) {
    e.preventDefault()
    const st = e.shiftKey ? 0.1 : 0.01, k = e.key
    let dx = 0, dz = 0
    if (k === 'ArrowLeft') dx = -st; if (k === 'ArrowRight') dx = st; if (k === 'ArrowUp') dz = -st; if (k === 'ArrowDown') dz = st
    it.x += dx; it.z += dz; planner.place(it); planner.save(); updateEditorPos(); markDirty()
  }
})
addEventListener('keyup', (e) => keys.delete(e.code))
addEventListener('blur', () => keys.clear())

function doorInFront() {
  raycaster.setFromCamera(new THREE.Vector2(0, 0), persp)
  raycaster.far = third() ? 4.5 : 2.6
  const h = raycaster.intersectObjects([apt.root], true).filter(solidHit)
  raycaster.far = Infinity
  const d = h.length && h[0].object.userData.door
  if (d) toggleDoor(d.userData.doorState)
}

const TAU = Math.PI * 2, norm = (a) => ((a % TAU) + TAU) % TAU
const degOf = (it) => Math.round(((360 - (norm(it.rot) * 180) / Math.PI) % 360) * 10) / 10 // clockwise, as seen from above
function rotate(it, a) { setRot(it, it.rot + a); planner.save(); planner.emit() }
function setRot(it, r) { it.rot = norm(r); planner.place(it); updateEditorPos(); $('ibDeg').textContent = `${Math.round(degOf(it))}°`; if (ed.rot && document.activeElement !== ed.rot) ed.rot.value = degOf(it) }

// ------------------------------------------------------------------ UI: furniture
// ---- furniture thumbnails: render each catalogue item (in the current style) to a small image
let thumbR = null, thumbEnv = null
function renderThumbs() {
  if (!thumbR) {
    thumbR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    thumbR.setSize(160, 160); thumbR.toneMapping = THREE.AgXToneMapping; thumbR.toneMappingExposure = 1.15
    const pm = new THREE.PMREMGenerator(thumbR); thumbEnv = pm.fromScene(new ThumbEnv(), 0.04).texture
  }
  const sc = new THREE.Scene(); sc.environment = thumbEnv; sc.environmentIntensity = 0.9
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(2, 4, 3); sc.add(sun)
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 50)
  const saved = [...glowMats].map((m) => [m, m.emissiveIntensity])
  for (const m of glowMats) m.emissiveIntensity = m.userData.glow === 'screen' ? 1.2 : 3 // show lights switched on
  for (const img of document.querySelectorAll('img[data-thumb]')) {
    const def = CATALOG[img.dataset.thumb]
    const color = img.dataset.thumb === 'sofa' ? theme.sofa : img.dataset.thumb === 'armchair' ? theme.armchair : img.dataset.thumb === 'rug' ? theme.rug : def.color
    const k = img.dataset.thumb
    const o = k === 'stringlights' ? def.build(0.55, def.d, 0.12, color) : def.build(def.w, def.d, def.h, color); sc.add(o)
    o.rotation.y = /wallart|frame|stringlights/.test(k) ? 0.25 : k === 'gamingpc' ? -1.1 : -0.6
    o.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(o), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3())
    const r = Math.max(size.x, size.y * 1.1, size.z, 0.05)
    const dist = (r * 0.62) / Math.tan((15 * Math.PI) / 180)
    cam.position.set(c.x + dist * 0.35, c.y + dist * 0.45, c.z + dist * 0.82); cam.lookAt(c); cam.updateProjectionMatrix()
    thumbR.render(sc, cam)
    img.src = thumbR.domElement.toDataURL()
    sc.remove(o)
  }
  for (const [m, v] of saved) m.emissiveIntensity = v
}
let thumbRuns = 0
THREE.DefaultLoadingManager.onLoad = ((prev) => () => { prev?.(); if (thumbRuns++ < 4) setTimeout(renderThumbs, 100) })(THREE.DefaultLoadingManager.onLoad)
const ICONS = { bed: '🛏', nightstand: '🗄', wardrobe: '🚪', dresser: '🗃', sofa: '🛋', armchair: '💺', coffee: '☕', tvbench: '📺', tv: '📺', bookshelf: '📚', rug: '🟫', dining: '🍽', roundtable: '⚪', chair: '🪑', desk: '🖥', officechair: '🪑', monitor: '🖥', gamingpc: '💻', floorlamp: '💡', plant: '🪴', plantsmall: '🌱', vase: '🏺', basket: '🧺', frame: '🖼', wallart: '🖼', stringlights: '✨', candle: '🕯', legoshelf: '🧱', lego: '🧱', bistro: '☕', box: '📦', raholmar: '🛏', gullaberg: '🗄', kallax: '🗄', pinntorp: '⚪', relatera: '🖥', showercurtain: '🚿', bathmat: '🟫', laundrybag: '🧺', bin: '🗑', plates: '🍽', glasses: '🥛', utensils: '🥄', oakchair: '🪑', bygglek: '🧱', mosslanda: '🖼', tertial: '💡', skadis: '🔲', gladom: '⚪', console: '▭' }
const catalogEl = $('catalog')
{
  const groups = {}
  for (const [k, d] of Object.entries(CATALOG)) (groups[d.group] ||= []).push([k, d])
  for (const [g, list] of Object.entries(groups)) {
    const h = document.createElement('div'); h.className = 'cat'; h.textContent = g; catalogEl.appendChild(h)
    for (const [k, d] of list) {
      const b = document.createElement('button'); b.innerHTML = `<img class="thumb" data-thumb="${k}" alt="">${d.label}`
      b.onclick = () => startPlacing(k, b)
      catalogEl.appendChild(b)
    }
  }
}
// click an item in the catalogue → it follows the mouse over the floor → click to drop it
let placing = null
function startPlacing(type, btn) {
  cancelPlacing()
  if (state.mode === 'walk') setMode('dollhouse')
  const t = state.mode === 'plan' ? orbitO.target : orbitP.target
  const R = (P.LIVING || { rect: [BB.x1 + 1, BB.z1 + 1, BB.x2 - 1, BB.z2 - 1] }).rect
  const it = planner.add(type, { x: Math.min(Math.max(t.x, R[0] + 0.6), R[2] - 0.6), z: Math.min(Math.max(t.z, R[1] + 0.6), R[3] - 0.6) })
  planner.select(it)
  placing = { it, btn }; btn.classList.add('placing')
  drag = { item: it, y: 0, dx: 0, dz: 0, placing: true }
  orbitP.enabled = false; orbitO.enabled = false
  showHint(hints.place)
  markDirty()
}
function endPlacing(keep) {
  if (!placing) return
  // let go of the item first: if anything below throws, it must not stay stuck to the mouse
  const { it, btn } = placing
  placing = null; drag = null
  orbitP.enabled = state.mode === 'dollhouse'; orbitO.enabled = state.mode === 'plan'
  btn.classList.remove('placing')
  if (!keep) planner.remove(it); else { planner.save(); planner.emit() }
  updateHint(); markDirty()
}
function cancelPlacing() { endPlacing(false) }
const ed = { name: $('edName'), pos: $('edPos'), w: $('edW'), d: $('edD'), h: $('edH'), e: $('edE'), c: $('edC'), rot: $('edRot'), presets: $('edPresets') }
function updateEditorPos() {
  const it = planner.selected; if (!it) return
  ed.pos.textContent = `Turned ${Math.round((it.rot * 180) / Math.PI + 360) % 360}°`
}
planner.onChange(() => {
  const it = planner.selected
  $('editor').classList.toggle('hidden', !it)
  if (it && !$('editor').dataset.shown && document.body.classList.contains('drawer-open')) showTab('furnish')
  $('editor').dataset.shown = it ? '1' : ''
  if (!it) return
  const def = CATALOG[it.type]
  ed.name.textContent = def.label
  ed.w.value = Math.round(it.w * 100); ed.d.value = Math.round(it.d * 100); ed.h.value = Math.round(it.h * 100)
  ed.w.disabled = ed.d.disabled = !!def.uniform
  ed.e.value = Math.round(it.elev * 100); ed.c.value = it.color; ed.rot.value = degOf(it)
  ed.c.disabled = !!def.uniform
  ed.presets.innerHTML = ''
  for (const [w, d] of def.presets || []) {
    const b = document.createElement('button'); b.textContent = `${Math.round(w * 100)}×${Math.round(d * 100)}`
    b.onclick = () => { it.w = w; it.d = d; planner.rebuild(it); planner.save(); planner.emit() }
    ed.presets.appendChild(b)
  }
  updateEditorPos()
})
for (const [key, inp] of [['w', ed.w], ['d', ed.d], ['h', ed.h], ['elev', ed.e]]) {
  inp.addEventListener('change', () => {
    const it = planner.selected; if (!it) return
    const v = Math.max(key === 'elev' ? 0 : 1, parseFloat(inp.value) || 0) / 100
    it[key] = v; planner.rebuild(it); planner.save(); planner.emit()
  })
}
ed.c.addEventListener('change', () => { const it = planner.selected; if (!it) return; it.color = ed.c.value; planner.rebuild(it); planner.save(); planner.emit() })
$('edRotL').onclick = () => planner.selected && rotate(planner.selected, Math.PI / 2)
$('edRotR').onclick = () => planner.selected && rotate(planner.selected, -Math.PI / 2)
$('edRot15').onclick = () => planner.selected && rotate(planner.selected, Math.PI / 12)
$('edDup').onclick = () => planner.duplicate(planner.selected)
$('edDel').onclick = () => planner.remove(planner.selected)
// ---- layouts
function renderLayouts() {
  const el = $('layouts'); el.innerHTML = ''
  for (const [k, L] of Object.entries(P.LAYOUTS)) {
    const b = document.createElement('button'); b.innerHTML = `<b>${L.name}</b><span>${L.desc}</span>`
    b.onclick = () => { cancelPlacing(); planner.load(L.items); planner.save(); markDirty() }
    el.appendChild(b)
  }
  const sl = $('savedList'); sl.innerHTML = ''
  for (const name of Object.keys(planner.savedLayouts())) {
    const r = document.createElement('div'); r.className = 'row'
    const l = document.createElement('button'); l.textContent = '★ ' + name
    l.onclick = () => { cancelPlacing(); planner.load(planner.savedLayouts()[name]); planner.save(); markDirty() }
    const d = document.createElement('button'); d.textContent = '×'; d.className = 'danger'; d.title = 'Delete saved layout'
    d.onclick = () => { if (confirm(`Delete "${name}"?`)) { planner.deleteSaved(name); renderLayouts() } }
    r.append(l, d); sl.appendChild(r)
  }
}
$('saveLayout').onclick = () => {
  const n = ($('saveName').value || '').trim() || `My layout ${Object.keys(planner.savedLayouts()).length + 1}`
  planner.saveAs(n); $('saveName').value = ''; renderLayouts()
}
$('undo').onclick = () => { planner.undo(); markDirty() }
$('redo').onclick = () => { planner.redo(); markDirty() }
renderLayouts()
// ---- floating toolbar on the selected piece
ed.rot.onchange = () => { const it = planner.selected; if (!it) return; const d = parseFloat(ed.rot.value) || 0; setRot(it, ((360 - d) * Math.PI) / 180); planner.save(); planner.emit() }
// drag the round-arrows handle sideways to spin the selected item freely
{
  const h = $('ibSpin')
  let spin = null
  h.addEventListener('pointerdown', (e) => {
    const it = planner.selected; if (!it || e.button !== 0) return
    spin = { it, x: e.clientX, rot: it.rot }; h.setPointerCapture(e.pointerId); h.classList.add('on'); e.preventDefault(); e.stopPropagation()
  })
  h.addEventListener('pointermove', (e) => {
    if (!spin) return
    let r = spin.rot - (e.clientX - spin.x) * 0.012 // ~0.7° per pixel, right = clockwise
    if (!e.altKey) { const s = Math.PI / 36; r = Math.round(r / s) * s } // 5° steps
    setRot(spin.it, r); markDirty()
  })
  const end = () => { if (!spin) return; spin = null; h.classList.remove('on'); planner.save(); planner.emit() }
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end)
}
$('ibRotL').onclick = () => planner.selected && rotate(planner.selected, Math.PI / 2)
$('ibRotR').onclick = () => planner.selected && rotate(planner.selected, -Math.PI / 2)
$('ibDup').onclick = () => planner.duplicate(planner.selected)
$('ibDel').onclick = () => planner.remove(planner.selected)
const _v = new THREE.Vector3()
function updateItemBar(cam) {
  const it = planner.selected, bar = $('itemBar')
  // hidden while the item follows the mouse: otherwise the click that should drop it lands on the bar
  if (!it || state.mode === 'walk' || drag) { bar.classList.add('hidden'); return }
  // just above the item's on-screen outline, never over it (a flat rug must stay grabbable)
  const b = planner.selBox.box
  let top = Infinity, sx = 0
  for (let k = 0; k < 8; k++) {
    _v.set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z).project(cam)
    top = Math.min(top, ((1 - _v.y) / 2) * innerHeight); sx += ((_v.x + 1) / 2) * innerWidth / 8
  }
  bar.style.left = sx + 'px'; bar.style.top = Math.max(40, top - 14) + 'px'
  bar.classList.remove('hidden')
  $('ibName').textContent = `${CATALOG[it.type].label}, ${Math.round(it.w * 100)} × ${Math.round(it.d * 100)} cm`
  $('ibDeg').textContent = `${Math.round(degOf(it))}°`
  const bad = planner.overlaps(it, apt.colliders)
  $('ibWarn').classList.toggle('hidden', !bad)
  planner.selBox.material.color.set(bad ? 0xb42318 : 0xf4c430)
}
$('clearAll').onclick = () => { if (confirm('Remove all furniture?')) planner.clearAll() }
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify(planner.serialize(), null, 2)], { type: 'application/json' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `layout-${P.ID}.json`; a.click()
}
$('import').onclick = () => $('importFile').click()
$('importFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return
  try { planner.load(JSON.parse(await f.text())); planner.save() } catch (err) { alert('Could not read layout: ' + err.message) }
  e.target.value = ''
}

// ------------------------------------------------------------------ UI: view, sun, toggles
document.querySelectorAll('#modes button').forEach((b) => (b.onclick = () => transition(() => setMode(b.dataset.mode))))
$('spots').addEventListener('click', (e) => { const b = e.target.closest('button[data-spot]'); if (b) transition(() => jumpTo(b.dataset.spot)) })
const dateEl = $('date')
dateEl.valueAsDate = new Date(Date.UTC(state.date.getFullYear(), state.date.getMonth(), state.date.getDate()))
dateEl.onchange = () => { const v = dateEl.valueAsDate; if (v) { state.date = new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()); updateSun() } }
document.querySelectorAll('[data-season]').forEach((b) => (b.onclick = () => {
  const [mm, dd] = b.dataset.season.split('-').map(Number)
  state.date = new Date(state.date.getFullYear(), mm - 1, dd)
  dateEl.valueAsDate = new Date(Date.UTC(state.date.getFullYear(), mm - 1, dd)); updateSun()
}))
$('time').oninput = (e) => { state.hour = parseFloat(e.target.value); setTimeUI(); updateSun() }
$('lights').onchange = (e) => { state.lights = e.target.value; updateSun() }
$('mood').onchange = (e) => {
  state.mood = e.target.value; localStorage.setItem('apt-mood', state.mood)
  // moods are about the evening: jump to 21:00 if it's daytime so you can see them
  if (MOODS[state.mood].evening && solarPosition(state.date, state.hour).elevation > -4) { state.hour = 21; setTimeUI() }
  updateSun()
}
{
  const el = $('styles')
  for (const [k, st] of Object.entries(STYLES)) {
    const b = document.createElement('button'); b.dataset.style = k
    b.innerHTML = `<span class="sw" style="background:linear-gradient(90deg,${st.duvet} 0 33%,${st.throw} 33% 66%,${st.cushA} 66%)"></span>${st.name}`
    b.onclick = () => applyStyle(k)
    el.appendChild(b)
  }
  state.mood = localStorage.getItem('apt-mood') || 'auto'; $('mood').value = state.mood
  applyStyle(localStorage.getItem('apt-style') || 'scandi', false)
}
$('play').onclick = () => { state.playing = !state.playing; $('play').innerHTML = state.playing ? icon('pause') + ' Pause' : icon('play') + ' Play the day' }
$('labels').onchange = (e) => { state.labels = e.target.checked; updateLabels(); syncAvatarVisibility(); invalidate() }
$('overlay').onchange = (e) => { planOverlay.visible = e.target.checked; invalidate() }
$('overlayOpacity').oninput = (e) => { planOverlay.material.opacity = parseFloat(e.target.value); invalidate() }
$('ao').onchange = (e) => { state.ao = e.target.checked; for (const cp of [compP, compO]) { cp.ao.enabled = state.ao; cp.plain.enabled = !state.ao } invalidate() }
// ---- character + view mode
function setView(v) {
  state.view = v; localStorage.setItem('apt-viewmode', v)
  document.querySelectorAll('#viewModes button').forEach((b) => b.classList.toggle('on', b.dataset.view === v))
  syncAvatarVisibility(); avatar.setOpacity(1); camDist = 1.7
  if (state.mode === 'walk') { look.pitch = v === 'third' ? -0.18 : -0.05; if (v === 'third') look.yaw = roomiestYaw(look.yaw); placeWalkCamera(); maybeAskCharacter() }
  invalidate(true)
}
function chooseChar(kind) {
  localStorage.setItem('apt-char', kind)
  document.querySelectorAll('#chars button').forEach((b) => b.classList.toggle('on', b.dataset.char === kind))
  $('charPicker').classList.add('hidden')
  avatar.setCharacter(kind).then(() => { syncAvatarVisibility(); invalidate(true); prewarm() })
}
document.querySelectorAll('#viewModes button').forEach((b) => (b.onclick = () => setView(b.dataset.view)))
document.querySelectorAll('[data-char]').forEach((b) => (b.onclick = () => chooseChar(b.dataset.char)))
setView(state.view)
{
  const c = localStorage.getItem('apt-char')
  if (c) chooseChar(c)
  else avatar.setCharacter('mannequin').then(() => { syncAvatarVisibility(); invalidate(true) })
}
// only ask who's walking once you can actually see them
function maybeAskCharacter() { if (state.view === 'third' && !localStorage.getItem('apt-char')) $('charPicker').classList.remove('hidden') }

// ---- smooth mode switches: freeze the last frame, switch, compile, then cross-fade
const fadeEl = $('fade')
let transitioning = false
async function transition(fn) {
  if (transitioning) { fn(); return }
  transitioning = true
  fadeEl.width = renderer.domElement.width; fadeEl.height = renderer.domElement.height
  fadeEl.getContext('2d').drawImage(renderer.domElement, 0, 0)
  fadeEl.classList.add('on')
  const wasMode = state.mode
  fn()
  if (state.mode === 'walk' && wasMode !== 'walk') maybeAskCharacter()
  try { await renderer.compileAsync(scene, activeCam()) } catch { /* older drivers */ }
  modeChangedAt = performance.now(); perfAcc = 0; perfN = 0; camPrev.copy(activeCam().matrixWorld); invalidate(true)
  await new Promise((r) => setTimeout(r, 220))
  fadeEl.classList.remove('on')
  transitioning = false
}

// ---- pre-compile everything the walk view needs (outdoor context, sky, wide-view pass) in the background
let prewarmed = false
async function prewarm() {
  if (prewarmed || !assetsLoaded) return
  prewarmed = true
  const vis = [context.root.visible, env.skybox && env.skybox.visible]
  context.root.visible = true; if (env.skybox) env.skybox.visible = true
  scene.traverse((o) => {
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
    for (const m of ms) for (const k of ['map', 'normalMap', 'roughnessMap', 'bumpMap']) if (m[k] && m[k].isTexture) renderer.initTexture(m[k])
  })
  try { await renderer.compileAsync(scene, persp) } catch { /* ignore */ }
  // post-processing shaders (wide-view pass) compile on first use otherwise → a hitch entering Walk
  const ps = new THREE.Scene(); ps.add(new THREE.Mesh(new THREE.PlaneGeometry(), compP.panini.material))
  try { renderer.compile(ps, ortho) } catch { /* ignore */ }
  context.root.visible = vis[0]; if (env.skybox) env.skybox.visible = vis[1]
  invalidate()
}

$('me').onchange = (e) => { state.me = e.target.checked; syncAvatarVisibility(); invalidate(true) }
$('steps').onchange = (e) => { state.steps = e.target.checked; invalidate() }
// ---- dock + drawer: the 3D view fills the screen, a tool's options slide in from the right
let panelReady = false, drawerTab = null
const DRAWER_TITLES = { furnish: 'Furnish', light: 'Light and sun', walk: 'Go to', more: 'More' }
function setDrawer(open) {
  document.body.classList.toggle('drawer-open', open)
  PANEL = open && !isNarrow() ? DRAWER_W : 0
  if (!open) drawerTab = null
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.classList.toggle('on', open && b.dataset.tab === drawerTab))
  if (!panelReady) { panelOff = PANEL; applyViewOffset() }
  invalidate()
}
function showTab(t, toggle = false) {
  if (toggle && drawerTab === t && document.body.classList.contains('drawer-open')) return setDrawer(false)
  drawerTab = t
  $('drawerTitle').textContent = DRAWER_TITLES[t] || ''
  document.querySelectorAll('section.tab').forEach((sct) => sct.classList.toggle('hidden', sct.dataset.tab !== t))
  setDrawer(true)
  $('panel').scrollTop = 0
}
$('panelMin').onclick = () => setDrawer(false)
document.querySelectorAll('#tabs button[data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab, true)))
$('sunChip').onclick = () => showTab('light', true)
addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('drawer-open') && !e.target.matches('input, select')) setDrawer(false) })
setDrawer(false)
panelReady = true
$('photoreal').onchange = (e) => { state.photoreal = e.target.checked; applyWalkFov(); updateSun(); markDirty() }
$('curtains').checked = state.curtains
$('curtains').onchange = (e) => { state.curtains = e.target.checked; rebuild() }
// re-bake: the dev server runs Blender on this Mac for the current time of day (the furniture is not part of the bake)
{
  const btn = $('rebake'), note = $('rebakeNote')
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const STEP = { exporting: 'Exporting the room', baking: 'Blender is baking the light', denoising: 'Cleaning up', running: 'Working' }
  let polling = 0
  async function poll() {
    let j
    try { j = await (await fetch('/__bake', { cache: 'no-store' })).json() } catch { note.textContent = 'Lost contact with the dev server.'; btn.disabled = false; return }
    if (j.state === 'running' && j.id === P.ID) {
      btn.disabled = true; btn.textContent = 'Baking…'
      note.textContent = `${STEP[j.step] || STEP.running}, ${fmt(j.elapsed)}. You can keep using the app.`
      polling = setTimeout(poll, 2000); return
    }
    btn.disabled = false; btn.textContent = 'Re-bake lighting'
    if (j.state === 'done' && j.id === P.ID && polling) {
      bakeList = await bakeHours(P.ID, j.finished).catch(() => bakeList)
      const b = loadBake(P.ID, j.hour, j.finished).catch(() => null)
      bakeCache.set(j.hour, b)
      if (await b) { clearBake(bake); bake = await b; syncBake(); note.textContent = `Done. Lighting baked for ${hhmm(j.hour)}.` }
    } else if (j.state === 'error' && polling) note.textContent = 'The bake failed. The dev server terminal has the details.'
    polling = 0
  }
  btn.onclick = async () => {
    const r = await fetch('/__bake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: P.ID, items: planner.serialize(), hour: state.hour }) }).catch(() => null)
    if (!r || (!r.ok && r.status !== 409)) { note.textContent = 'Re-baking needs the dev server (npm run dev) on this Mac.'; return }
    polling = 1; poll()
  }
  fetch('/__bake', { cache: 'no-store' }).then((r) => r.json()).then((j) => { if (j.state === 'running') { polling = 1; poll() } }).catch(() => { btn.hidden = true; note.hidden = true })
}
$('bakeChip').onclick = toggleBaked
$('bakeToggle').onclick = toggleBaked
let cutTimer = 0
$('cut').oninput = (e) => {
  state.cut = parseFloat(e.target.value); $('cutLabel').textContent = state.cut.toFixed(2) + ' m'
  clearTimeout(cutTimer); cutTimer = setTimeout(rebuild, 30)
}
{
  const saved = JSON.parse(localStorage.getItem('apt-view2') || '{}')
  if (saved.panini === false) $('eyeproj').checked = false
  if (saved.height) $('height').value = saved.height
  if (saved.hfov) $('fov').value = saved.hfov
  const apply = () => {
    const h = Math.min(220, Math.max(120, parseFloat($('height').value) || 178))
    EYE = (h * 0.935) / 100
    avatar.setHeight(h / 100)
    proj.panini = $('eyeproj').checked
    HFOV = parseFloat($('fov').value); $('fovLabel').textContent = HFOV + '°'
    if (state.mode === 'walk') { persp.position.y = EYE; applyWalkFov() }
    localStorage.setItem('apt-view2', JSON.stringify({ height: h, hfov: HFOV, panini: proj.panini }))
  }
  $('height').onchange = apply; $('fov').oninput = apply; $('eyeproj').onchange = apply
  $('fovEye').onclick = () => { $('eyeproj').checked = true; $('fov').value = 120; apply() }
  apply()
}
$('measure').onclick = () => setTool(state.tool === 'measure' ? 'select' : 'measure')
$('clearMeasure').onclick = () => { for (const g of [...measureGroup.children]) dropMeasure(g); rubber = null; mStart = null }
// ---- Photo mode: one high-quality still (supersampled, full-res AO, sharper shadows), saved as PNG
async function takePhoto() {
  const btn = $('shot'); btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = icon('camera') + ' Rendering…'
  await new Promise((r) => setTimeout(r, 30))
  const cp = state.mode === 'plan' ? compO : compP, cam = activeCam()
  const prevDPR = renderer.getPixelRatio(), cfg = { ...cp.ao.configuration }
  const hide = [labelGroup, cursor, planner.selBox, planner.clear, measureGroup]; const vis = hide.map((o) => o.visible); hide.forEach((o) => (o.visible = false))
  const bar = $('itemBar'); bar.classList.add('hidden')
  const maxTex = renderer.capabilities.maxTextureSize
  const dpr = Math.min(3, maxTex / innerWidth, maxTex / innerHeight)
  setDPR(dpr)
  Object.assign(cp.ao.configuration, { halfRes: false, aoSamples: 32, denoiseSamples: 16, denoiseRadius: 6 })
  sun.shadow.mapSize.set(8192, 8192); sun.shadow.map?.dispose(); sun.shadow.map = null; renderer.shadowMap.needsUpdate = true
  cp.c.render(); cp.c.render() // 2nd pass after shadow + AO settle
  const url = renderer.domElement.toDataURL('image/png')
  // restore
  Object.assign(cp.ao.configuration, cfg)
  sun.shadow.mapSize.set(4096, 4096); sun.shadow.map?.dispose(); sun.shadow.map = null; renderer.shadowMap.needsUpdate = true
  setDPR(prevDPR); hide.forEach((o, i) => (o.visible = vis[i])); invalidate(true)
  const a = document.createElement('a'); a.href = url; a.download = `apartment-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`; a.click()
  btn.innerHTML = old; btn.disabled = false
  void cam
}
$('shot').onclick = takePhoto
$('shot2').onclick = takePhoto

// ------------------------------------------------------------------ resize / loop
function updatePaniniTexel() { const d = renderer.getPixelRatio(); for (const cp of [compP, compO]) cp.panini.uniforms.texel.value.set(1 / (innerWidth * d), 1 / (innerHeight * d)) }
function setDPR(d) {
  if (Math.abs(renderer.getPixelRatio() - d) < 0.01) return
  renderer.setPixelRatio(d)
  for (const cp of [compP, compO]) { cp.c.setPixelRatio(d); cp.c.setSize(innerWidth, innerHeight); cp.ao.setSize(innerWidth * d, innerHeight * d) }
  updatePaniniTexel()
}
function resize() {
  PANEL = !isNarrow() && document.body.classList.contains('drawer-open') ? DRAWER_W : 0
  panelOff = PANEL
  const w = innerWidth, h = innerHeight
  renderer.setSize(w, h); labelRenderer.setSize(w, h)
  const d = renderer.getPixelRatio()
  for (const cp of [compP, compO]) { cp.c.setSize(w, h); cp.c.setPixelRatio(d); cp.ao.setSize(w * d, h * d) }
  updatePaniniTexel()
  invalidate()
  persp.aspect = w / h; persp.updateProjectionMatrix(); applyWalkFov()
  fitOrtho(); applyViewOffset()
  pt.updateCamera()
}
addEventListener('resize', resize)

const north = northVector(new THREE.Vector3())
const needle = $('needle')
function updateCompass() {
  let f, r
  if (state.mode === 'plan') { f = new THREE.Vector3(0, 0, -1); r = new THREE.Vector3(1, 0, 0) }
  else { f = persp.getWorldDirection(new THREE.Vector3()); f.y = 0; f.normalize(); r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)) }
  needle.style.transform = `rotate(${Math.atan2(north.dot(r), north.dot(f))}rad)`
}

const lastCam = new THREE.Matrix4(), lastProj = new THREE.Matrix4()
const ptStatus = $('ptStatus')
function render() {
  const cam = activeCam()
  if (usePT() && ptReady) {
    persp.updateMatrixWorld()
    if (!lastCam.equals(persp.matrixWorld) || !lastProj.equals(persp.projectionMatrix)) {
      lastCam.copy(persp.matrixWorld); lastProj.copy(persp.projectionMatrix)
      pt.updateCamera()
    }
    pt.renderSample()
    ptStatus.textContent = pt.isCompiling ? 'compiling…' : `${Math.floor(pt.samples)} samples`
  } else {
    ;(state.mode === 'plan' ? compO : compP).c.render()
    ptStatus.textContent = usePT() ? 'preparing…' : 'off'
  }
  renderer.autoClear = false
  renderer.clearDepth()
  renderer.render(overlay, cam)
  renderer.autoClear = true
  updateItemBar(cam)
  labelRenderer.render(overlay, cam)
}

const timer = new THREE.Timer()
function frame() {
  timer.update()
  const dt = Math.min(timer.getDelta(), 0.05)
  if (state.playing) { state.hour += dt * 0.6; if (state.hour > 23) state.hour = 4; setTimeUI(); updateSun() }
  let doorsMoving = false
  for (const d of doors) {
    if (Math.abs(d.target - d.angle) > 1e-3) { d.angle += (d.target - d.angle) * Math.min(1, dt * 7); d.group.rotation.y = d.base + d.angle; doorsMoving = true }
    else if (d.moving) { d.angle = d.target; d.group.rotation.y = d.base + d.angle; d.moving = false; markDirty() }
  }
  if (doorsMoving) ptReady = false
  if (avatar.update(dt)) invalidate(true)
  if (Math.abs(panelOff - PANEL) > 0.5) { panelOff += (PANEL - panelOff) * Math.min(1, dt * 11); applyViewOffset(); invalidate() }
  else if (panelOff !== PANEL) { panelOff = PANEL; applyViewOffset(); invalidate() }
  // candle flicker
  let flick = false
  for (const L of moodLights) if (L.userData.kind === 'candle' && L.userData.on > 0) { L.intensity = L.userData.base * L.userData.on * (0.82 + 0.18 * Math.sin(performance.now() / 70 + L.id) * Math.sin(performance.now() / 113 + L.id * 3)); flick = true }
  if (flick) renderFrames = Math.max(renderFrames, 1)
  if (state.mode === 'walk') walk(dt)
  else if (state.mode === 'dollhouse') orbitP.update()
  else orbitO.update()
  if (ptDirty && assetsLoaded && usePT() && !drag && !doorsMoving && performance.now() - ptDirtyAt > 250) syncPathTracer()

  const cam = activeCam()
  cam.updateMatrixWorld()
  const now = performance.now()
  const camMoved = !camPrev.equals(cam.matrixWorld) || !projPrev.equals(cam.projectionMatrix)
  if (camMoved) { camPrev.copy(cam.matrixWorld); projPrev.copy(cam.projectionMatrix); lastMoveAt = now; invalidate() }
  if (doorsMoving || state.playing || drag) { lastMoveAt = now; invalidate(true) }
  if (usePT() && ptReady) renderFrames = 2 // keep accumulating samples
  if (renderFrames <= 0) return
  renderFrames--

  const moving = now - lastMoveAt < 160
  if (shadowDirty) { renderer.shadowMap.needsUpdate = true; shadowDirty = false }
  const t0 = performance.now()
  updateCompass()
  render()
  if (moving && !transitioning && now - modeChangedAt > 1500) {
    // sustained slow motion (not one-off hitches) → step the resolution down once, and remember it
    perfAcc += dt * 1000; perfN++
    if (perfN >= 90) {
      const avg = perfAcc / perfN; perfAcc = 0; perfN = 0
      if (avg > 28 && dprMove > DPR_MIN) { dprMove = Math.max(DPR_MIN, dprMove - 0.25); localStorage.setItem('apt-dpr2', dprMove); pendingDPR = dprMove }
      else if (avg < 13 && dprMove < DPR_MAX) { dprMove = Math.min(DPR_MAX, dprMove + 0.25); localStorage.setItem('apt-dpr2', dprMove); pendingDPR = dprMove } // fast GPU → sharper
    }
  } else if (!moving && pendingDPR) { setDPR(pendingDPR); pendingDPR = 0 } // apply while still, never mid-motion
  void t0
}
const camPrev = new THREE.Matrix4(), projPrev = new THREE.Matrix4()
let perfAcc = 0, perfN = 0, pendingDPR = 0, modeChangedAt = 0

// URL params (?mode=walk&spot=kitchen&t=18.5&date=2026-12-21&pt=0) — handy for sharing a view
{
  const q = new URLSearchParams(location.search)
  if (q.get('t')) state.hour = parseFloat(q.get('t'))
  if (q.get('date')) { const [y, m, d] = q.get('date').split('-').map(Number); state.date = new Date(y, m - 1, d); dateEl.valueAsDate = new Date(Date.UTC(y, m - 1, d)) }
  if (q.get('pt') === '1') { state.photoreal = true; $('photoreal').checked = true }
  fitOrtho(); applyViewOffset(); setTimeUI(); updateHint(); updateLabels()
  furnColliders = planner.colliders()
  state.mode = ''
  setMode(q.get('mode') || 'dollhouse')
  if (q.get('spot')) jumpTo(q.get('spot'))
  if (q.get('overlay')) { planOverlay.visible = true; $('overlay').checked = true }
}
window.__bake = { exportBake: (meta) => exportBake({ scene, aptRoot: apt.root, exclude: [planner.group, avatar.group], meta, rooms: [...P.INDOOR_ROOMS.map((r) => [...r.rect, r.ceiling]), ...(P.BALCONY ? [[...P.BALCONY.rect, 2.6]] : [])] }), get bake() { return bake }, syncBake, sun, sunDir }
window.__apt = { ShaderPass, get probeDirty() { return probeDirty }, captureProbe, sun, fill, bounceFloor, windowLights, compO, player, look, applyLook, avatar, sunA, invalidate, get dprMove() { return dprMove }, THREE, denoise, M, compP, renderer, collide, get walkTarget() { return walkTarget }, get apt() { return apt }, get doors() { return doors }, state, setMode, jumpTo, planner, scene, persp, ortho, orbitP, updateSun, setTimeUI, pt, markDirty }
renderer.setAnimationLoop(frame)
