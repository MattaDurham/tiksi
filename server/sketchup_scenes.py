"""Tiksi saved views as SketchUp scenes, through the locally installed SketchUp C API.

The SketchUp sync file (sketchup_mirror.py) and the standard scenes the build scripts add
(standard_scenes.py) both write scenes here, and the sync file reads them back here.

A scene Tiksi writes carries a "tiksi" dictionary: { kind: 'view', id, origin, base }. `id` is
the saved view's id, `origin` says who made the scene ('tiksi', or 'sketchup' for one the owner
added in SketchUp that Tiksi has since made a view of) and `base` the values it was written from,
so the browser can tell what SketchUp changed. A view's section cut is a SketchUp section plane
(dictionary { kind: 'view-cut', view }) that only its scene turns on; Tiksi sets the cut only in
scenes it made, so a cut the owner set in SketchUp stays theirs.

Views come in Tiksi's world frame (metres, Y up, plan y = world z); a cut's `normal` points at
what it takes away, the opposite of a SketchUp section plane, whose normal points at what stays.
"""
import ctypes as C
import math

if __package__:
    from .sketchup_convert import Ref, Point, Vector, get_data, set_data, to_ref, to_skp, from_skp, read_scenes
else:
    from sketchup_convert import Ref, Point, Vector, get_data, set_data, to_ref, to_skp, from_skp, read_scenes

FLAG_USE_SECTION_PLANES = 0x0040
MAX_VIEWS = 100


class Plane(C.Structure): _fields_ = [('a', C.c_double), ('b', C.c_double), ('c', C.c_double), ('d', C.c_double)]


def skp_vector(v):
    """World direction -> SketchUp direction (no scaling)."""
    return [v[0], -v[2], v[1]]


def world_vector(v):
    return [v[0], v[2], -v[1]]


def model_scenes(api, model):
    count = C.c_size_t(); api.call('SUModelGetNumScenes', model, C.byref(count))
    if not count.value: return []
    scenes = (Ref * count.value)(); api.call('SUModelGetScenes', model, count, scenes, C.byref(count))
    return list(scenes[:count.value])


def model_layers(api, model):
    count = C.c_size_t(); api.call('SUModelGetNumLayers', model, C.byref(count))
    out = {}
    if count.value:
        refs = (Ref * count.value)(); api.call('SUModelGetLayers', model, count, refs, C.byref(count))
        for ref in refs[:count.value]: out.setdefault(api.text('SULayerGetName', ref), ref)
    return out


def scene_layers(api, scene):
    count = C.c_size_t(); api.call('SUSceneGetNumLayers', scene, C.byref(count), optional=True)
    if not count.value: return []
    refs = (Ref * count.value)(); api.call('SUSceneGetLayers', scene, count, refs, C.byref(count))
    return list(refs[:count.value])


def section_planes(api, entities):
    count = C.c_size_t(); api.call('SUEntitiesGetNumSectionPlanes', entities, C.byref(count))
    if not count.value: return []
    refs = (Ref * count.value)(); api.call('SUEntitiesGetSectionPlanes', entities, count, refs, C.byref(count))
    return list(refs[:count.value])


def scene_cut(api, scene):
    """The cut a scene turns on, as { point, normal } in world metres (normal: what it takes away)."""
    if not hasattr(api.lib, 'SUSceneGetNumActiveSectionPlanes'): return None
    count = C.c_size_t()
    if api.call('SUSceneGetNumActiveSectionPlanes', scene, C.byref(count), optional=True) or not count.value: return None
    refs = (Ref * count.value)(); api.call('SUSceneGetActiveSectionPlanes', scene, count, refs, C.byref(count))
    p = Plane(); api.call('SUSectionPlaneGetPlane', refs[0], C.byref(p))
    k = math.sqrt(p.a * p.a + p.b * p.b + p.c * p.c)
    if k < 1e-12: return None
    foot = [-p.d * p.a / (k * k), -p.d * p.b / (k * k), -p.d * p.c / (k * k)]
    return {'point': [round(v, 6) for v in from_skp(foot)], 'normal': [round(-v / k, 6) for v in world_vector([p.a, p.b, p.c])]}


def read_views(api, model):
    """Every scene, in SketchUp's order: read_scenes' record (name, camera in world metres, hidden
    tag names) with the Tiksi id, origin and written values when Tiksi wrote it, and its cut."""
    records = read_scenes(api, model)
    out = []
    for record, scene in zip(records, model_scenes(api, model)):
        data = get_data(api, to_ref(api, 'SUSceneToEntity', scene)) or {}
        if data.get('kind') == 'view' and isinstance(data.get('id'), str):
            record['id'] = data['id']
            record['origin'] = 'sketchup' if data.get('origin') == 'sketchup' else 'tiksi'
            if isinstance(data.get('base'), dict): record['base'] = data['base']
        cut = scene_cut(api, scene)
        if cut: record['cut'] = cut
        out.append(record)
    return out


def scene_camera(api, scene, camera):
    """Set a scene's camera ({ eye, target, up, perspective, fov | height }, world metres)."""
    cam = Ref(); api.call('SUCameraCreate', C.byref(cam))
    try:
        up = Vector(*skp_vector(camera.get('up') or [0, 1, 0]))
        eye, target = to_skp(camera['eye']), to_skp(camera['target'])
        api.call('SUCameraSetOrientation', cam, C.byref(eye), C.byref(target), C.byref(up))
        perspective = camera.get('perspective') is not False
        api.call('SUCameraSetPerspective', cam, C.c_bool(perspective))
        if perspective:
            api.call('SUCameraSetFOVIsHeight', cam, C.c_bool(True), optional=True)
            api.call('SUCameraSetPerspectiveFrustumFOV', cam, C.c_double(float(camera.get('fov') or 50)))
        else:
            api.call('SUCameraSetOrthographicFrustumHeight', cam, C.c_double(max(float(camera.get('height') or 0), 0.01) / 0.0254))
        api.call('SUSceneSetCamera', scene, cam)
    finally:
        api.call('SUCameraRelease', C.byref(cam))
    api.call('SUSceneSetUseCamera', scene, C.c_bool(True))


def add_cut(api, entities, cut, view_id, name):
    """A SketchUp section plane for a Tiksi cut; it stays off until a scene turns it on."""
    n = [-v for v in skp_vector(cut['normal'])]
    k = math.sqrt(sum(v * v for v in n))
    if k < 1e-9: return None
    n = [v / k for v in n]
    p = to_skp(cut['point'])
    plane = Plane(n[0], n[1], n[2], -(n[0] * p.x + n[1] * p.y + n[2] * p.z))
    ref = Ref(); api.call('SUSectionPlaneCreate', C.byref(ref))
    api.call('SUSectionPlaneSetPlane', ref, C.byref(plane))
    api.call('SUEntitiesAddSectionPlanes', entities, C.c_size_t(1), (Ref * 1)(ref))
    api.call('SUSectionPlaneSetName', ref, ('Tiksi: ' + name)[:120].encode('utf-8'), optional=True)
    set_data(api, to_ref(api, 'SUSectionPlaneToEntity', ref), {'kind': 'view-cut', 'view': view_id})
    return ref


def write_views(api, model, views, known, warnings, owns=lambda view_id: True):
    """Make the model's Tiksi scenes match `views` (sketchup-mirror.js / mirror-views.js
    viewScene): update the scene of each view in place, tag a scene the owner added that a view
    was made from, add the rest at the end, and remove the scenes of views Tiksi deleted.
    `known` are the tag names Tiksi owns: a scene's other hidden tags stay as the owner set them.
    Scenes Tiksi never wrote are left alone, and so are those whose id `owns` turns down (the
    standard scenes a build script adds own only theirs)."""
    entities = api.ref('SUModelGetEntities', model)
    views = [v for v in views if isinstance(v, dict) and isinstance(v.get('id'), str) and isinstance(v.get('camera'), dict)][:MAX_VIEWS]
    by_id, untagged = {}, {}
    for scene in model_scenes(api, model):
        data = get_data(api, to_ref(api, 'SUSceneToEntity', scene)) or {}
        if data.get('kind') == 'view' and isinstance(data.get('id'), str) and data['id'] not in by_id:
            by_id[data['id']] = (scene, data)
        else:
            untagged.setdefault(api.text('SUSceneGetName', scene), scene)
    def own_cut(p):
        d = get_data(api, to_ref(api, 'SUSectionPlaneToEntity', p)) or {}
        return d.get('kind') == 'view-cut' and owns(str(d.get('view', '')))
    old = [to_ref(api, 'SUSectionPlaneToEntity', p) for p in section_planes(api, entities) if own_cut(p)]
    wanted = {v['id'] for v in views}
    gone = [scene for vid, (scene, _) in by_id.items() if vid not in wanted and owns(vid)]
    if gone:
        api.call('SUModelRemoveScenes', model, C.c_size_t(len(gone)), (Ref * len(gone))(*gone))
        by_id = {vid: item for vid, item in by_id.items() if vid in wanted or not owns(vid)}
    if old:
        api.call('SUEntitiesErase', entities, C.c_size_t(len(old)), (Ref * len(old))(*old))
    layers = model_layers(api, model)
    can_cut = hasattr(api.lib, 'SUSceneUpdate')
    if not can_cut and any(v.get('cut') for v in views):
        warnings.append('This SketchUp is older than 2025: the views\' section cuts are not set in their scenes')
    for view in views:
        scene, data = by_id.get(view['id'], (None, None))
        origin = 'sketchup' if data and data.get('origin') == 'sketchup' else 'tiksi'
        if scene is None and isinstance(view.get('scene'), str) and view['scene'] in untagged:
            scene, origin = untagged.pop(view['scene']), 'sketchup'
        if scene is None:
            scene = Ref(); api.call('SUSceneCreate', C.byref(scene))
            index = C.c_int(); api.call('SUModelAddScene', model, C.c_int(-1), scene, C.byref(index))
            origin = 'tiksi'
        # Scene names are unique in SketchUp: a second view of the same name gets a number.
        others = {api.text('SUSceneGetName', s) for s in model_scenes(api, model) if s.ptr != scene.ptr}
        base_name = str(view.get('name') or 'View')[:200]
        name, k = base_name, 2
        while name in others: name, k = f'{base_name} ({k})', k + 1
        api.call('SUSceneSetName', scene, name.encode('utf-8'))
        scene_camera(api, scene, view['camera'])
        api.call('SUSceneSetUseHiddenLayers', scene, C.c_bool(True))
        for layer in scene_layers(api, scene):
            if api.text('SULayerGetName', layer) in known: api.call('SUSceneRemoveLayer', scene, layer)
        for tag in view.get('hidden') or []:
            if tag in layers: api.call('SUSceneAddLayer', scene, layers[tag], optional=True)
        if origin == 'tiksi' and can_cut:
            plane = add_cut(api, entities, view['cut'], view['id'], name) if view.get('cut') else None
            api.call('SUSceneSetUseSectionPlanes', scene, C.c_bool(True))
            api.call('SUEntitiesSetActiveSectionPlane', entities, plane if plane else Ref(), optional=True)
            api.call('SUSceneUpdate', scene, C.c_uint(FLAG_USE_SECTION_PLANES))
        base = dict(view.get('base') or {}, name=name)
        set_data(api, to_ref(api, 'SUSceneToEntity', scene), {'kind': 'view', 'id': view['id'], 'origin': origin, 'base': base})
    # The model opens uncut; each scene turns its own cut on.
    if can_cut: api.call('SUEntitiesSetActiveSectionPlane', entities, Ref(), optional=True)
    return len(views)
