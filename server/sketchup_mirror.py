"""SketchUp mirror of a Tiksi property, through the locally installed SketchUp C API.

`write` turns the browser's mirror spec into tagged SketchUp groups: one group per wall
(an extruded face with its openings cut), one nested group per opening, one group per room
floor, one group per fixture (a nested group per prism), one tag per level and the level's
plan underlay as an image. Every Tiksi entity
carries a "tiksi" attribute dictionary with its id and the values it was written from.
Faces wear the spec's finishes as SketchUp materials named "Tiksi: <name>", created once and
reused by name, so rewrites repaint them instead of piling up copies. Writing over an
existing mirror replaces only the tagged entities, so geometry drawn in SketchUp survives.

`read` reports every tagged entity as it is now (from its placement and bounds) next to the
values it was written from. The browser decides what changed on which side.

Each call is a separate process working on files in one job folder (see model_conversion).
"""
import ctypes as C
import json
import math
import os
from pathlib import Path
import sys

if __package__:
    from .sketchup_convert import API, Ref, Point, Transform, Color
else:
    from sketchup_convert import API, Ref, Point, Transform, Color

FORMAT = 'tiksi-sketchup-mirror'
VERSION = 1
DICT = b'tiksi'
KEY = b'data'
IN = 1 / 0.0254          # inches per metre
EPS = 1e-6


class Box(C.Structure): _fields_ = [('min', Point), ('max', Point)]


# ---------- small helpers ----------

def to_ref(api, name, ref):
    fn = getattr(api.lib, name); fn.restype = Ref; fn.argtypes = [Ref]
    return fn(ref)


def matrix(t):
    return list(t.values)


def apply(m, p):
    x, y, z = p
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]


def multiply(a, b):
    return [sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4)) for c in range(4) for r in range(4)]


def dist(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def frame(origin, xdir):
    """Column-major transform: x along xdir (horizontal), y its left perpendicular, z up."""
    ydir = (-xdir[1], xdir[0])
    return [xdir[0], xdir[1], 0, 0, ydir[0], ydir[1], 0, 0, 0, 0, 1, 0, origin[0], origin[1], origin[2], 1]


def translation(x, y, z):
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]


def plan_to_skp(x, y, z=0.0):
    return [x * IN, -y * IN, z * IN]


def skp_to_plan(p):
    return [p[0] / IN, -p[1] / IN]


def r6(v):
    return round(float(v), 6)


def get_data(api, entity):
    """The JSON stored in the entity's "tiksi" dictionary, or None when it has none."""
    count = C.c_size_t()
    api.call('SUEntityGetNumAttributeDictionaries', entity, C.byref(count))
    if not count.value:
        return None
    dicts = (Ref * count.value)()
    api.call('SUEntityGetAttributeDictionaries', entity, count, dicts, C.byref(count))
    for d in dicts[:count.value]:
        if api.text('SUAttributeDictionaryGetName', d) != DICT.decode():
            continue
        value = api.ref('SUTypedValueCreate')
        try:
            if api.call('SUAttributeDictionaryGetValue', d, KEY, C.byref(value), optional=True):
                return {}
            try:
                parsed = json.loads(api.text('SUTypedValueGetString', value))
            except ValueError:
                return {}
            return parsed if isinstance(parsed, dict) else {}
        finally:
            api.call('SUTypedValueRelease', C.byref(value))
    return None


def set_data(api, entity, data):
    d = Ref()
    api.call('SUAttributeDictionaryCreate', C.byref(d), DICT)
    value = api.ref('SUTypedValueCreate')
    try:
        api.call('SUTypedValueSetString', value, json.dumps(data, separators=(',', ':')).encode('utf-8'))
        api.call('SUAttributeDictionarySetValue', d, KEY, value)
    finally:
        api.call('SUTypedValueRelease', C.byref(value))
    api.call('SUEntityAddAttributeDictionary', entity, d)


def set_model_data(api, model, data):
    d = Ref()
    api.call('SUModelGetAttributeDictionary', model, DICT, C.byref(d))
    value = api.ref('SUTypedValueCreate')
    try:
        api.call('SUTypedValueSetString', value, json.dumps(data, separators=(',', ':')).encode('utf-8'))
        api.call('SUAttributeDictionarySetValue', d, KEY, value)
    finally:
        api.call('SUTypedValueRelease', C.byref(value))


def get_model_data(api, model):
    d = Ref()
    if api.call('SUModelGetAttributeDictionary', model, DICT, C.byref(d), optional=True):
        return None
    value = api.ref('SUTypedValueCreate')
    try:
        if api.call('SUAttributeDictionaryGetValue', d, KEY, C.byref(value), optional=True):
            return None
        try:
            parsed = json.loads(api.text('SUTypedValueGetString', value))
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    finally:
        api.call('SUTypedValueRelease', C.byref(value))


def new_group(api, entities, name, transform):
    group = Ref()
    api.call('SUGroupCreate', C.byref(group))
    api.call('SUEntitiesAddGroup', entities, group)
    api.call('SUGroupSetName', group, name.encode('utf-8'))
    t = Transform(); t.values[:] = transform
    api.call('SUGroupSetTransform', group, C.byref(t))
    return group


def fill(api, entities, points, faces):
    """faces: [(outer_indices, [inner_indices, ...]), ...] over `points` (inches)."""
    gi = Ref()
    api.call('SUGeometryInputCreate', C.byref(gi))
    try:
        verts = (Point * len(points))(*(Point(*p) for p in points))
        api.call('SUGeometryInputSetVertices', gi, C.c_size_t(len(points)), verts)
        for outer, inners in faces:
            loop = api.ref('SULoopInputCreate')
            for i in outer:
                api.call('SULoopInputAddVertexIndex', loop, C.c_size_t(i))
            index = C.c_size_t()
            api.call('SUGeometryInputAddFace', gi, C.byref(loop), C.byref(index))
            for inner in inners:
                hole = api.ref('SULoopInputCreate')
                for i in inner:
                    api.call('SULoopInputAddVertexIndex', hole, C.c_size_t(i))
                api.call('SUGeometryInputFaceAddInnerLoop', gi, index, C.byref(hole))
        api.call('SUEntitiesFill', entities, gi, C.c_bool(True))
    finally:
        api.call('SUGeometryInputRelease', C.byref(gi))


def bounds(api, entities):
    box = Box()
    api.call('SUEntitiesGetBoundingBox', entities, C.byref(box))
    return [box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]


def set_layer(api, group, layer):
    if layer and layer.ptr:
        api.call('SUDrawingElementSetLayer', to_ref(api, 'SUGroupToDrawingElement', group), layer)


# ---------- finishes ----------

MATERIAL_PREFIX = 'Tiksi: '
COLORED = 0              # SUMaterialType_Colored


def material_name(spec):
    return MATERIAL_PREFIX + str(spec.get('name') or spec.get('id') or 'Default')


def hex_color(value):
    text = str(value or '')
    if len(text) != 7 or text[0] != '#':
        return None
    try:
        return tuple(int(text[i:i + 2], 16) for i in (1, 3, 5))
    except ValueError:
        return None


class Materials:
    """The model's materials by name. A Tiksi finish reuses its "Tiksi: <name>" material and
    takes the spec's colour, unless someone gave that material a texture in SketchUp."""

    def __init__(self, api, model, warnings):
        self.api, self.model, self.warnings, self.by_name, self.done = api, model, warnings, {}, set()
        count = C.c_size_t()
        api.call('SUModelGetNumMaterials', model, C.byref(count))
        if count.value:
            refs = (Ref * count.value)()
            api.call('SUModelGetMaterials', model, count, refs, C.byref(count))
            for ref in refs[:count.value]:
                self.by_name.setdefault(api.text('SUMaterialGetName', ref), ref)

    def get(self, spec):
        if not isinstance(spec, dict):
            return None
        api, name = self.api, material_name(spec)
        mat = self.by_name.get(name)
        if name in self.done:
            return mat
        self.done.add(name)
        rgb = hex_color(spec.get('color'))
        if rgb is None:
            self.warnings.append(name + ' has no usable colour (' + str(spec.get('color')) + '); left at the SketchUp default')
        if mat is None:
            mat = Ref()
            api.call('SUMaterialCreate', C.byref(mat))
            api.call('SUMaterialSetName', mat, name.encode('utf-8'))
            if rgb:
                api.call('SUMaterialSetColor', mat, C.byref(Color(*rgb, 255)))
            api.call('SUModelAddMaterials', self.model, C.c_size_t(1), (Ref * 1)(mat))
            self.by_name[name] = mat
        elif rgb:
            kind = C.c_int(COLORED)
            api.call('SUMaterialGetType', mat, C.byref(kind), optional=True)
            if kind.value == COLORED:
                api.call('SUMaterialSetColor', mat, C.byref(Color(*rgb, 255)))
        return mat


def paint(api, face, mat, outward=None):
    """Paint the side of `face` that looks along `outward` (both sides when None)."""
    if not mat or not mat.ptr:
        return
    if outward is None:
        api.call('SUFaceSetFrontMaterial', face, mat); api.call('SUFaceSetBackMaterial', face, mat)
        return
    n = Point()
    api.call('SUFaceGetNormal', face, C.byref(n))
    front = n.x * outward[0] + n.y * outward[1] + n.z * outward[2] >= 0
    api.call('SUFaceSetFrontMaterial' if front else 'SUFaceSetBackMaterial', face, mat)


def paint_wall(api, entities, th, faces, materials):
    """Wall faces by side: local y = -th/2 is the spec's `pos` face, +th/2 `neg`, the rest `other`."""
    pos, neg, other = (materials.get(faces.get(k)) for k in ('pos', 'neg', 'other'))
    half, tol = th / 2 * IN, 1e-3
    for face in api.collection(entities, 'Faces'):
        ys = [p[1] for p in face_ring(api, face)]
        if all(abs(y + half) < tol for y in ys):
            paint(api, face, pos, (0, -1, 0))
        elif all(abs(y - half) < tol for y in ys):
            paint(api, face, neg, (0, 1, 0))
        else:
            paint(api, face, other)      # ends, top and reveals: either side may show


# ---------- wall solids ----------

def wall_loops(L, H, holes):
    """Elevation loops of a wall [0,L] x [0,H] in (s, v), split at full-height openings.

    Returns [(outer, [inner, ...]), ...]; outer counter-clockwise seen from local -y,
    inner loops clockwise. Holes are {s0, s1, v0, v1} rectangles, already clamped and
    non-overlapping (Tiksi's openingSpans)."""
    tol = 1e-4
    holes = sorted(({'s0': max(0.0, h['s0']), 's1': min(L, h['s1']), 'v0': max(0.0, h['v0']), 'v1': min(H, h['v1'])} for h in holes), key=lambda h: h['s0'])
    holes = [h for h in holes if h['s1'] - h['s0'] > tol and h['v1'] - h['v0'] > tol]
    segments, start = [], 0.0
    for h in holes:
        if h['v0'] <= tol and h['v1'] >= H - tol:
            if h['s0'] - start > tol:
                segments.append((start, h['s0']))
            start = h['s1']
    if L - start > tol:
        segments.append((start, L))
    out = []
    for a, b in segments:
        inside = [h for h in holes if h['s0'] >= a - tol and h['s1'] <= b + tol and not (h['v0'] <= tol and h['v1'] >= H - tol)]
        outer = [(a, 0.0)]
        for h in inside:
            if h['v0'] <= tol:
                outer += [(h['s0'], 0.0), (h['s0'], h['v1']), (h['s1'], h['v1']), (h['s1'], 0.0)]
        outer += [(b, 0.0), (b, H)]
        for h in reversed(inside):
            if h['v1'] >= H - tol:
                outer += [(h['s1'], H), (h['s1'], h['v0']), (h['s0'], h['v0']), (h['s0'], H)]
        outer.append((a, H))
        clean = []
        for p in outer:
            if not clean or abs(clean[-1][0] - p[0]) > tol or abs(clean[-1][1] - p[1]) > tol:
                clean.append(p)
        if len(clean) > 1 and abs(clean[0][0] - clean[-1][0]) <= tol and abs(clean[0][1] - clean[-1][1]) <= tol:
            clean.pop()
        inners = [[(h['s0'], h['v0']), (h['s0'], h['v1']), (h['s1'], h['v1']), (h['s1'], h['v0'])]
                  for h in inside if h['v0'] > tol and h['v1'] < H - tol]
        out.append((clean, inners))
    return out


def extrude_wall(loops, th):
    """Points and faces (inches) of the wall solid: front at y=-th/2, back at y=+th/2."""
    points, faces = [], []

    def add(loop, y):
        base = len(points)
        points.extend([s * IN, y * IN, v * IN] for s, v in loop)
        return list(range(base, base + len(loop)))

    for outer, inners in loops:
        f_outer, b_outer = add(outer, -th / 2), add(outer, th / 2)
        f_inner = [add(i, -th / 2) for i in inners]
        b_inner = [add(i, th / 2) for i in inners]
        faces.append((f_outer, f_inner))
        faces.append((list(reversed(b_outer)), [list(reversed(i)) for i in b_inner]))
        for f, b in [(f_outer, b_outer)] + list(zip(f_inner, b_inner)):
            n = len(f)
            for k in range(n):
                j = (k + 1) % n
                faces.append(([f[k], b[k], b[j], f[j]], []))
    return points, faces


# ---------- write ----------

def level_layers(api, model, levels):
    """A tag per level, reusing tags of the same name already in the model."""
    count = C.c_size_t()
    api.call('SUModelGetNumLayers', model, C.byref(count))
    existing = {}
    if count.value:
        refs = (Ref * count.value)()
        api.call('SUModelGetLayers', model, count, refs, C.byref(count))
        for ref in refs[:count.value]:
            existing[api.text('SULayerGetName', ref)] = ref
    out = {}
    for level in levels:
        name = 'Tiksi: ' + str(level.get('name') or level['id'])
        if name not in existing:
            layer = Ref()
            api.call('SULayerCreate', C.byref(layer))
            api.call('SULayerSetName', layer, name.encode('utf-8'))
            api.call('SUModelAddLayers', model, C.c_size_t(1), (Ref * 1)(layer))
            existing[name] = layer
        out[level['id']] = existing[name]
    return out


def write_wall(api, entities, wall, layer, materials):
    ax, ay, bx, by = wall['ax'], wall['ay'], wall['bx'], wall['by']
    L = math.hypot(bx - ax, by - ay)
    if L < 0.01:
        return None
    H, th, elev = wall['height'], wall['thickness'], wall['elevation']
    o = plan_to_skp(ax, ay, elev)
    d = plan_to_skp(bx - ax, by - ay)
    n = math.hypot(d[0], d[1])
    group = new_group(api, entities, wall.get('name') or 'Wall', frame(o, (d[0] / n, d[1] / n)))
    set_layer(api, group, layer)
    holes = [{'s0': h['s0'], 's1': h['s1'], 'v0': h['v0'], 'v1': h['v1']} for h in wall.get('holes', [])]
    points, faces = extrude_wall(wall_loops(L, H, holes), th)
    inner = api.ref('SUGroupGetEntities', group)
    if faces:
        fill(api, inner, points, faces)
        if isinstance(wall.get('materials'), dict):
            paint_wall(api, inner, th, wall['materials'], materials)
    base = {'ax': r6(ax), 'ay': r6(ay), 'bx': r6(bx), 'by': r6(by), 'thickness': r6(th), 'height': r6(H), 'elevation': r6(elev)}
    set_data(api, to_ref(api, 'SUGroupToEntity', group), {'kind': 'wall', 'id': wall['id'], 'level': wall['level'], 'base': base,
                                                          'local': {'x0': 0, 'x1': r6(L * IN), 'y0': r6(-th / 2 * IN), 'y1': r6(th / 2 * IN), 'z0': 0, 'z1': r6(H * IN)}})
    for h in wall.get('holes', []):
        if not h.get('id'):
            continue
        w, hh = h['s1'] - h['s0'], h['v1'] - h['v0']
        if w <= 0.001 or hh <= 0.001:
            continue
        og = new_group(api, inner, 'Window' if h.get('type') == 'window' else 'Door', translation(h['s0'] * IN, 0, h['v0'] * IN))
        set_layer(api, og, layer)
        pane = api.ref('SUGroupGetEntities', og)
        fill(api, pane, [[0, 0, 0], [w * IN, 0, 0], [w * IN, 0, hh * IN], [0, 0, hh * IN]], [([0, 1, 2, 3], [])])
        mat = materials.get(h.get('material'))
        for face in api.collection(pane, 'Faces'):
            paint(api, face, mat)
        obase = {'wallId': wall['id'], 't': r6(h['t']), 'width': r6(h['width']), 'height': r6(h['height']), 'sill': r6(h.get('sill') or 0)}
        set_data(api, to_ref(api, 'SUGroupToEntity', og), {'kind': 'opening', 'id': h['id'], 'type': h.get('type'), 'base': obase,
                                                           'local': {'x1': r6(w * IN), 'z1': r6(hh * IN)}})
    return group


def write_room(api, entities, room, layer, materials):
    pts = room['pts']
    if len(pts) < 3:
        return None
    elev = room['elevation']
    group = new_group(api, entities, room.get('name') or 'Room', translation(0, 0, elev * IN))
    set_layer(api, group, layer)
    ring = [plan_to_skp(x, y) for x, y in pts]
    area = sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))
    if area < 0:
        ring.reverse()          # face up
    floor = api.ref('SUGroupGetEntities', group)
    fill(api, floor, ring, [(list(range(len(ring))), [])])
    mat = materials.get(room.get('material'))
    for face in api.collection(floor, 'Faces'):
        paint(api, face, mat, (0, 0, 1))
    base = {'pts': [[r6(x), r6(y)] for x, y in pts], 'name': room.get('name') or '', 'elevation': r6(elev)}
    set_data(api, to_ref(api, 'SUGroupToEntity', group), {'kind': 'room', 'id': room['id'], 'level': room['level'], 'base': base})
    return group


def prism(ring, z0, z1):
    """Points and faces (inches) of a vertical prism over a convex ring of local (x, y)."""
    n = len(ring)
    points = [[x, y, z0] for x, y in ring] + [[x, y, z1] for x, y in ring]
    faces = [(list(range(n)), []), (list(range(n, 2 * n)), [])]
    faces += [([k, (k + 1) % n, n + (k + 1) % n, n + k], []) for k in range(n)]
    return points, faces


def write_fixture(api, entities, fixture, layer, materials):
    """One group per fixture, framed at its origin along its angle; a nested group per part
    keeps touching prisms (a toe kick under a cabinet) from merging into one another."""
    parts = [p for p in fixture.get('parts', []) if len(p.get('pts') or []) >= 3 and p['z1'] - p['z0'] > 1e-4]
    if not parts:
        return None
    ox, oy = fixture['origin']
    a, elev = fixture.get('angle') or 0.0, fixture['elevation']
    group = new_group(api, entities, fixture.get('name') or 'Fixture', frame(plan_to_skp(ox, oy, elev), (math.cos(a), -math.sin(a))))
    set_layer(api, group, layer)
    inner = api.ref('SUGroupGetEntities', group)
    for part in parts:
        pg = new_group(api, inner, 'Part', translation(0, 0, 0))
        set_layer(api, pg, layer)
        # Local plan (u, v) is SketchUp (u, -v) in this frame (see frame()).
        ring = [(u * IN, -v * IN) for u, v in part['pts']]
        area = sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))
        if area < 0:
            ring.reverse()
        points, faces = prism(ring, part['z0'] * IN, part['z1'] * IN)
        body = api.ref('SUGroupGetEntities', pg)
        fill(api, body, points, faces)
        mat = materials.get(part.get('material'))
        for face in api.collection(body, 'Faces'):
            paint(api, face, mat)
    data = {'kind': 'fixture', 'id': fixture['id'], 'level': fixture['level'], 'fixtureKind': fixture.get('kind'), 'subtype': fixture.get('subtype'),
            'shape': fixture.get('shape'), 'base': dict(fixture.get('base') or {}, elevation=r6(elev))}
    if fixture.get('local'):
        data['local'] = fixture['local']
    set_data(api, to_ref(api, 'SUGroupToEntity', group), data)
    return group


def write_underlay(api, entities, underlay, image_path, layer):
    image = Ref()
    api.call('SUImageCreateFromFile', C.byref(image), os.fsencode(image_path))
    api.call('SUEntitiesAddImage', entities, image)
    w, h = C.c_double(), C.c_double()
    api.call('SUImageGetDimensions', image, C.byref(w), C.byref(h))
    sx = underlay['widthM'] * IN / w.value if w.value else 1
    sy = underlay['heightM'] * IN / h.value if h.value else 1
    corner = plan_to_skp(underlay['x'], underlay['y'] + underlay['heightM'], underlay['elevation'] - 0.002)
    t = Transform(); t.values[:] = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, corner[0], corner[1], corner[2], 1]
    api.call('SUImageSetTransform', image, C.byref(t))
    api.call('SUImageSetName', image, ('Tiksi plan underlay: ' + str(underlay.get('levelName') or underlay['level'])).encode('utf-8'))
    if layer and layer.ptr:
        api.call('SUDrawingElementSetLayer', to_ref(api, 'SUImageToDrawingElement', image), layer)
    set_data(api, to_ref(api, 'SUImageToEntity', image), {'kind': 'underlay', 'level': underlay['level'], 'sig': underlay['sig']})


def write_mirror(folder):
    folder = Path(folder)
    spec = json.loads((folder / 'mirror.json').read_text(encoding='utf-8'))
    if spec.get('format') != FORMAT:
        raise ValueError('Not a Tiksi mirror spec')
    existing = folder / 'existing.skp'
    api = API(); model = Ref(); warnings = []
    try:
        if existing.is_file():
            api.call('SUModelCreateFromFile', C.byref(model), os.fsencode(existing))
            current = get_model_data(api, model)
            if current and current.get('propertyId') not in (None, spec['property']['id']):
                raise ValueError('This SketchUp file mirrors a different Tiksi property')
        else:
            api.call('SUModelCreate', C.byref(model))
        entities = api.ref('SUModelGetEntities', model)
        underlays = {u['level']: u for u in spec.get('underlays', [])}
        kept_underlays, erase = set(), []
        for group in api.collection(entities, 'Groups'):
            entity = to_ref(api, 'SUGroupToEntity', group)
            if get_data(api, entity) is not None:
                erase.append(entity)
        for image in api.collection(entities, 'Images'):
            entity = to_ref(api, 'SUImageToEntity', image)
            data = get_data(api, entity)
            if data is None:
                continue
            wanted = underlays.get(data.get('level'))
            if wanted and wanted.get('sig') == data.get('sig') and not wanted.get('file'):
                kept_underlays.add(data.get('level'))
            else:
                erase.append(entity)
        if erase:
            api.call('SUEntitiesErase', entities, C.c_size_t(len(erase)), (Ref * len(erase))(*erase))
        layers = level_layers(api, model, spec.get('levels', []))
        materials = Materials(api, model, warnings)
        for wall in spec.get('walls', []):
            write_wall(api, entities, wall, layers.get(wall['level']), materials)
        for room in spec.get('rooms', []):
            write_room(api, entities, room, layers.get(room['level']), materials)
        for fixture in spec.get('fixtures', []):
            write_fixture(api, entities, fixture, layers.get(fixture['level']), materials)
        for level, underlay in underlays.items():
            if level in kept_underlays:
                continue
            name = underlay.get('file')
            if not name:
                warnings.append('Plan underlay for ' + str(level) + ' was not sent; it is missing from the mirror until the next full write')
                continue
            path = (folder / name).resolve()
            if not path.is_relative_to(folder.resolve()) or not path.is_file():
                raise ValueError('Underlay image is missing from the mirror package')
            write_underlay(api, entities, underlay, path, layers.get(level))
        elements = spec.get('elements')
        if not isinstance(elements, dict):
            elements = {e['id']: {'kind': e['kind']} for e in spec_elements(spec)}
        set_model_data(api, model, {'format': FORMAT, 'version': VERSION, 'propertyId': spec['property']['id'], 'name': spec['property'].get('name', ''),
                                    'elements': elements})
        api.call('SUModelSaveToFile', model, os.fsencode(folder / 'model.skp'))
        return {'warnings': warnings}
    finally:
        if model.ptr:
            api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()


def spec_elements(spec):
    for w in spec.get('walls', []):
        yield {'id': w['id'], 'kind': 'wall'}
        for h in w.get('holes', []):
            if h.get('id'):
                yield {'id': h['id'], 'kind': 'opening'}
    for r in spec.get('rooms', []):
        yield {'id': r['id'], 'kind': 'room'}
    for f in spec.get('fixtures', []):
        yield {'id': f['id'], 'kind': 'fixture'}


# ---------- read ----------

def group_transform(api, group):
    t = Transform()
    api.call('SUGroupGetTransform', group, C.byref(t))
    return matrix(t)


def axis_scale(m, k):
    return math.sqrt(m[k * 4] ** 2 + m[k * 4 + 1] ** 2 + m[k * 4 + 2] ** 2)


def face_bounds(api, entities):
    """Bounds of the faces directly inside `entities` (nested groups excluded)."""
    lo, hi, any_point = [math.inf] * 3, [-math.inf] * 3, False
    for face in api.collection(entities, 'Faces'):
        for p in face_ring(api, face):
            any_point = True
            for i in range(3):
                lo[i] = min(lo[i], p[i]); hi[i] = max(hi[i], p[i])
    return (lo, hi) if any_point else None


def face_ring(api, face):
    loop = api.ref('SUFaceGetOuterLoop', face)
    count = C.c_size_t()
    api.call('SULoopGetNumVertices', loop, C.byref(count))
    verts = (Ref * count.value)()
    api.call('SULoopGetVertices', loop, count, verts, C.byref(count))
    out = []
    for v in verts[:count.value]:
        p = Point()
        api.call('SUVertexGetPosition', v, C.byref(p))
        out.append([p.x, p.y, p.z])
    return out


def read_wall(api, group, data, warnings):
    m = group_transform(api, group)
    inner = api.ref('SUGroupGetEntities', group)
    box = face_bounds(api, inner)
    if not box:
        warnings.append('Wall ' + str(data.get('id')) + ' has no faces left; treated as deleted')
        return None
    (x0, y0, z0), (x1, y1, z1) = box
    ym = (y0 + y1) / 2
    a, b = apply(m, [x0, ym, z0]), apply(m, [x1, ym, z0])
    top = apply(m, [x0, ym, z1])
    side0, side1 = apply(m, [x0, y0, z0]), apply(m, [x0, y1, z0])
    pa, pb = skp_to_plan(a), skp_to_plan(b)
    now = {'ax': r6(pa[0]), 'ay': r6(pa[1]), 'bx': r6(pb[0]), 'by': r6(pb[1]),
           'thickness': r6(dist(side0, side1) / IN), 'height': r6(dist(a, top) / IN), 'elevation': r6(a[2] / IN)}
    openings = []
    length_local = x1 - x0
    sx, sz = axis_scale(m, 0), axis_scale(m, 2)
    for og in api.collection(inner, 'Groups'):
        odata = get_data(api, to_ref(api, 'SUGroupToEntity', og))
        if not odata or odata.get('kind') != 'opening':
            continue
        om = group_transform(api, og)
        obox = face_bounds(api, api.ref('SUGroupGetEntities', og))
        if not obox or length_local <= EPS:
            continue
        (ox0, _, oz0), (ox1, _, oz1) = obox
        p0, p1 = apply(om, [ox0, 0, oz0]), apply(om, [ox1, 0, oz1])
        s0, s1 = min(p0[0], p1[0]), max(p0[0], p1[0])
        v0, v1 = min(p0[2], p1[2]), max(p0[2], p1[2])
        onow = {'wallId': data.get('id'), 't': r6(((s0 + s1) / 2 - x0) / length_local), 'width': r6((s1 - s0) * sx / IN),
                'height': r6((v1 - v0) * sz / IN), 'sill': r6((v0 - z0) * sz / IN)}
        openings.append({'id': odata.get('id'), 'type': odata.get('type'), 'base': odata.get('base') or {}, 'now': onow})
    return {'id': data.get('id'), 'level': data.get('level'), 'name': api.text('SUGroupGetName', group), 'base': data.get('base') or {}, 'now': now, 'openings': openings}


def read_room(api, group, data, warnings):
    m = group_transform(api, group)
    faces = list(api.collection(api.ref('SUGroupGetEntities', group), 'Faces'))
    best, best_area = None, -1.0
    for face in faces:
        area = C.c_double()
        api.call('SUFaceGetArea', face, C.byref(area))
        ring = [apply(m, p) for p in face_ring(api, face)]
        zs = [p[2] for p in ring]
        if max(zs) - min(zs) > 0.5:      # skip vertical faces of a pushed-up slab
            continue
        if area.value > best_area:
            best, best_area = ring, area.value
    if not best:
        warnings.append('Room ' + str(data.get('id')) + ' has no floor face left; treated as deleted')
        return None
    pts = [[r6(x), r6(y)] for x, y in (skp_to_plan(p) for p in best)]
    if pts and polygon_area(pts) < 0:
        pts.reverse()
    base = data.get('base') or {}
    if base.get('pts') and polygon_area(base['pts']) < 0:
        pts.reverse()
    now = {'pts': rotate_to(pts, base.get('pts')), 'name': api.text('SUGroupGetName', group), 'elevation': r6(min(p[2] for p in best) / IN)}
    return {'id': data.get('id'), 'level': data.get('level'), 'base': base, 'now': now}


def deep_face_bounds(api, entities, m=None):
    """Bounds of every face under `entities`, nested groups included, in its own frame."""
    m = m or [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    lo, hi, any_point = [math.inf] * 3, [-math.inf] * 3, False
    for face in api.collection(entities, 'Faces'):
        for p in face_ring(api, face):
            q = apply(m, p); any_point = True
            for i in range(3):
                lo[i] = min(lo[i], q[i]); hi[i] = max(hi[i], q[i])
    for g in api.collection(entities, 'Groups'):
        box = deep_face_bounds(api, api.ref('SUGroupGetEntities', g), multiply(m, group_transform(api, g)))
        if box:
            any_point = True
            for i in range(3):
                lo[i] = min(lo[i], box[0][i]); hi[i] = max(hi[i], box[1][i])
    return (lo, hi) if any_point else None


def read_fixture(api, group, data, warnings):
    """A fixture as it stands: a box from its bounds in its own frame (moved, turned and
    stretched), a run from its back line carried by the group's transform."""
    m = group_transform(api, group)
    box = deep_face_bounds(api, api.ref('SUGroupGetEntities', group))
    if not box:
        warnings.append('Fixture ' + str(data.get('id')) + ' has no faces left; treated as deleted')
        return None
    (x0, y0, z0), (x1, y1, z1) = box
    base = data.get('base') or {}
    elev = base.get('elevation') or 0
    sx, sy, sz = axis_scale(m, 0), axis_scale(m, 1), axis_scale(m, 2)
    now = {'kind': data.get('fixtureKind'), 'subtype': data.get('subtype'), 'shape': data.get('shape')}
    bottom = apply(m, [(x0 + x1) / 2, (y0 + y1) / 2, z0])
    now['y0'] = r6(bottom[2] / IN - elev)
    now['h'] = r6((z1 - z0) * sz / IN)
    if data.get('shape') == 'box':
        cx, cy = skp_to_plan(apply(m, [(x0 + x1) / 2, (y0 + y1) / 2, z0]))
        now.update({'x': r6(cx), 'y': r6(cy), 'rot': r6(math.degrees(math.atan2(-m[1], m[0])) % 360),
                    'w': r6((x1 - x0) * sx / IN), 'd': r6((y1 - y0) * sy / IN)})
    else:
        pts = (data.get('local') or {}).get('pts') or []
        now['pts'] = [[r6(c) for c in skp_to_plan(apply(m, [u * IN, -v * IN, 0]))] for u, v in pts]
        now['depth'] = r6((base.get('depth') or 0) * sy)
    return {'id': data.get('id'), 'level': data.get('level'), 'base': base, 'now': now}


def polygon_area(pts):
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts))) / 2


def rotate_to(pts, ref):
    """Start the ring at the vertex nearest the reference ring's first vertex (stable diffs)."""
    if not pts or not ref:
        return pts
    k = min(range(len(pts)), key=lambda i: (pts[i][0] - ref[0][0]) ** 2 + (pts[i][1] - ref[0][1]) ** 2)
    return pts[k:] + pts[:k]


def read_mirror(folder):
    folder = Path(folder)
    api = API(); model = Ref(); warnings = []
    try:
        api.call('SUModelCreateFromFile', C.byref(model), os.fsencode(folder / 'source.skp'))
        info = get_model_data(api, model)
        entities = api.ref('SUModelGetEntities', model)
        walls, rooms, fixtures, untagged_groups, stray = [], [], [], 0, 0
        for group in api.collection(entities, 'Groups'):
            data = get_data(api, to_ref(api, 'SUGroupToEntity', group))
            if data is None:
                untagged_groups += 1
                continue
            kind = data.get('kind')
            if kind == 'wall':
                item = read_wall(api, group, data, warnings)
                if item: walls.append(item)
            elif kind == 'room':
                item = read_room(api, group, data, warnings)
                if item: rooms.append(item)
            elif kind == 'fixture':
                item = read_fixture(api, group, data, warnings)
                if item: fixtures.append(item)
            elif kind == 'opening':
                stray += 1
        underlays = []
        for image in api.collection(entities, 'Images'):
            data = get_data(api, to_ref(api, 'SUImageToEntity', image))
            if data and data.get('kind') == 'underlay':
                underlays.append({'level': data.get('level'), 'sig': data.get('sig')})
        if stray:
            warnings.append(str(stray) + ' Tiksi opening group(s) sit outside their wall; move them back inside the wall group to sync them')
        count = C.c_size_t()
        api.call('SUEntitiesGetNumFaces', entities, C.byref(count))
        instances = C.c_size_t()
        api.call('SUEntitiesGetNumInstances', entities, C.byref(instances))
        return {'format': FORMAT, 'version': VERSION, 'model': info, 'walls': walls, 'rooms': rooms, 'fixtures': fixtures, 'underlays': underlays,
                'untagged': {'faces': count.value, 'groups': untagged_groups, 'instances': instances.value}, 'warnings': warnings}
    finally:
        if model.ptr:
            api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()


if __name__ == '__main__':
    # Paths come only from the local service: an operation and its private job folder.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    try:
        op, folder = sys.argv[1], Path(sys.argv[2])
        if op == 'write':
            print(json.dumps(write_mirror(folder)))
        elif op == 'read':
            result = read_mirror(folder)
            (folder / 'mirror-read.json').write_text(json.dumps(result), encoding='utf-8')
            print(json.dumps({'warnings': result['warnings']}))
        else:
            raise ValueError('Unknown mirror operation')
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
