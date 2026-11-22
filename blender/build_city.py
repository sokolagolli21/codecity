"""Build a CodeCity export (JSON from the web app's "Export for Blender") as a night-time
Blender scene with a cinematic camera move, then render it.

Usage (Blender 4.2+ / 5.x, headless):
  blender -b --factory-startup --python build_city.py -- city.json --out renders/react
      [--res 1080x1350] [--seconds 12] [--fps 30] [--samples 32]
      [--still 0.5]          render one frame at 50% of the move (quick look)
      [--save-blend scene.blend]

Frames land in <out>/frames/0001.png …; encode them with ffmpeg (see README).
Coordinates: the web app is Y-up (x, y, z); Blender is Z-up, so (x, y, z) -> (x, -z, y).
"""
import argparse
import json
import math
import os
import sys

import bpy
import numpy as np

# ------------------------------------------------------------------ args

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser(prog="build_city.py")
ap.add_argument("json")
ap.add_argument("--out", default="renders/city")
ap.add_argument("--res", default="1080x1350")
ap.add_argument("--seconds", type=float, default=12.0)
ap.add_argument("--fps", type=int, default=30)
ap.add_argument("--samples", type=int, default=32)
ap.add_argument("--still", type=float, default=None)
ap.add_argument("--save-blend", default=None)
args = ap.parse_args(argv)

with open(args.json, "r", encoding="utf-8") as fh:
    data = json.load(fh)

S = float(data["size"])
W, H_RES = (int(v) for v in args.res.lower().split("x"))
OUT = os.path.abspath(args.out)
os.makedirs(os.path.join(OUT, "frames"), exist_ok=True)

NIGHT = {
    "sky_top": "#02040a", "horizon": "#16203f", "ground": "#0c1222",
    "dist_a": "#1a2441", "dist_b": "#3b4a75", "warm": (1.0, 0.7, 0.36),
}


def srgb_to_linear(hexstr):
    hexstr = hexstr.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(hexstr[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out


# ------------------------------------------------------------------ fresh scene

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = "CodeCity"

# ------------------------------------------------------------------ geometry

# Unit box with its base at z=0. Faces wound counter-clockwise seen from outside.
CORNERS = np.array([
    [-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0],
    [-0.5, -0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1], [-0.5, 0.5, 1],
], dtype=np.float32)
FACES = np.array([
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
], dtype=np.int64)


def boxes_mesh(name, boxes):
    """boxes: (N, 6) array of [cx, cy, z0, sx, sy, sz] in Blender space."""
    n = len(boxes)
    base = np.stack([boxes[:, 0], boxes[:, 1], boxes[:, 2]], axis=1)[:, None, :]
    scale = np.stack([boxes[:, 3], boxes[:, 4], boxes[:, 5]], axis=1)[:, None, :]
    verts = (base + CORNERS[None, :, :] * scale).reshape(-1, 3)
    faces = (FACES[None, :, :] + (np.arange(n) * 8)[:, None, None]).reshape(-1, 4)

    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(len(verts))
    mesh.vertices.foreach_set("co", verts.astype(np.float32).ravel())
    mesh.loops.add(faces.size)
    mesh.loops.foreach_set("vertex_index", faces.astype(np.int32).ravel())
    mesh.polygons.add(len(faces))
    mesh.polygons.foreach_set("loop_start", (np.arange(len(faces)) * 4).astype(np.int32))
    # Boxes share corner vertices, so they must be flat shaded (Blender 4.1+ defaults to smooth).
    mesh.polygons.foreach_set("use_smooth", np.zeros(len(faces), dtype=bool))
    mesh.update()
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    return obj, mesh


def point_attr(mesh, name, kind, values):
    attr = mesh.attributes.new(name=name, type=kind, domain="POINT")
    key = "color" if kind == "FLOAT_COLOR" else "value"
    attr.data.foreach_set(key, np.asarray(values, dtype=np.float32).ravel())


b = np.array(data["buildings"], dtype=np.float64)  # x, z, w, d, y0, h, color index
bx, bz, bw, bd, by0, bh, bk = (b[:, i] for i in range(7))
building_boxes = np.stack([bx, -bz, by0, bw, bd, bh], axis=1)
buildings, bmesh_data = boxes_mesh("Buildings", building_boxes)

palette = np.array([srgb_to_linear(c) + [1.0] for c in data["palette"]], dtype=np.float32)
colors = np.repeat(palette[bk.astype(int)], 8, axis=0)
point_attr(bmesh_data, "lang_color", "FLOAT_COLOR", colors)
rng = np.random.default_rng(7)
point_attr(bmesh_data, "seed", "FLOAT", np.repeat(rng.random(len(b)), 8))

d = np.array(data["districts"], dtype=np.float64) if data["districts"] else np.zeros((0, 7))
if len(d):
    district_boxes = np.stack([d[:, 0], -d[:, 1], d[:, 4], d[:, 2], d[:, 3], d[:, 5]], axis=1)
    districts, dmesh_data = boxes_mesh("Districts", district_boxes)
    point_attr(dmesh_data, "depth", "FLOAT", np.repeat(np.minimum(1.0, (d[:, 6] - 1) / 5.0), 8))
else:
    districts = None

bpy.ops.mesh.primitive_plane_add(size=S * 12, location=(0, 0, -0.01))
ground = bpy.context.active_object
ground.name = "Ground"

# ------------------------------------------------------------------ materials

def new_material(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat, nt, bsdf


def wire(nt, value, socket):
    if isinstance(value, (int, float, tuple, list)):
        socket.default_value = value
    else:
        nt.links.new(value, socket)


def math_node(nt, op, a, b=None):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    wire(nt, a, n.inputs[0])
    if b is not None:
        wire(nt, b, n.inputs[1])
    return n.outputs[0]


def vmath(nt, op, a, b=None, scale=None):
    n = nt.nodes.new("ShaderNodeVectorMath")
    n.operation = op
    wire(nt, a, n.inputs[0])
    if b is not None:
        wire(nt, b, n.inputs[1])
    if scale is not None:
        wire(nt, scale, n.inputs["Scale"])
    return n.outputs[0]


def mix_color(nt, fac, a, b):
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = "RGBA"
    wire(nt, fac, n.inputs["Factor"])
    rgba_in = [s for s in n.inputs if s.type == "RGBA"]
    wire(nt, a, rgba_in[0])
    wire(nt, b, rgba_in[1])
    return [s for s in n.outputs if s.type == "RGBA"][0]


def building_material():
    mat, nt, bsdf = new_material("Building")
    bsdf.inputs["Roughness"].default_value = 0.72
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "lang_color"
    seed = nt.nodes.new("ShaderNodeAttribute")
    seed.attribute_name = "seed"

    geo = nt.nodes.new("ShaderNodeNewGeometry")
    pos = nt.nodes.new("ShaderNodeSeparateXYZ")
    nrm = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(geo.outputs["Position"], pos.inputs[0])
    nt.links.new(geo.outputs["Normal"], nrm.inputs[0])
    px, py, pz = pos.outputs
    nx, ny, nz = nrm.outputs

    # Horizontal coordinate along whichever wall we're on; vertical is height.
    u = math_node(nt, "ADD",
                  math_node(nt, "MULTIPLY", px, math_node(nt, "ABSOLUTE", ny)),
                  math_node(nt, "MULTIPLY", py, math_node(nt, "ABSOLUTE", nx)))
    cu = math_node(nt, "MULTIPLY", u, 0.62)
    cv = math_node(nt, "MULTIPLY", pz, 0.5)
    fu = math_node(nt, "FRACT", cu)
    fv = math_node(nt, "FRACT", cv)
    win = math_node(nt, "MULTIPLY",
                    math_node(nt, "MULTIPLY", math_node(nt, "GREATER_THAN", fu, 0.2), math_node(nt, "LESS_THAN", fu, 0.8)),
                    math_node(nt, "MULTIPLY", math_node(nt, "GREATER_THAN", fv, 0.25), math_node(nt, "LESS_THAN", fv, 0.75)))
    side = math_node(nt, "LESS_THAN", math_node(nt, "ABSOLUTE", nz), 0.6)
    top = math_node(nt, "GREATER_THAN", nz, 0.6)

    cell = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(math_node(nt, "FLOOR", cu), cell.inputs[0])
    nt.links.new(math_node(nt, "FLOOR", cv), cell.inputs[1])
    nt.links.new(math_node(nt, "ADD", math_node(nt, "MULTIPLY", seed.outputs["Fac"], 1000.0),
                           math_node(nt, "ROUND", math_node(nt, "MULTIPLY", nx, 3.0))), cell.inputs[2])
    noise = nt.nodes.new("ShaderNodeTexWhiteNoise")
    noise.noise_dimensions = "3D"
    nt.links.new(cell.outputs[0], noise.inputs["Vector"])
    rnd = noise.outputs["Value"]
    lit = math_node(nt, "GREATER_THAN", rnd, 0.6)

    mask = math_node(nt, "MULTIPLY", math_node(nt, "MULTIPLY", win, side), lit)
    strength = math_node(nt, "MULTIPLY", mask, math_node(nt, "ADD", 2.2, math_node(nt, "MULTIPLY", rnd, 3.0)))
    warm = mix_color(nt, 0.25, (*NIGHT["warm"], 1.0), attr.outputs["Color"])
    window_light = vmath(nt, "SCALE", warm, scale=strength)
    roof_light = vmath(nt, "SCALE", attr.outputs["Color"], scale=math_node(nt, "MULTIPLY", top, 0.15))
    wall_light = vmath(nt, "SCALE", attr.outputs["Color"], scale=0.03)
    emission = vmath(nt, "ADD", vmath(nt, "ADD", window_light, roof_light), wall_light)
    nt.links.new(emission, bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    # Window glass is a bit darker than the wall around it.
    darken = math_node(nt, "SUBTRACT", 1.0, math_node(nt, "MULTIPLY", math_node(nt, "MULTIPLY", win, side), 0.35))
    nt.links.new(vmath(nt, "SCALE", attr.outputs["Color"], scale=darken), bsdf.inputs["Base Color"])
    return mat


def district_material():
    mat, nt, bsdf = new_material("District")
    bsdf.inputs["Roughness"].default_value = 0.9
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "depth"
    col = mix_color(nt, attr.outputs["Fac"], (*srgb_to_linear(NIGHT["dist_a"]), 1.0), (*srgb_to_linear(NIGHT["dist_b"]), 1.0))
    nt.links.new(col, bsdf.inputs["Base Color"])
    return mat


def flat_material(name, hexcolor, rough=1.0):
    mat, nt, bsdf = new_material(name)
    bsdf.inputs["Base Color"].default_value = (*srgb_to_linear(hexcolor), 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    return mat


buildings.data.materials.append(building_material())
if districts:
    districts.data.materials.append(district_material())
ground.data.materials.append(flat_material("Ground", NIGHT["ground"], 0.95))

# ------------------------------------------------------------------ world, lights

world = bpy.data.worlds.new("Night")
scene.world = world
world.use_nodes = True
wnt = world.node_tree
wnt.nodes.clear()
wout = wnt.nodes.new("ShaderNodeOutputWorld")
bg = wnt.nodes.new("ShaderNodeBackground")
tc = wnt.nodes.new("ShaderNodeTexCoord")
sep = wnt.nodes.new("ShaderNodeSeparateXYZ")
wnt.links.new(tc.outputs["Generated"], sep.inputs[0])
ramp = wnt.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].position = 0.0
ramp.color_ramp.elements[0].color = (*srgb_to_linear(NIGHT["horizon"]), 1.0)
ramp.color_ramp.elements[1].position = 0.45
ramp.color_ramp.elements[1].color = (*srgb_to_linear(NIGHT["sky_top"]), 1.0)
wnt.links.new(sep.outputs[2], ramp.inputs["Fac"])
wnt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 1.6
wnt.links.new(bg.outputs["Background"], wout.inputs["Surface"])
world.mist_settings.start = S * 0.8
world.mist_settings.depth = S * 3.0
world.mist_settings.falloff = "QUADRATIC"

moon = bpy.data.lights.new("Moon", "SUN")
moon.energy = 0.55
moon.color = srgb_to_linear("#b8c6ff")
moon.angle = math.radians(3)
moon_obj = bpy.data.objects.new("Moon", moon)
moon_obj.rotation_euler = (math.radians(55), 0, math.radians(35))
scene.collection.objects.link(moon_obj)

# ------------------------------------------------------------------ camera move

tops = by0 + bh
H95 = float(np.percentile(tops, 95)) if len(tops) else 10.0
low = max(S * 0.1, H95 * 1.5)
# Start low among the towers, then rise and pull back to reveal the whole city.
KEYS = [(1.0, 0.58, low), (1.3, 0.56, low * 1.05), (1.65, 0.7, S * 0.3), (2.0, 0.95, S * 0.55), (2.3, 1.25, S * 0.8)]
pts = np.array([[math.cos(a * math.pi) * r * S, -math.sin(a * math.pi) * r * S, h] for a, r, h in KEYS])


def catmull(points, t):
    n = len(points) - 1
    x = min(max(t, 0.0), 1.0) * n
    i = min(int(x), n - 1)
    f = x - i
    p0 = points[max(i - 1, 0)]
    p1, p2 = points[i], points[i + 1]
    p3 = points[min(i + 2, n)]
    return 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f ** 3)


def ease(t):
    c = 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2
    return 0.4 * c + 0.6 * t


frames = max(2, int(round(args.seconds * args.fps)))
path = np.array([catmull(pts, ease(i / (frames - 1))) for i in range(frames)])

# Never fly through a building: lift the camera above anything close to it, then smooth.
bxy = np.stack([bx, -bz], axis=1)
clear_r = S * 0.05
need = np.zeros(frames)
for i, p in enumerate(path):
    dist2 = ((bxy - p[:2]) ** 2).sum(axis=1)
    near = tops[dist2 < clear_r ** 2]
    need[i] = (near.max() + S * 0.025) if len(near) else 0
k = max(1, frames // 20)
need = np.array([need[max(0, i - k):i + k + 1].max() for i in range(frames)])
kernel = np.hanning(2 * k + 3)[1:-1]
kernel /= kernel.sum()
need = np.convolve(np.pad(need, k, mode="edge"), kernel, mode="valid")
path[:, 2] = np.maximum(path[:, 2], need)

cam_data = bpy.data.cameras.new("Camera")
cam_data.sensor_fit = "VERTICAL"
cam_data.angle_y = math.radians(48)
cam_data.clip_start = max(0.1, S / 3000)
cam_data.clip_end = S * 12
cam = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
target = bpy.data.objects.new("CameraTarget", None)
scene.collection.objects.link(target)
track = cam.constraints.new("TRACK_TO")
track.target = target
track.track_axis = "TRACK_NEGATIVE_Z"
track.up_axis = "UP_Y"

for i in range(frames):
    f = i + 1
    cam.location = path[i].tolist()
    cam.keyframe_insert("location", frame=f)
    ahead = path[min(frames - 1, i + max(1, frames // 12))]
    target.location = (ahead[0] * 0.12, ahead[1] * 0.12, H95 * 0.25)
    target.keyframe_insert("location", frame=f)

# ------------------------------------------------------------------ render settings

engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in engines else "BLENDER_EEVEE_NEXT"
scene.eevee.taa_render_samples = args.samples
scene.render.resolution_x = W
scene.render.resolution_y = H_RES
scene.render.resolution_percentage = 100
scene.render.fps = args.fps
scene.frame_start = 1
scene.frame_end = frames
scene.view_settings.view_transform = "AgX"
try:
    scene.view_settings.look = "AgX - Medium High Contrast"
except TypeError:
    pass
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"
scene.render.filepath = os.path.join(OUT, "frames", "")
# Re-running continues an interrupted render instead of starting over.
scene.render.use_overwrite = False
scene.render.use_placeholder = True
bpy.context.view_layer.use_pass_mist = True


def setup_compositor():
    """Mist fades the far city into the horizon color, then bloom makes the windows glow."""
    ng = bpy.data.node_groups.new("CodeCity Compositor", "CompositorNodeTree")
    ng.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    scene.compositing_node_group = ng
    rl = ng.nodes.new("CompositorNodeRLayers")
    try:
        mix = ng.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        fac_in = mix.inputs["Factor"]
        a_in, b_in = [s for s in mix.inputs if s.type == "RGBA"][:2]
        mix_out = [s for s in mix.outputs if s.type == "RGBA"][0]
    except RuntimeError:
        mix = ng.nodes.new("CompositorNodeMixRGB")
        fac_in, a_in, b_in, mix_out = mix.inputs[0], mix.inputs[1], mix.inputs[2], mix.outputs[0]
    ng.links.new(rl.outputs["Image"], a_in)
    b_in.default_value = (*srgb_to_linear(NIGHT["horizon"]), 1.0)
    ng.links.new(rl.outputs["Mist"], fac_in)
    glare = ng.nodes.new("CompositorNodeGlare")
    for value in ("Bloom", "BLOOM"):
        try:
            glare.inputs["Type"].default_value = value
            break
        except (TypeError, ValueError):
            continue
    glare.inputs["Threshold"].default_value = 0.9
    glare.inputs["Strength"].default_value = 0.6
    glare.inputs["Size"].default_value = 0.6
    ng.links.new(mix_out, glare.inputs["Image"])
    out = ng.nodes.new("NodeGroupOutput")
    ng.links.new(glare.outputs["Image"], out.inputs["Image"])


try:
    setup_compositor()
    print("CodeCity: compositor ready (mist + bloom)")
except Exception as exc:  # keep rendering without post effects rather than failing
    print(f"CodeCity: compositor skipped ({exc!r})")

if args.save_blend:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save_blend))

print(f"CodeCity: {len(b)} buildings, {len(d)} districts, {frames} frames at {W}x{H_RES}")
if args.still is not None:
    scene.frame_set(1 + int(round(args.still * (frames - 1))))
    scene.render.filepath = os.path.join(OUT, f"still_{int(args.still * 100):03d}.png")
    bpy.ops.render.render(write_still=True)
    print("CodeCity: wrote", scene.render.filepath)
else:
    bpy.ops.render.render(animation=True)
    print("CodeCity: frames written to", os.path.join(OUT, "frames"))
