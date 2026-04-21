"""
Render a BVH animation to video frames using Blender's built-in BVH importer.

Usage:
    blender -b --python render_bvh.py -- \
        --input animation.bvh \
        --output_dir frames/ \
        --resolution 720x1280 \
        --camera 3quarter \
        --fps 30
"""

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector


CAMERA_PRESETS = {
    # (base_distance_factor, elevation_deg, azimuth_deg)
    "front":    (1.8,  10,   0),
    "side":     (1.8,  10,  90),
    "3quarter": (2.0,  15,  35),
    "top":      (2.5,  75,   0),
    "overlay":  None,  # Special: orthographic front, handled separately
}


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for block in bpy.data.meshes:
        if not block.users:
            bpy.data.meshes.remove(block)
    for block in bpy.data.armatures:
        if not block.users:
            bpy.data.armatures.remove(block)


def import_bvh(filepath, fps=30):
    """Import BVH file and return the armature object."""
    bpy.ops.import_anim.bvh(
        filepath=filepath,
        use_fps_scale=True,
        update_scene_fps=True,
        global_scale=0.01,  # BVH offsets in cm → Blender meters
    )
    for obj in bpy.context.scene.objects:
        if obj.type == 'ARMATURE':
            return obj
    return None


def create_bone_geometry(armature):
    """Create a stick-figure mesh with edges between joints, animated via hooks.

    Creates empties parented to each bone head (for position tracking),
    then builds a single mesh with vertices at joint positions connected
    by edges. HOOK modifiers on each vertex track the corresponding empty,
    so the mesh always shows correct joint-to-joint connections.

    Also adds small spheres at each joint for visual reference.
    """
    bone_mat = bpy.data.materials.new("BoneMaterial")
    bone_mat.diffuse_color = (0.2, 0.8, 1.0, 1.0)  # Cyan

    # Collect bone names in order and create empties
    bone_names = [bone.name for bone in armature.data.bones]
    bone_empties = {}

    for bone in armature.data.bones:
        empty = bpy.data.objects.new(f"empty_{bone.name}", None)
        empty.empty_display_size = 0.001
        empty.empty_display_type = 'PLAIN_AXES'
        bpy.context.collection.objects.link(empty)
        empty.parent = armature
        empty.parent_type = 'BONE'
        empty.parent_bone = bone.name
        empty.location = (0, 0, 0)
        bone_empties[bone.name] = empty

    # Build the skeleton connections as edges.
    # Only draw the main stick-figure connections (skip intermediate bones
    # like Spine1, LeftShoulder that create visual clutter).
    STICK_CONNECTIONS = [
        # Spine (single line from hips to shoulder center)
        ("Hips", "Spine2"),
        # Head
        ("Spine2", "Head"),
        # Arms (shoulder → elbow → wrist)
        ("Spine2", "LeftArm"),
        ("LeftArm", "LeftForeArm"),
        ("LeftForeArm", "LeftHand"),
        ("Spine2", "RightArm"),
        ("RightArm", "RightForeArm"),
        ("RightForeArm", "RightHand"),
        # Legs (hip → knee → ankle)
        ("Hips", "LeftUpLeg"),
        ("LeftUpLeg", "LeftLeg"),
        ("LeftLeg", "LeftFoot"),
        ("Hips", "RightUpLeg"),
        ("RightUpLeg", "RightLeg"),
        ("RightLeg", "RightFoot"),
    ]

    # Filter to only bones that exist in the armature
    bone_set = set(bone_names)
    connections = [(a, b) for a, b in STICK_CONNECTIONS
                   if a in bone_set and b in bone_set]

    # Collect unique vertex names and build index map
    vert_names = []
    vert_idx = {}
    for a, b in connections:
        for name in (a, b):
            if name not in vert_idx:
                vert_idx[name] = len(vert_names)
                vert_names.append(name)

    # Evaluate frame 1 to get initial vertex positions
    scene = bpy.context.scene
    scene.frame_set(scene.frame_start)
    bpy.context.view_layer.update()

    verts = []
    for name in vert_names:
        bone = armature.pose.bones[name]
        head_world = armature.matrix_world @ bone.head
        verts.append((head_world.x, head_world.y, head_world.z))

    edges = [(vert_idx[a], vert_idx[b]) for a, b in connections]

    # Create the stick-figure mesh
    mesh = bpy.data.meshes.new("StickFigure")
    mesh.from_pydata(verts, edges, [])
    mesh.update()

    stick_obj = bpy.data.objects.new("StickFigure", mesh)
    bpy.context.collection.objects.link(stick_obj)

    # Give it thickness with a skin modifier + subdivision for smooth joints
    skin_mod = stick_obj.modifiers.new("Skin", 'SKIN')
    skin_mod.use_smooth_shade = True

    sub_mod = stick_obj.modifiers.new("Subdiv", 'SUBSURF')
    sub_mod.levels = 1
    sub_mod.render_levels = 1

    # Set skin radius for all vertices
    bone_radius = 0.015
    for v in stick_obj.data.skin_vertices[0].data:
        v.radius = (bone_radius, bone_radius)

    # Apply material
    stick_obj.data.materials.append(bone_mat)

    # Add HOOK modifier per vertex → each vertex follows its joint empty
    for i, name in enumerate(vert_names):
        empty = bone_empties[name]

        # Create a vertex group for this vertex
        vg = stick_obj.vertex_groups.new(name=f"hook_{name}")
        vg.add([i], 1.0, 'REPLACE')

        hook = stick_obj.modifiers.new(f"hook_{name}", 'HOOK')
        hook.object = empty
        hook.vertex_group = vg.name


def add_ground_plane(center, size):
    """Add a subtle ground plane for spatial reference, sized to the animation."""
    plane_size = max(size * 3, 2.0)
    bpy.ops.mesh.primitive_plane_add(size=plane_size, location=(center[0], center[1], 0))
    plane = bpy.context.active_object
    mat = bpy.data.materials.new("Ground")
    mat.diffuse_color = (0.15, 0.15, 0.18, 1.0)
    plane.data.materials.append(mat)

    # Grid lines for spatial reference
    bpy.ops.mesh.primitive_grid_add(
        x_subdivisions=10, y_subdivisions=10,
        size=plane_size,
        location=(center[0], center[1], 0.001),
    )
    grid = bpy.context.active_object
    grid_mat = bpy.data.materials.new("Grid")
    grid_mat.diffuse_color = (0.25, 0.25, 0.3, 1.0)
    grid.data.materials.append(grid_mat)
    grid.display_type = 'WIRE'


def get_armature_bounds(armature, sample_frames=10):
    """Sample frames to get the bounding box of the animation."""
    scene = bpy.context.scene
    start = scene.frame_start
    end = scene.frame_end
    step = max(1, (end - start) // sample_frames)

    mins = [float('inf')] * 3
    maxs = [float('-inf')] * 3

    for frame in range(start, end + 1, step):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        for bone in armature.pose.bones:
            head = armature.matrix_world @ bone.head
            tail = armature.matrix_world @ bone.tail
            for co in [head, tail]:
                for i in range(3):
                    mins[i] = min(mins[i], co[i])
                    maxs[i] = max(maxs[i], co[i])

    scene.frame_set(start)

    if mins[0] == float('inf'):
        return (0, 0, 0.5), 1.0

    center = tuple((mins[i] + maxs[i]) / 2 for i in range(3))
    size = max(maxs[i] - mins[i] for i in range(3))
    return center, max(size, 0.3)


def setup_camera(preset_name, target_center, scene_size):
    if preset_name == "overlay":
        return setup_overlay_camera(target_center, scene_size)

    dist_factor, elev_deg, azim_deg = CAMERA_PRESETS.get(preset_name, CAMERA_PRESETS["3quarter"])
    # Scale distance to fit the scene with some padding
    distance = dist_factor * max(scene_size, 0.5)

    elev = math.radians(elev_deg)
    azim = math.radians(azim_deg)
    x = distance * math.cos(elev) * math.sin(azim) + target_center[0]
    y = -distance * math.cos(elev) * math.cos(azim) + target_center[1]
    z = distance * math.sin(elev) + target_center[2]

    cam_data = bpy.data.cameras.new("Camera")
    cam_data.lens = 35  # Wider lens for better framing
    cam_data.clip_start = 0.01
    cam_data.clip_end = 200
    cam_obj = bpy.data.objects.new("Camera", cam_data)
    bpy.context.collection.objects.link(cam_obj)
    cam_obj.location = (x, y, z)
    direction = Vector(target_center) - cam_obj.location
    cam_obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = cam_obj

    print(f"Camera at ({x:.2f}, {y:.2f}, {z:.2f}), distance={distance:.2f}, lens=35mm")


def setup_overlay_camera(target_center, scene_size):
    """Orthographic front-facing camera for video overlay compositing.

    The BVH coordinate system maps from normalized image-space landmarks
    using scale=170cm for BOTH x and y:
      world_x = (landmark_x - 0.5) * 170   (cm, right positive)
      world_y = -(landmark_y - 0.5) * 170   (cm, up positive)

    This creates a SQUARE world (170x170cm) from a RECTANGULAR video
    (e.g., 720x1280). The ortho camera + pixel_aspect_ratio compensates:
    - ortho_scale = 1.7m (covering the full 170cm range)
    - pixel_aspect_x scaled by height/width so horizontal 1.7m maps to
      the video width correctly despite the different aspect ratio.
    """
    WORLD_SCALE = 1.70  # 170cm * 0.01 (global_scale)

    scene = bpy.context.scene
    w = scene.render.resolution_x
    h = scene.render.resolution_y

    # Compensate for square-world-from-rectangular-video distortion:
    # The mapping uses same scale for X and Y, but the video isn't square.
    # pixel_aspect_x = h/w makes the ortho camera's horizontal extent
    # cover the full 1.7m world X range despite the non-square resolution.
    scene.render.pixel_aspect_x = h / w  # e.g., 1280/720 = 1.778
    scene.render.pixel_aspect_y = 1.0

    cam_data = bpy.data.cameras.new("OverlayCamera")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = WORLD_SCALE
    cam_data.clip_start = 0.01
    cam_data.clip_end = 200

    cam_obj = bpy.data.objects.new("OverlayCamera", cam_data)
    bpy.context.collection.objects.link(cam_obj)

    cam_obj.location = (0, -5.0, 0)
    cam_obj.rotation_euler = (math.radians(90), 0, 0)

    bpy.context.scene.camera = cam_obj

    print(f"Overlay camera: ortho_scale={WORLD_SCALE:.2f}m, "
          f"pixel_aspect={h/w:.3f}, "
          f"skeleton center=({target_center[0]:.3f}, {target_center[2]:.3f})")


def setup_lighting(center, size):
    scale = max(size, 1.0)
    for name, offset, energy, ltype, color in [
        ("Key",  (1.5, -1.5, 2.0), 200, 'AREA',  (1, 0.95, 0.9)),
        ("Fill", (-1.5, -0.5, 1.5), 80, 'AREA',  (0.85, 0.9, 1)),
        ("Rim",  (0, 1.5, 1.5),  120, 'POINT', (1, 1, 1)),
    ]:
        ld = bpy.data.lights.new(name=name, type=ltype)
        ld.energy = energy * scale
        ld.color = color
        if ltype == 'AREA':
            ld.size = 2.0 * scale
        loc = (
            center[0] + offset[0] * scale,
            center[1] + offset[1] * scale,
            center[2] + offset[2] * scale,
        )
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        bpy.context.collection.objects.link(lo)


def setup_render(width, height, transparent=False):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100

    if transparent:
        scene.render.film_transparent = True
        scene.render.image_settings.file_format = 'PNG'
        scene.render.image_settings.color_mode = 'RGBA'
        scene.render.image_settings.compression = 15
        # Workbench shading — transparent background
        scene.display.shading.light = 'STUDIO'
        scene.display.shading.color_type = 'MATERIAL'
        scene.display.shading.background_type = 'THEME'
        scene.display.shading.background_color = (0, 0, 0)
    else:
        scene.render.film_transparent = False
        scene.render.image_settings.file_format = 'JPEG'
        scene.render.image_settings.quality = 90
        # Workbench shading — solid mode with object colors
        scene.display.shading.light = 'STUDIO'
        scene.display.shading.color_type = 'MATERIAL'
        scene.display.shading.background_type = 'THEME'
        scene.display.shading.background_color = (0.05, 0.05, 0.08)

    world = bpy.data.worlds.new("World")
    scene.world = world


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Input BVH file")
    parser.add_argument("--output_dir", required=True, help="Output directory for frames")
    parser.add_argument("--resolution", default="720x1280", help="WxH resolution")
    parser.add_argument("--camera", default="3quarter", choices=list(CAMERA_PRESETS.keys()))
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--overlay", action="store_true",
                        help="Overlay mode: transparent PNG, front ortho camera (overrides --camera)")
    return parser.parse_args(argv)


def main():
    args = parse_args()
    w, h = [int(x) for x in args.resolution.split("x")]
    is_overlay = args.overlay
    camera_mode = "overlay" if is_overlay else args.camera

    mode_str = "OVERLAY" if is_overlay else camera_mode.upper()
    print(f"BVH Render [{mode_str}]: {args.input} → {args.output_dir} @ {w}x{h}")

    clear_scene()

    armature = import_bvh(args.input, args.fps)
    if not armature:
        print("ERROR: No armature found after BVH import")
        sys.exit(1)

    print(f"Imported armature: {armature.name} ({len(armature.data.bones)} bones)")

    # Set animation range first (needed for bounds sampling)
    if armature.animation_data and armature.animation_data.action:
        action = armature.animation_data.action
        start = int(action.frame_range[0])
        end = int(action.frame_range[1])
        bpy.context.scene.frame_start = start
        bpy.context.scene.frame_end = end
        bpy.context.scene.render.fps = args.fps
        print(f"Animation: frames {start}-{end} ({end - start + 1} frames @ {args.fps}fps)")
    else:
        print("WARNING: No animation data found")

    # Get bounds before adding extra geometry
    center, size = get_armature_bounds(armature)
    print(f"Scene center: ({center[0]:.3f}, {center[1]:.3f}, {center[2]:.3f}), size: {size:.2f}m")

    # Create visible geometry attached to bones
    create_bone_geometry(armature)

    # Hide the armature itself (we have mesh geometry now)
    armature.hide_render = True

    if not is_overlay:
        add_ground_plane(center, size)

    setup_render(w, h, transparent=is_overlay)
    setup_lighting(center, size)
    setup_camera(camera_mode, center, size)

    os.makedirs(args.output_dir, exist_ok=True)
    bpy.context.scene.render.filepath = os.path.join(args.output_dir, "frame_")

    bpy.ops.render.render(animation=True)

    ext = "png" if is_overlay else "jpg"
    frame_count = len([f for f in os.listdir(args.output_dir) if f.startswith("frame_") and f.endswith(ext)])
    print(f"Rendered {frame_count} frames ({ext.upper()}) to {args.output_dir}")


if __name__ == "__main__":
    main()
