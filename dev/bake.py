# Bake an apartment's light with Cycles into one lightmap atlas.
#   blender -b --factory-startup -P dev/bake.py -- <apartment-id> [samples] [size]
# reads dev/bake-work/<id>.glb + <id>.sun.json (from dev/bake.mjs), writes dev/bake-work/<id>.lightmap.exr
# The bake is the diffuse light only (direct + indirect, no surface colour): the app multiplies it by each
# surface's own albedo, so textures stay sharp and only the lighting comes from Blender.
# The sun's direct beam is baked a second time on its own and subtracted: the app draws it live with the
# live shadow map, so furniture (which is not in this bake) still casts sun shadows on the floor.
# Objects named P* are the light-probe cubes: they record light but never block or bounce it.
import bpy, sys, os, json, math
import numpy as np
sys.stdout.reconfigure(line_buffering=True)  # progress reaches the app while baking
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
apt = argv[0] if argv else 'apartment-1'
samples = int(argv[1]) if len(argv) > 1 else 512
size = int(argv[2]) if len(argv) > 2 else 2048
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
work = os.path.join(root, 'dev', 'bake-work')
sun = json.load(open(os.path.join(work, f'{apt}.sun.json')))

# ---------------------------------------------------------------- scene
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(work, f'{apt}.glb'))
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
try:
    prefs.compute_device_type = 'METAL'; prefs.get_devices()
    for d in prefs.devices: d.use = True
    sc.cycles.device = 'GPU'
except Exception as e:
    print('GPU unavailable, using CPU:', e)
sc.cycles.samples = samples
sc.cycles.max_bounces = 8; sc.cycles.diffuse_bounces = 6; sc.cycles.glossy_bounces = 2
sc.cycles.sample_clamp_indirect = 10

# ---------------------------------------------------------------- sky: the app's HDRI, sun disk clipped (like the app)
world = bpy.data.worlds.new('sky'); sc.world = world; world.use_nodes = True
nt = world.node_tree; nt.nodes.clear()
hdr = bpy.data.images.load(os.path.join(root, 'public', 'hdri', 'je_gray_park_2k.hdr'))
tc = nt.nodes.new('ShaderNodeTexCoord'); mp = nt.nodes.new('ShaderNodeMapping'); et = nt.nodes.new('ShaderNodeTexEnvironment')
et.image = hdr
# three: environmentRotation.y rotates the sky about +Y; glTF import maps three (x,y,z) → Blender (x,-z,y)
# and three's equirect seam sits half a turn from Blender's → Blender Z rotation = rot + π
mp.inputs['Rotation'].default_value = (0, 0, sun['envRotation'] + math.pi)
clamp = nt.nodes.new('ShaderNodeVectorMath'); clamp.operation = 'MINIMUM'; clamp.inputs[1].default_value = (4, 4, 4)
bg = nt.nodes.new('ShaderNodeBackground'); out = nt.nodes.new('ShaderNodeOutputWorld')
nt.links.new(tc.outputs['Generated'], mp.inputs['Vector']); nt.links.new(mp.outputs['Vector'], et.inputs['Vector'])
nt.links.new(et.outputs['Color'], clamp.inputs[0]); nt.links.new(clamp.outputs['Vector'], bg.inputs['Color'])
nt.links.new(bg.outputs['Background'], out.inputs['Surface'])

# sky irradiance on a horizontal surface (clipped HDRI) → sun strength as a multiple of it
px = np.array(hdr.pixels[:], dtype=np.float32).reshape(hdr.size[1], hdr.size[0], 4)[..., :3]
px = np.minimum(px, 4.0)
H, W = px.shape[:2]
theta = (np.arange(H) + 0.5) / H * math.pi  # Blender rows run bottom-up: row 0 = straight down
elev = theta - math.pi / 2
up = np.clip(np.sin(elev), 0, None)
lum = px @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
E_sky = float(np.sum(lum * (up * np.cos(elev))[:, None]) * (2 * math.pi / W) * (math.pi / H))
SUN_RATIO = 3.0
d = sun['dir']
el = math.degrees(math.asin(max(-1, min(1, d[1]))))
strength = SUN_RATIO * E_sky * max(0.0, min(1.0, (el + 0.5) / 5.5))
print(f'sky irradiance {E_sky:.3f}, sun elevation {el:.1f} deg, sun strength {strength:.3f}')

so = None
if strength > 0:
    sd = bpy.data.lights.new('sun', 'SUN'); sd.energy = strength; sd.angle = math.radians(0.53)
    sd.color = sun['color']
    so = bpy.data.objects.new('sun', sd); sc.collection.objects.link(so)
    to_sun = Vector((d[0], -d[2], d[1])).normalized()
    so.rotation_euler = (-to_sun).to_track_quat('-Z', 'Y').to_euler()

lamp_objs = []
for i, L in enumerate(sun.get('lamps', [])):
    ld = bpy.data.lights.new(f'lamp{i}', 'POINT'); ld.energy = L['power']; ld.color = L['color']; ld.shadow_soft_size = 0.12
    lo = bpy.data.objects.new(f'lamp{i}', ld); sc.collection.objects.link(lo)
    x, y, z = L['pos']; lo.location = (x, -z, y - 0.15); lamp_objs.append(lo)
    print('lamp', lo.location[:], L['power'], 'W')

# backfaces let light through: where pieces overlap (window frame corners, boxes meeting), a texel that
# sits inside another piece would otherwise only see its inside and bake black
for m in bpy.data.materials:
    if not m.use_nodes: continue
    nt = m.node_tree
    out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
    if not out or not out.inputs['Surface'].links: continue
    src = out.inputs['Surface'].links[0].from_socket
    geo = nt.nodes.new('ShaderNodeNewGeometry'); tr = nt.nodes.new('ShaderNodeBsdfTransparent'); mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(geo.outputs['Backfacing'], mix.inputs['Fac']); nt.links.new(src, mix.inputs[1]); nt.links.new(tr.outputs['BSDF'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])

# ---------------------------------------------------------------- bake targets
img = bpy.data.images.new('lightmap', size, size, alpha=False, float_buffer=True)
img.colorspace_settings.name = 'Non-Color'
targets = [o for o in sc.objects if o.type == 'MESH' and o.name.startswith('T')]
probes = [o for o in sc.objects if o.type == 'MESH' and o.name.startswith('P')]
for o in probes:
    if o.data.uv_layers: o.data.uv_layers.active = o.data.uv_layers[0]
    for a in ('visible_diffuse', 'visible_glossy', 'visible_transmission', 'visible_shadow', 'visible_volume_scatter'): setattr(o, a, False)
mats_done = set()
for o in targets:
    if o.data.uv_layers: o.data.uv_layers.active = o.data.uv_layers[0]
    for slot in o.material_slots:
        m = slot.material
        if not m or m.name in mats_done: continue
        mats_done.add(m.name)
        n = m.node_tree.nodes.new('ShaderNodeTexImage'); n.image = img
        m.node_tree.nodes.active = n
# occluder materials that targets share would also need the node; give every material one
for m in bpy.data.materials:
    if m.use_nodes and m.name not in mats_done:
        n = m.node_tree.nodes.new('ShaderNodeTexImage'); n.image = img; m.node_tree.nodes.active = n
# one object = one bake job: Cycles re-syncs the whole scene for every selected object, so baking 200 parts
# separately spends most of its time preparing. They share one atlas and one UV map name, so joining is lossless.
bpy.ops.object.select_all(action='DESELECT')
for o in targets: o.select_set(True)
bpy.context.view_layer.objects.active = targets[0]
n_parts = len(targets)
if n_parts > 1:
    bpy.ops.object.join()
    targets = [bpy.context.view_layer.objects.active]
for o in targets + probes: o.select_set(True)
bpy.context.view_layer.objects.active = targets[0]
print(f'baking {n_parts} parts (joined into {len(targets)}) + {len(probes)} probe sets at {size}px, {samples} samples')
sc.render.bake.margin = 6
sc.render.bake.margin_type = 'EXTEND'
bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, use_clear=True, margin=6)
full = np.array(img.pixels[:], dtype=np.float32).reshape(-1, 4)

# the sun's direct beam alone: no sky, no lamps, no bounces
sun_only = np.zeros_like(full)
if so is not None:
    bg.inputs['Strength'].default_value = 0
    for lo in lamp_objs: lo.hide_render = True
    sc.cycles.samples = 128
    print('baking the direct sun')
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT'}, use_clear=True, margin=6)
    sun_only = np.array(img.pixels[:], dtype=np.float32).reshape(-1, 4)
rest = full.copy(); rest[:, :3] = np.maximum(full[:, :3] - sun_only[:, :3], 0)
img.pixels.foreach_set(rest.ravel())

# ---------------------------------------------------------------- save
outdir = work
sc.render.image_settings.file_format = 'OPEN_EXR'
sc.render.image_settings.color_depth = '16'
sc.render.image_settings.exr_codec = 'ZIP'
path = os.path.join(outdir, f'{apt}.lightmap.exr')
img.save_render(path, scene=sc)
print('saved', path, os.path.getsize(path) // 1024, 'KB')

# ---------------------------------------------------------------- white balance (like a camera): pull the
# average baked light most of the way to neutral, so a low warm sun doesn't turn the whole room orange
px = full[:, :3]
lit = px[px.sum(1) > 1e-4]
mean = lit.mean(0)
lum = float(mean @ np.array([0.2126, 0.7152, 0.0722]))
wb = [float((lum / max(c, 1e-6)) ** 0.8) for c in mean]
jp = os.path.join(work, f'{apt}.bake.json')
j = json.load(open(jp)); j['whiteBalance'] = wb; j['meanLight'] = lum
# live sun → baked units: Cycles bakes a sun of strength S as S·cosθ/π; the app's sun is intensity × cosθ
j['sunScale'] = (strength / math.pi) * j.get('intensity', 1) / sun['intensity'] if so is not None and sun['intensity'] > 0 else 0
json.dump(j, open(jp, 'w'))
print('white balance', wb, 'mean light', lum)
