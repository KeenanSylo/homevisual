# Denoise a baked lightmap with Blender's compositor (Intel OIDN), in place.
#   blender -b --factory-startup -P dev/denoise.py -- <path/to/lightmap.exr>
import bpy, sys, os
path = sys.argv[sys.argv.index('--') + 1]
sc = bpy.context.scene
img = bpy.data.images.load(path)
sc.render.resolution_x, sc.render.resolution_y = img.size
sc.render.resolution_percentage = 100
tree = bpy.data.node_groups.new('denoise', 'CompositorNodeTree')
sc.compositing_node_group = tree
src = tree.nodes.new('CompositorNodeImage'); src.image = img
dn = tree.nodes.new('CompositorNodeDenoise')
out = tree.nodes.new('NodeGroupOutput')
tree.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
tree.links.new(src.outputs['Image'], dn.inputs['Image'])
tree.links.new(dn.outputs['Image'], out.inputs[0])
for k in ('hdr', 'use_hdr'):
    if hasattr(dn, k): setattr(dn, k, True)
for s in dn.inputs:
    if s.name.lower() == 'hdr': s.default_value = True
sc.render.image_settings.file_format = 'OPEN_EXR'
sc.render.image_settings.color_depth = '16'
sc.render.image_settings.exr_codec = 'ZIP'
sc.render.filepath = path
bpy.ops.render.render(write_still=True)
print('denoised', path, os.path.getsize(path) // 1024, 'KB')
