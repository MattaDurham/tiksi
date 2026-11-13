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
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile

if __package__:
    from .sketchup_convert import API, Ref, Point, Transform, Color, get_data, set_data, to_ref
else:
    from sketchup_convert import API, Ref, Point, Transform, Color, get_data, set_data, to_ref

FORMAT = 'tiksi-sketchup-mirror'
VERSION = 1
DICT = b'tiksi'
KEY = b'data'
IN = 1 / 0.0254          # inches per metre
EPS = 1e-6


class Box(C.Structure): _fields_ = [('min', Point), ('max', Point)]


# ---------- small helpers ----------


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
        # A see-through finish (the pane of a doorway with no door): opacity 0..1.
        opacity = spec.get('opacity')
        if isinstance(opacity, (int, float)) and not isinstance(opacity, bool) and 0 <= opacity < 1:
            api.call('SUMaterialSetUseOpacity', mat, C.c_bool(True), optional=True)
            api.call('SUMaterialSetOpacity', mat, C.c_double(opacity), optional=True)
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


def paint_wall(api, entities, th, faces, materials, length=None):
    """Long faces use pos/neg; optional local x=0/x=L end finishes leave caps and reveals alone."""
    pos, neg, other = (materials.get(faces.get(k)) for k in ('pos', 'neg', 'other'))
    ends = {key: materials.get(faces[key]) for key in ('endA', 'endB') if faces.get(key)}
    half, tol = th / 2 * IN, 1e-3
    for face in api.collection(entities, 'Faces'):
        ring = face_ring(api, face)
        ys = [p[1] for p in ring]
        if all(abs(y + half) < tol for y in ys):
            paint(api, face, pos, (0, -1, 0))
        elif all(abs(y - half) < tol for y in ys):
            paint(api, face, neg, (0, 1, 0))
        elif length is not None and 'endA' in ends and all(abs(p[0]) < tol for p in ring):
            paint(api, face, ends['endA'])
        elif length is not None and 'endB' in ends and all(abs(p[0] - length * IN) < tol for p in ring):
            paint(api, face, ends['endB'])
        else:
            paint(api, face, other)      # unoverridden ends, top and reveals: either side may show


# ---------- wall solids ----------

def wall_loops(L, H, holes):
    """Elevation loops of a wall [0,L] x [0,H] in (s, v), split at full-height openings.

    Returns [(outer, [inner, ...]), ...]; outer counter-clockwise seen from local -y,
    inner loops clockwise. Holes are {s0, s1, v0, v1} rectangles, already clamped and
    clamped to the wall. Overlapping cuts are subtracted as a union without changing
    either opening's own width or placement."""
    tol = 1e-4
    holes = sorted(({'s0': max(0.0, h['s0']), 's1': min(L, h['s1']), 'v0': max(0.0, h['v0']), 'v1': min(H, h['v1'])} for h in holes), key=lambda h: h['s0'])
    holes = [h for h in holes if h['s1'] - h['s0'] > tol and h['v1'] - h['v0'] > tol]
    if any(min(a['s1'], b['s1'])-max(a['s0'], b['s0']) > tol and min(a['v1'], b['v1'])-max(a['v0'], b['v0']) > tol
           for i, a in enumerate(holes) for b in holes[i+1:]):
        # Boundary tracing assumes disjoint holes. At overlaps use vertical strips,
        # unioning the removed height intervals before emitting the remaining solids.
        cuts = sorted({0.0, L, *(h['s0'] for h in holes), *(h['s1'] for h in holes)})
        out = []
        for a, b in zip(cuts, cuts[1:]):
            if b-a <= tol:
                continue
            intervals = sorted((h['v0'], h['v1']) for h in holes if h['s0'] < b-tol and h['s1'] > a+tol)
            y = 0.0
            for low, high in intervals:
                if low-y > tol:
                    out.append(([(a, y), (b, y), (b, low), (a, low)], []))
                y = max(y, high)
            if H-y > tol:
                out.append(([(a, y), (b, y), (b, H), (a, H)], []))
        return out
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


def tag_layers(api, model, tags):
    """A SketchUp tag per Tiksi tag, by name, reusing one already in the model; its visibility follows Tiksi."""
    count = C.c_size_t()
    api.call('SUModelGetNumLayers', model, C.byref(count))
    existing = {}
    if count.value:
        refs = (Ref * count.value)()
        api.call('SUModelGetLayers', model, count, refs, C.byref(count))
        for ref in refs[:count.value]:
            existing[api.text('SULayerGetName', ref)] = ref
    out = {}
    for tag in tags or []:
        name = str(tag.get('name') or '').strip()[:120] if isinstance(tag, dict) else ''
        if not name or name in out:
            continue
        if name not in existing:
            layer = Ref()
            api.call('SULayerCreate', C.byref(layer))
            api.call('SULayerSetName', layer, name.encode('utf-8'))
            api.call('SUModelAddLayers', model, C.c_size_t(1), (Ref * 1)(layer))
            existing[name] = layer
        api.call('SULayerSetVisibility', existing[name], C.c_bool(tag.get('visible') is not False), optional=True)
        out[name] = existing[name]
    return out


def pane_bands(hole):
    """An opening's flat pane from its foot up, as [(z0, z1, finish)] in metres. One band in the
    opening's own finish; a glass door (hole['glass']: the heights its glass runs between, and
    the glass finish) is glass between those heights and the door's finish below and above."""
    hh = hole['v1'] - hole['v0']
    own, glass = hole.get('material'), hole.get('glass')
    if not isinstance(glass, dict):
        return [(0.0, hh, own)]
    try:
        g0 = min(max(float(glass.get('v0', hole['v0'])) - hole['v0'], 0.0), hh)
        g1 = min(max(float(glass.get('v1', hole['v1'])) - hole['v0'], g0), hh)
    except (TypeError, ValueError):
        return [(0.0, hh, own)]
    if g1 - g0 <= 0.001:
        return [(0.0, hh, own)]
    return [b for b in ((0.0, g0, own), (g0, g1, glass.get('material')), (g1, hh, own)) if b[1] - b[0] > 0.001]



def opening_detail_parts(hole, thickness):
    """Resolved opening parts, in opening-local metres (x along wall, y across, z up).

    Tiksi supplies resolved dimensions from the same helpers used by its viewer. Detail
    groups are separate from the hidden opening outline, so swinging a leaf or adding
    projecting trim cannot change the opening's read-back dimensions.
    """
    d = hole.get('resolved')
    if not isinstance(d, dict) or not any(isinstance(hole.get(key), dict) for key in ('detail', 'profile')):
        return []
    w, h = hole['s1'] - hole['s0'], hole['v1'] - hole['v0']
    parts = []
    sides = hole.get('sides') or {}
    own = hole.get('trimMaterial') or hole.get('material')
    glass = hole.get('glassMaterial') or hole.get('material')
    metal = hole.get('metalMaterial') or own
    leaf_material = hole.get('leafMaterial') or own
    knob_material = hole.get('knobMaterial') or metal

    def add(name, points, faces, material, pivot=None):
        if pivot:
            px, angle = pivot
            ca, sa = math.cos(angle), math.sin(angle)
            points = [[px + ca * x - sa * y, sa * x + ca * y, z + .01] for x, y, z in points]
        parts.append({'name': name, 'points': points, 'faces': faces, 'material': material})

    def box(name, x0, x1, y0, y1, z0, z1, material=own, pivot=None):
        if min(x1-x0, y1-y0, z1-z0) <= 1e-7:
            return
        points, faces = prism([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z1)
        add(name, points, faces, leaf_material if pivot and material is own else material, pivot)

    def cylinder(name, x, y, z, radius, length, axis, pivot):
        points = []
        for end in (-length/2, length/2):
            for k in range(24):
                a = 2*math.pi*k/24
                q = [radius*math.cos(a), radius*math.sin(a)]
                points.append(([x+end, y+q[0], z+q[1]] if axis == 0 else [x+q[0], y+end, z+q[1]]))
        faces = [(list(range(23, -1, -1)), []), (list(range(24, 48)), [])]
        faces += [([k, (k+1)%24, (k+1)%24+24, k+24], []) for k in range(24)]
        add(name, points, faces, metal, pivot)

    def knob(name, x, y, z, radius, pivot):
        if d.get('knobShape') == 'faceted':
            phi = (1+math.sqrt(5))/2
            verts = [[-1,phi,0],[1,phi,0],[-1,-phi,0],[1,-phi,0],[0,-1,phi],[0,1,phi],[0,-1,-phi],[0,1,-phi],[phi,0,-1],[phi,0,1],[-phi,0,-1],[-phi,0,1]]
            tris = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]]
            mids = {}
            def midpoint(a, b):
                key = tuple(sorted((a, b)))
                if key not in mids:
                    mids[key] = len(verts); verts.append([(va+vb)/2 for va, vb in zip(verts[a], verts[b])])
                return mids[key]
            faces = []
            for a, b, c in tris:
                ab, bc, ca = midpoint(a, b), midpoint(b, c), midpoint(c, a)
                faces += [(tri, []) for tri in ([a,ab,ca], [b,bc,ab], [c,ca,bc], [ab,bc,ca])]
            points = []
            for vx, vy, vz in verts:
                scale = radius/math.sqrt(vx*vx+vy*vy+vz*vz)
                points.append([x+vx*scale, y+vy*scale*.85, z+vz*scale])
            add(name, points, faces, knob_material, pivot)
            return
        n, rings = 20, 12
        points = [[x, y-radius*.85, z]]
        for j in range(1, rings):
            a = math.pi*j/rings
            for k in range(n):
                b = 2*math.pi*k/n
                points.append([x+radius*math.sin(a)*math.cos(b), y-radius*math.cos(a)*.85, z+radius*math.sin(a)*math.sin(b)])
        points.append([x, y+radius*.85, z]); end = len(points)-1
        faces = [([0, 1+(k+1)%n, 1+k], []) for k in range(n)]
        for j in range(rings-2):
            lo, hi = 1+j*n, 1+(j+1)*n
            faces += [([lo+k, lo+(k+1)%n, hi+(k+1)%n, hi+k], []) for k in range(n)]
        lo = 1+(rings-2)*n
        faces += [([lo+k, lo+(k+1)%n, end], []) for k in range(n)]
        add(name, points, faces, knob_material, pivot)

    if hole.get('type') != 'window':
        if hole.get('plain'):
            return []
        j, cw, cd = d['jambWidth'], d['casingWidth'], d['casingDepth']
        box('Start jamb', 0, j, -thickness/2-.008, thickness/2+.008, 0, h)
        box('End jamb', w-j, w, -thickness/2-.008, thickness/2+.008, 0, h)
        box('Head jamb', j, w-j, -thickness/2-.008, thickness/2+.008, h-j, h)
        for sign, key in ((1, 'pos'), (-1, 'neg')):
            if not sides.get(key) or cw <= 0 or cd <= 0:
                continue
            # SketchUp's across-wall axis is the negative of Tiksi's.
            a, b = -sign*thickness/2, -sign*(thickness/2+cd)
            a, b = sorted((a, b))
            box('Start casing', -cw, .01, a, b, 0, h+cw)
            box('End casing', w-.01, w+cw, a, b, 0, h+cw)
            box('Head casing', -cw, w+cw, a, b, h-.01, h+cw)
        leaves = d.get('leaves', hole.get('leaves', 1))
        if not leaves:
            return parts
        lw, lh, lt = d['leafWidth'], d['leafHeight'], d['leafThickness']
        swing = d['swingSide']*math.radians(25) if hole.get('shownOpen') else 0
        hinges = ('start', 'end') if leaves == 2 else (d['hinge'],)
        for hinge in hinges:
            pivot = (j+.003, -swing) if hinge == 'start' else (w-j-.003, math.pi+swing)
            glazing = hole.get('leafGlazing')
            if isinstance(glazing, dict):
                gx0, gx1, gz0, gz1 = glazing['glass']
                panel = glazing.get('panel')
                box('Leaf stile', 0, gx0, -lt/2, lt/2, 0, lh, pivot=pivot)
                box('Leaf stile', gx1, lw, -lt/2, lt/2, 0, lh, pivot=pivot)
                box('Leaf top rail', gx0, gx1, -lt/2, lt/2, gz1, lh, pivot=pivot)
                box('Leaf bottom rail', gx0, gx1, -lt/2, lt/2, 0, panel[2] if panel else gz0, pivot=pivot)
                if panel:
                    box('Leaf mid rail', gx0, gx1, -lt/2, lt/2, panel[3], gz0, pivot=pivot)
                    box('Leaf lower panel', gx0, gx1, -lt/2+.012, lt/2-.012, panel[2], panel[3], pivot=pivot)
                box('Leaf glass', gx0, gx1, -.003, .003, gz0, gz1, glass, pivot)
            elif d.get('style') == 'six-panel':
                # Shallow recessed fields in a rail-and-stile leaf, rather than a texture
                # baked into a flat native pane. Dimensions stay within the leaf envelope.
                mx, my, gx, gy = lw*24/256, lh*26/512, lw*18/256, lh*20/512
                usable = lh-2*my-2*gy
                bands, z = [], my
                for proportion in (.38, .38, .24):
                    bands.append((z, z+usable*proportion)); z += usable*proportion+gy
                half = (lw-gx)/2
                box('Leaf start stile', 0, mx, -lt/2, lt/2, 0, lh, pivot=pivot)
                box('Leaf end stile', lw-mx, lw, -lt/2, lt/2, 0, lh, pivot=pivot)
                box('Leaf centre stile', half, half+gx, -lt/2, lt/2, 0, lh, pivot=pivot)
                previous = 0
                for z0, z1 in bands:
                    box('Leaf rail', mx, lw-mx, -lt/2, lt/2, previous, z0, pivot=pivot)
                    for x0, x1 in ((mx, half), (half+gx, lw-mx)):
                        box('Leaf recessed panel', x0, x1, -lt/2+.004, lt/2-.004, z0, z1, pivot=pivot)
                    previous = z1
                box('Leaf top rail', mx, lw-mx, -lt/2, lt/2, previous, lh, pivot=pivot)
            else:
                box('Slab leaf', 0, lw, -lt/2, lt/2, 0, lh, pivot=pivot)
            if d.get('hardware') != 'none':
                hx, hz = lw-d.get('handleBackset', .075), d.get('handleHeight', min(1.0, lh-.1))
                for sign in (1, -1):
                    cylinder('Handle rose', hx, sign*(lt/2+.005), hz, .028, .01, 1, pivot)
                    cylinder('Handle stem', hx, sign*(lt/2+.03), hz, .009, .05, 1, pivot)
                    if d.get('hardware') == 'knob':
                        knob('Door knob', hx, sign*(lt/2+.05), hz, d.get('knobRadius', .027), pivot)
                    else:
                        cylinder('Door lever', hx-.055, sign*(lt/2+.05), hz, .008, .12, 0, pivot)
        return parts

    fw, sw, mw = d['frameWidth'], d['sashWidth'], d['muntinWidth']
    box('Window frame', 0, fw, -thickness/2-.005, thickness/2+.005, 0, h)
    box('Window frame', w-fw, w, -thickness/2-.005, thickness/2+.005, 0, h)
    box('Window frame', fw, w-fw, -thickness/2-.005, thickness/2+.005, 0, fw)
    box('Window frame', fw, w-fw, -thickness/2-.005, thickness/2+.005, h-fw, h)

    def sash(name, z0, z1, columns, rows, depth=0):
        x0, x1 = fw, w-fw
        box(name+' stile', x0, x0+sw, depth-.024, depth+.024, z0, z1)
        box(name+' stile', x1-sw, x1, depth-.024, depth+.024, z0, z1)
        box(name+' rail', x0+sw, x1-sw, depth-.024, depth+.024, z0, z0+sw)
        box(name+' rail', x0+sw, x1-sw, depth-.024, depth+.024, z1-sw, z1)
        gx0, gx1, gz0, gz1 = x0+sw, x1-sw, z0+sw, z1-sw
        for col in range(1, columns):
            x = gx0+(gx1-gx0)*col/columns
            box(name+' vertical muntin', x-mw/2, x+mw/2, depth-.016, depth+.016, gz0, gz1)
        for row in range(1, rows):
            z = gz0+(gz1-gz0)*row/rows
            box(name+' horizontal muntin', gx0, gx1, depth-.016, depth+.016, z-mw/2, z+mw/2)
        box(name+' glass', gx0, gx1, depth-.003, depth+.003, gz0, gz1, glass)
    inside = 1 if sides.get('pos') else -1 if sides.get('neg') else 1
    if d.get('type') == 'double-hung':
        mid = h/2
        sash('Lower sash', fw, mid+sw/2, d['lower']['columns'], d['lower']['rows'], -inside*.025)
        sash('Upper sash', mid-sw/2, h-fw, d['upper']['columns'], d['upper']['rows'], inside*.025)
    else:
        sash('Sash', fw, h-fw, d['columns'], d['rows'])
    inside = 1 if sides.get('pos') else -1 if sides.get('neg') else 1
    room_sides = (1, -1) if sides.get('pos') and sides.get('neg') else (inside,)
    cw, cd = d.get('casingWidth', .07), d.get('casingDepth', .016)
    for sign in room_sides:
        face, outer = -sign*thickness/2, -sign*(thickness/2+cd)
        a, b = sorted((face, outer))
        stool = -sign*(thickness/2+.06)
        box('Window stool', -.06, w+.06, min(0, stool), max(0, stool), -.028, 0)
        if cw > 0 and cd > 0:
            box('Window apron', -cw, w+cw, a, b, -.11, -.028)
            box('Window casing', -cw, .01, a, b, 0, h+cw)
            box('Window casing', w-.01, w+cw, a, b, 0, h+cw)
            box('Window casing', -cw, w+cw, a, b, h-.01, h+cw)
    if len(room_sides) == 1:
        outer = inside*(thickness/2+.045)
        box('Exterior sill', -.03, w+.03, min(0, outer), max(0, outer), -.04, 0)
    return parts


def write_opening_detail(api, entities, hole, thickness, layer, materials):
    for part in opening_detail_parts(hole, thickness):
        group = new_group(api, entities, part['name'], translation(0, 0, 0))
        set_layer(api, group, layer)
        inner = api.ref('SUGroupGetEntities', group)
        fill(api, inner, [[v*IN for v in p] for p in part['points']], part['faces'])
        mat = materials.get(part['material'])
        for face in api.collection(inner, 'Faces'):
            paint(api, face, mat)


def scaled_opening_detail(detail, sx, sy, sz, flip_x=False, flip_y=False, orientation=None):
    """Dimensions and handing follow a native opening's signed local transform."""
    result = json.loads(json.dumps(detail))
    axes = {'leafWidth': sx, 'leafHeight': sz, 'leafThickness': sy, 'jambWidth': sx,
            'casingWidth': sx, 'casingDepth': sy, 'frameWidth': sx, 'sashWidth': sx, 'muntinWidth': sx,
            'handleHeight': sz, 'handleBackset': sx, 'knobRadius': min(sx, sy, sz)}
    for kind in ('door', 'window'):
        values = result.get(kind)
        if not isinstance(values, dict):
            continue
        for key, scale in axes.items():
            value = values.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                values[key] = value if abs(scale-1) < 1e-10 else r6(value*scale)
    door = result.get('door')
    if isinstance(door, dict):
        if flip_x:
            door['hinge'] = 'start' if door.get('hinge') == 'end' else 'end'
        if flip_y:
            orientation = orientation or {}
            if 'sides' not in orientation:
                raise ValueError('A reflected opening has no recorded casing sides; keep the native model and establish its orientation before syncing.')
            sides = orientation.get('sides') or {}
            if bool(sides.get('pos')) != bool(sides.get('neg')):
                raise ValueError('A reflected opening with one-sided casing cannot be represented faithfully; keep the native model and review its orientation.')
            side = door.get('swingSide')
            if side not in ('positive', 'negative'):
                side = {1: 'positive', -1: 'negative'}.get(orientation.get('swingSide'))
            if side is None:
                raise ValueError('A reflected opening has no recorded original swing side; keep the native model and establish its handing before syncing.')
            door['swingSide'] = 'negative' if side == 'positive' else 'positive'
    if isinstance(result.get('window'), dict) and flip_y:
        raise ValueError('A window reflected across its wall has reversed sash/casing depth that cannot be represented faithfully; keep the native model and review its orientation.')
    return result



def baseboard_part(segment, thickness):
    """One already-clipped rail, with the viewer's four-segment rounded top profile."""
    s0, s1, height, depth = (segment[k] for k in ('s0', 's1', 'height', 'depth'))
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (s0, s1, height, depth)):
        return None
    if s1-s0 <= 1e-7 or height <= 0 or depth <= 0:
        return None
    section = [(0, 0), (depth, 0)]
    radius = segment.get('radius', min(depth/2, height/10))
    if not isinstance(radius, (int, float)) or isinstance(radius, bool) or not math.isfinite(radius):
        radius = min(depth/2, height/10)
    radius = min(max(radius, 0), depth, height)
    if segment.get('profile') == 'rounded' and radius > 1e-7:
        section.append((depth, height-radius))
        section += [(depth-radius+radius*math.cos(k*math.pi/8), height-radius+radius*math.sin(k*math.pi/8)) for k in range(1, 5)]
    else:
        section.append((depth, height))
    section.append((0, height))
    sign = -1 if segment.get('side') == 'pos' else 1
    count = len(section)
    points = [[x, sign*(thickness/2+offset), z] for x in (s0, s1) for offset, z in section]
    faces = [(list(range(count-1, -1, -1)), []), (list(range(count, 2*count)), [])]
    faces += [([k, (k+1)%count, (k+1)%count+count, k+count], []) for k in range(count)]
    return {'points': points, 'faces': faces, 'material': segment.get('material')}


def scaled_baseboard(detail, depth_scale, height_scale):
    result = json.loads(json.dumps(detail))
    for key, scale in (('depth', depth_scale), ('height', height_scale), ('radius', min(depth_scale, height_scale))):
        value = result.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            result[key] = value if abs(scale-1) < 1e-10 else r6(value*scale)
    return result


def write_baseboards(api, entities, wall, layer, materials):
    for segment in wall.get('baseboards', []):
        part = baseboard_part(segment, wall['thickness'])
        if not part:
            continue
        group = new_group(api, entities, 'Baseboard '+segment.get('side', 'neg'), translation(0, 0, 0))
        set_layer(api, group, layer)
        inner = api.ref('SUGroupGetEntities', group)
        fill(api, inner, [[v*IN for v in p] for p in part['points']], part['faces'])
        mat = materials.get(part['material'])
        for face in api.collection(inner, 'Faces'):
            paint(api, face, mat)


def write_trim_details(api, entities, wall, layer, materials, tags=None):
    """Keep the viewer's generated trim triangles, including profiles and corner cuts.

    These children belong to their wall rather than claiming an independently editable
    native trim representation. The wall's guard protects their exact geometry on read.
    """
    for trim in wall.get('trims', []):
        if not isinstance(trim, dict) or not isinstance(trim.get('id'), str):
            raise ValueError('A generated wall trim needs its source id')
        group = new_group(api, entities, str(trim.get('name') or 'Wall trim'), translation(0, 0, 0))
        trim_layer = (tags or {}).get(trim.get('tag')) or layer
        set_layer(api, group, trim_layer)
        inner = api.ref('SUGroupGetEntities', group)
        for part in trim.get('parts', []):
            positions = part.get('positions')
            if (not isinstance(positions, list) or len(positions) % 9 or
                    any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) for v in positions)):
                raise ValueError('Generated wall trim needs finite expanded triangles')
            if not positions:
                continue
            # Tiksi local axes: along the wall, up, across its positive plan side.
            points = [[positions[i]*IN, -positions[i+2]*IN, positions[i+1]*IN] for i in range(0, len(positions), 3)]
            faces = [([i, i+1, i+2], []) for i in range(0, len(points), 3)]
            child = new_group(api, inner, str(part.get('role') or 'Trim surface'), translation(0, 0, 0))
            set_layer(api, child, trim_layer)
            body = api.ref('SUGroupGetEntities', child)
            fill(api, body, points, faces)
            mat = materials.get(part.get('material'))
            for face in api.collection(body, 'Faces'):
                paint(api, face, mat)
            set_data(api, to_ref(api, 'SUGroupToEntity', child), {
                'kind': 'trim-part', 'role': part.get('role'), 'material': part.get('material')})
        set_data(api, to_ref(api, 'SUGroupToEntity', group), {
            'kind': 'trim-detail', 'id': trim['id'], 'name': trim.get('name'),
            'tag': trim.get('tag'), 'meshSig': trim.get('meshSig'),
            'source': trim.get('source'), 'product': trim.get('product')})


def write_wall(api, entities, wall, layer, materials, tags=None):
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
            paint_wall(api, inner, th, wall['materials'], materials, length=L)
    base = {'ax': r6(ax), 'ay': r6(ay), 'bx': r6(bx), 'by': r6(by), 'thickness': r6(th), 'height': r6(H), 'elevation': r6(elev)}
    for key in ('materialEndA', 'materialEndB'):
        if isinstance(wall.get(key), str) and wall[key]:
            base[key] = wall[key]
    for key in ('baseboardPos', 'baseboardNeg'):
        if isinstance(wall.get(key), dict):
            base[key] = json.loads(json.dumps(wall[key]))
    if isinstance(wall.get('profile'), dict):
        base['profile'] = json.loads(json.dumps(wall['profile']))
    if 'trimState' in wall:
        base['trimState'] = json.loads(json.dumps(wall['trimState']))
    if wall.get('trims'):
        base['trimGeometry'] = [{'id': t['id'], 'meshSig': t['meshSig']} for t in wall['trims']]
    write_baseboards(api, inner, wall, layer, materials)
    write_trim_details(api, inner, wall, layer, materials, tags)
    data = {'kind': 'wall', 'id': wall['id'], 'level': wall['level'], 'base': base,
            'local': {'x0': 0, 'x1': r6(L * IN), 'y0': r6(-th / 2 * IN), 'y1': r6(th / 2 * IN), 'z0': 0, 'z1': r6(H * IN)}}
    if wall.get('trims'):
        data['trimGuard'] = {'transform': group_transform(api, group), 'bounds': face_bounds(api, inner)}
        if data['trimGuard']['bounds'] is None:
            raise ValueError('A wall with generated trim needs wall faces for a safe native round trip')
    set_data(api, to_ref(api, 'SUGroupToEntity', group), data)
    for h in wall.get('holes', []):
        if not h.get('id'):
            continue
        w, hh = h['s1'] - h['s0'], h['v1'] - h['v0']
        if w <= 0.001 or hh <= 0.001:
            continue
        og = new_group(api, inner, 'Window' if h.get('type') == 'window' else 'Door', translation(h['s0'] * IN, 0, h['v0'] * IN))
        set_layer(api, og, (tags or {}).get(h.get('tag')) or layer)
        pane = api.ref('SUGroupGetEntities', og)
        bands = pane_bands(h)
        levels = [bands[0][0]] + [b[1] for b in bands]
        fill(api, pane, [[x * IN, 0, z * IN] for z in levels for x in (0, w)],
             [([2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2], []) for i in range(len(bands))])
        for face in api.collection(pane, 'Faces'):
            zs = [p[2] / IN for p in face_ring(api, face)]
            mid = (min(zs) + max(zs)) / 2
            paint(api, face, materials.get(next((b[2] for b in bands if b[0] <= mid <= b[1]), h.get('material'))))
        if any(isinstance(h.get(key), dict) for key in ('detail', 'profile')) and isinstance(h.get('resolved'), dict):
            # The direct pane is only a read-back anchor. Hide its edges as well as faces.
            for item in api.collection(pane, 'Faces'):
                api.call('SUDrawingElementSetHidden', to_ref(api, 'SUFaceToDrawingElement', item), C.c_bool(True))
                count = C.c_size_t()
                api.call('SUFaceGetNumEdges', item, C.byref(count))
                edges = (Ref * count.value)()
                api.call('SUFaceGetEdges', item, count, edges, C.byref(count))
                for edge in edges:
                    api.call('SUDrawingElementSetHidden', to_ref(api, 'SUEdgeToDrawingElement', edge), C.c_bool(True))
            write_opening_detail(api, pane, h, th, (tags or {}).get(h.get('tag')) or layer, materials)
        obase = {'wallId': wall['id'], 't': r6(h['t']), 'width': r6(h['width']), 'height': r6(h['height']), 'sill': r6(h.get('sill') or 0)}
        for key in ('detail', 'profile'):
            if isinstance(h.get(key), dict):
                obase[key] = json.loads(json.dumps(h[key]))
        if isinstance(h.get('configuration'), dict):
            obase['configuration'] = h['configuration']
        if 'floorContinuity' in h:
            obase['floorContinuity'] = h['floorContinuity']
        orientation = {'sides': h.get('sides') or {}, 'swingSide': (h.get('resolved') or {}).get('swingSide')}
        set_data(api, to_ref(api, 'SUGroupToEntity', og), {'kind': 'opening', 'id': h['id'], 'type': h.get('type'), 'base': obase,
                                                           'orientation': orientation, 'local': {'x1': r6(w * IN), 'z1': r6(hh * IN)}})
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
    # Separate threshold subgroups cannot change the room outline read from direct faces.
    for patch in room.get('thresholds', []):
        if len(patch.get('pts') or []) < 3:
            continue
        threshold = new_group(api, floor, 'Floor through opening', translation(0, 0, 0))
        set_layer(api, threshold, layer)
        inner = api.ref('SUGroupGetEntities', threshold)
        ring = [plan_to_skp(x, y) for x, y in patch['pts']]
        area = sum(ring[i][0]*ring[(i+1)%len(ring)][1]-ring[(i+1)%len(ring)][0]*ring[i][1] for i in range(len(ring)))
        if area < 0:
            ring.reverse()
        fill(api, inner, ring, [(list(range(len(ring))), [])])
        mat = materials.get(patch.get('material') or room.get('material'))
        for face in api.collection(inner, 'Faces'):
            paint(api, face, mat, (0, 0, 1))
    height = room.get('ceilingHeight')
    if isinstance(height, (int, float)) and not isinstance(height, bool) and math.isfinite(height) and height > 0:
        ceiling = new_group(api, floor, 'Finished ceiling', translation(0, 0, 0))
        set_layer(api, ceiling, layer)
        inner = api.ref('SUGroupGetEntities', ceiling)
        ring = [(x*IN, -y*IN) for x, y in pts]
        points, faces = prism(ring, height*IN, (height+.027)*IN)
        fill(api, inner, points, faces)
        mat = materials.get(room.get('ceilingMaterial'))
        for face in api.collection(inner, 'Faces'):
            paint(api, face, mat)
    base = {'pts': [[r6(x), r6(y)] for x, y in pts], 'name': room.get('name') or '', 'elevation': r6(elev)}
    if isinstance(height, (int, float)) and not isinstance(height, bool) and math.isfinite(height) and height > 0:
        base['ceilingHeight'] = r6(height)
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


def face_fingerprint(api, group):
    """Local face coordinates; moving the whole group remains a supported edit."""
    inner = api.ref('SUGroupGetEntities', group)
    rings = []
    for face in api.collection(inner, 'Faces'):
        # All vertices include holes; the outer boundary alone misses cutouts.
        count = C.c_size_t()
        api.call('SUFaceGetNumVertices', face, C.byref(count))
        vertices = (Ref * count.value)()
        api.call('SUFaceGetVertices', face, count, vertices, C.byref(count))
        points = []
        for vertex in vertices[:count.value]:
            point = Point()
            api.call('SUVertexGetPosition', vertex, C.byref(point))
            points.append(tuple(round(v, 5) for v in (point.x, point.y, point.z)))
        rings.append(sorted(points))
    return hashlib.sha256(json.dumps(sorted(rings)).encode()).hexdigest()



def generated_detail_fingerprint(api, group, exclude_managed=True):
    """Generated descendants in their parent's frame, excluding separately managed pieces.

    Moving a whole wall/opening/fixture remains representable. Editing, moving, deleting or
    adding its nested detail cannot be reduced to that parent's dimensions and must block a
    rewrite. A wall's independently managed openings are checked against their own record.
    """
    managed = {'wall', 'opening', 'room', 'fixture'}
    def records(entities, depth=0):
        if depth > 64:
            raise ValueError('SketchUp detail nesting is too deep to verify safely')
        children = []
        for child in api.collection(entities, 'Groups'):
            data = get_data(api, to_ref(api, 'SUGroupToEntity', child)) or {}
            if exclude_managed and data.get('kind') in managed and data.get('id'):
                continue
            inner = api.ref('SUGroupGetEntities', child)
            children.append({'type': 'group', 'transform': [round(v, 8) for v in group_transform(api, child)],
                             'faces': face_fingerprint(api, child), 'children': records(inner, depth+1)})
        for instance in api.collection(entities, 'Instances'):
            definition = api.ref('SUComponentInstanceGetDefinition', instance)
            transform = Transform(); api.call('SUComponentInstanceGetTransform', instance, C.byref(transform))
            inner = api.ref('SUComponentDefinitionGetEntities', definition)
            # Geometry inside an inserted component must be checked too, not only its ID.
            rings = []
            for face in api.collection(inner, 'Faces'):
                count = C.c_size_t(); api.call('SUFaceGetNumVertices', face, C.byref(count))
                vertices = (Ref * count.value)(); api.call('SUFaceGetVertices', face, count, vertices, C.byref(count))
                points = []
                for vertex in vertices[:count.value]:
                    point = Point(); api.call('SUVertexGetPosition', vertex, C.byref(point))
                    points.append(tuple(round(v, 5) for v in (point.x, point.y, point.z)))
                rings.append(sorted(points))
            children.append({'type': 'instance', 'transform': [round(v, 8) for v in transform.values],
                             'faces': sorted(rings), 'children': records(inner, depth+1)})
        for kind in ('Images', 'Texts', 'Dimensions', 'SectionPlanes'):
            count = C.c_size_t(); api.call('SUEntitiesGetNum'+kind, entities, C.byref(count))
            if count.value:
                children.append({'type': kind, 'count': count.value})
        return sorted(children, key=lambda value: json.dumps(value, sort_keys=True))
    payload = records(api.ref('SUGroupGetEntities', group))
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def unsupported_group_geometry(api, group, data):
    return bool(data and ((data.get('faceFingerprint') and data['faceFingerprint'] != face_fingerprint(api, group))
                         or (data.get('generatedDetailFingerprint') and data['generatedDetailFingerprint'] != generated_detail_fingerprint(api, group))))


def trim_appearance_fingerprint(api, group, material_cache=None):
    """Native trim finishes and object visibility cannot silently disappear on a rewrite.

    Only trim descendants participate; wall paint and global tag visibility retain their
    existing semantics. Material values and texture pixels are cached across the traversal.
    """
    cache = {} if material_cache is None else material_cache
    with tempfile.TemporaryDirectory(prefix='tiksi-trim-finish-') as folder:
        def material(ref):
            if not ref.ptr:
                return None
            if ref.ptr not in cache:
                color, opacity, use_opacity, kind = Color(), C.c_double(1), C.c_bool(), C.c_int()
                api.call('SUMaterialGetColor', ref, C.byref(color))
                api.call('SUMaterialGetOpacity', ref, C.byref(opacity))
                api.call('SUMaterialGetUseOpacity', ref, C.byref(use_opacity))
                api.call('SUMaterialGetType', ref, C.byref(kind))
                value = {'name': api.text('SUMaterialGetName', ref), 'color': [color.red, color.green, color.blue, color.alpha],
                         'opacity': opacity.value, 'useOpacity': use_opacity.value, 'type': kind.value}
                texture = Ref()
                if not api.call('SUMaterialGetTexture', ref, C.byref(texture), optional=True) and texture.ptr:
                    path = Path(folder) / ('texture-' + str(len(cache)) + '.png')
                    api.call('SUTextureWriteToFile', texture, os.fsencode(path))
                    value['texture'] = hashlib.sha256(path.read_bytes()).hexdigest()
                cache[ref.ptr] = value
            return cache[ref.ptr]

        def drawing(ref, assigned=False):
            hidden = C.c_bool(); api.call('SUDrawingElementGetHidden', ref, C.byref(hidden))
            layer = api.ref('SUDrawingElementGetLayer', ref)
            result = {'hidden': hidden.value, 'tag': api.text('SULayerGetName', layer) if layer.ptr else None}
            if assigned:
                mat = Ref(); api.call('SUDrawingElementGetMaterial', ref, C.byref(mat), optional=True)
                result['material'] = material(mat)
            return result

        def records(entities, depth=0):
            if depth > 64:
                raise ValueError('SketchUp trim nesting is too deep to verify safely')
            out = []
            for face in api.collection(entities, 'Faces'):
                front, back = Ref(), Ref()
                api.call('SUFaceGetFrontMaterial', face, C.byref(front), optional=True)
                api.call('SUFaceGetBackMaterial', face, C.byref(back), optional=True)
                out.append({'face': sorted(tuple(round(v, 5) for v in p) for p in face_ring(api, face)),
                            'drawing': drawing(to_ref(api, 'SUFaceToDrawingElement', face)),
                            'front': material(front), 'back': material(back)})
            for child in api.collection(entities, 'Groups'):
                out.append({'group': drawing(to_ref(api, 'SUGroupToDrawingElement', child), assigned=True),
                            'children': records(api.ref('SUGroupGetEntities', child), depth+1)})
            for instance in api.collection(entities, 'Instances'):
                definition = api.ref('SUComponentInstanceGetDefinition', instance)
                out.append({'instance': drawing(to_ref(api, 'SUComponentInstanceToDrawingElement', instance), assigned=True),
                            'children': records(api.ref('SUComponentDefinitionGetEntities', definition), depth+1)})
            return sorted(out, key=lambda value: json.dumps(value, sort_keys=True))

        payload = []
        for child in api.collection(api.ref('SUGroupGetEntities', group), 'Groups'):
            data = get_data(api, to_ref(api, 'SUGroupToEntity', child)) or {}
            if data.get('kind') == 'trim-detail':
                payload.append({'drawing': drawing(to_ref(api, 'SUGroupToDrawingElement', child), assigned=True),
                                'children': records(api.ref('SUGroupGetEntities', child))})
        return hashlib.sha256(json.dumps(sorted(payload, key=lambda value: json.dumps(value, sort_keys=True)), sort_keys=True).encode()).hexdigest()


def verify_trim_wall(api, group, data, material_cache=None):
    """Refuse native edits the wall-attached parametric trim cannot safely reproduce.

    Proper XY rigid moves retain the local meshes. The browser separately regenerates
    their hashes before merging to check that neighboring walls have not changed mitres.
    Opening edits affect trim cutouts, so this guard includes managed opening children.
    """
    guard = data.get('trimGuard') if isinstance(data, dict) else None
    if guard is None:
        return
    label = 'Wall ' + str(data.get('id')) + ' with generated trim'
    written = guard.get('transform') if isinstance(guard, dict) else None
    m = group_transform(api, group)
    tol = 1e-7
    rigid = (isinstance(written, list) and len(written) == 16 and
             all(math.isfinite(v) for v in m) and
             all(abs(m[i]) < tol for i in (2, 3, 6, 7, 8, 9, 11)) and
             abs(m[10]-1) < tol and abs(m[15]-1) < tol and
             abs(m[0]**2+m[1]**2-1) < tol and abs(m[4]**2+m[5]**2-1) < tol and
             abs(m[0]*m[4]+m[1]*m[5]) < tol and m[0]*m[5]-m[1]*m[4] > 0 and
             abs(m[14]-written[14]) < tol)
    if not rigid:
        raise ValueError(label + ' was scaled, reflected, tilted or raised; the native model is preserved for review')
    box = face_bounds(api, api.ref('SUGroupGetEntities', group))
    before = guard.get('bounds')
    if (not box or not isinstance(before, list) or len(before) != 2 or
            any(not isinstance(row, list) or len(row) != 3 for row in before) or
            any(abs(box[i][j]-before[i][j]) > 1e-5 for i in range(2) for j in range(3))):
        raise ValueError(label + ' has changed wall dimensions; the native model is preserved for review')
    if (unsupported_group_geometry(api, group, data) or not guard.get('details') or
            guard['details'] != generated_detail_fingerprint(api, group, exclude_managed=False)):
        raise ValueError(label + ' has edited trim, opening or wall geometry; the native model is preserved for review')
    if not guard.get('appearance') or guard['appearance'] != trim_appearance_fingerprint(api, group, material_cache):
        raise ValueError(label + ' has edited trim finishes, tags or visibility; the native model is preserved for review')


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
        appearance_cache = {}
        def check_faces(groups):
            for group in groups:
                data = get_data(api, to_ref(api, 'SUGroupToEntity', group))
                verify_trim_wall(api, group, data, appearance_cache)
                if unsupported_group_geometry(api, group, data):
                    raise ValueError('Local SketchUp face edits need review; the existing mirror was preserved')
                check_faces(api.collection(api.ref('SUGroupGetEntities', group), 'Groups'))
        check_faces(api.collection(entities, 'Groups'))
        for group in api.collection(entities, 'Groups'):
            entity = to_ref(api, 'SUGroupToEntity', group)
            old_data = get_data(api, entity)
            if old_data and old_data.get('kind') in ('trim-detail', 'trim-part'):
                raise ValueError('Generated trim was detached from its wall; the native model is preserved for review')
            if old_data is not None:
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
        tags = tag_layers(api, model, spec.get('tags', []))
        # An element goes on its Tiksi tag; one with none (Untagged) on its level's tag.
        def layer_of(element):
            return tags.get(element.get('tag')) or layers.get(element['level'])
        materials = Materials(api, model, warnings)
        for wall in spec.get('walls', []):
            write_wall(api, entities, wall, layer_of(wall), materials, tags)
        for room in spec.get('rooms', []):
            write_room(api, entities, room, layer_of(room), materials)
        for fixture in spec.get('fixtures', []):
            write_fixture(api, entities, fixture, layer_of(fixture), materials)
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
        appearance_cache = {}
        def stamp(groups):
            for group in groups:
                entity = to_ref(api, 'SUGroupToEntity', group)
                data = get_data(api, entity)
                if data is not None:
                    data['faceFingerprint'] = face_fingerprint(api, group)
                    if data.get('kind') in ('wall', 'opening', 'room', 'fixture'):
                        data['generatedDetailFingerprint'] = generated_detail_fingerprint(api, group)
                    if data.get('trimGuard'):
                        data['trimGuard']['details'] = generated_detail_fingerprint(api, group, exclude_managed=False)
                        data['trimGuard']['appearance'] = trim_appearance_fingerprint(api, group, appearance_cache)
                    set_data(api, entity, data)
                stamp(api.collection(api.ref('SUGroupGetEntities', group), 'Groups'))
        stamp(api.collection(entities, 'Groups'))
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


def read_wall(api, group, data, warnings, material_cache=None):
    verify_trim_wall(api, group, data, material_cache)
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
    across_reflected = m[0]*m[5]-m[1]*m[4] < 0
    base = data.get('base') or {}
    for key in ('trimState', 'trimGeometry'):
        if key in base:
            now[key] = json.loads(json.dumps(base[key]))
    # End A/B follow local x-min/x-max, which are also the reported endpoints. A
    # reflected group moves those ends; swapping the IDs would move paint twice.
    for key in ('materialEndA', 'materialEndB'):
        if isinstance(base.get(key), str) and base[key]:
            now[key] = base[key]
    for key, opposite in (('baseboardPos', 'baseboardNeg'), ('baseboardNeg', 'baseboardPos')):
        source = opposite if across_reflected else key
        value = base.get(source)
        if isinstance(value, dict):
            now[key] = scaled_baseboard(value, axis_scale(m, 1), axis_scale(m, 2))
        elif across_reflected and isinstance(base.get(key), dict):
            now[key] = None   # explicitly remove the old side during the merge
    if isinstance(base.get('profile'), dict):
        now['profile'] = json.loads(json.dumps(base['profile']))
        for key, scale in (('baseboardHeight', axis_scale(m, 2)), ('baseboardDepth', axis_scale(m, 1)),
                           ('baseboardRadius', min(axis_scale(m, 1), axis_scale(m, 2)))):
            value = now['profile'].get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                now['profile'][key] = value if abs(scale-1) < 1e-10 else r6(value*scale)
    if across_reflected:
        warnings.append('Wall ' + str(data.get('id')) + ' was reflected; geometry details follow the reflection, but wall face finishes remain from Tiksi and need review.')
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
        if isinstance((odata.get('base') or {}).get('configuration'), dict):
            onow['configuration'] = json.loads(json.dumps(odata['base']['configuration']))
        if 'floorContinuity' in (odata.get('base') or {}):
            onow['floorContinuity'] = odata['base']['floorContinuity']
        detail = (odata.get('base') or {}).get('detail')
        if isinstance(detail, dict):
            combined = multiply(m, om)
            # The wall's read-back start/end already follow its X direction. Only the
            # opening's own X reflection swaps hinge jambs. Across-wall reflections
            # compose: reflecting both parent and opening cancels the swing flip.
            onow['detail'] = scaled_opening_detail(detail, axis_scale(combined, 0), axis_scale(combined, 1), axis_scale(combined, 2),
                                                   om[0] < 0, across_reflected != (om[5] < 0), odata.get('orientation'))
        profile = (odata.get('base') or {}).get('profile')
        if isinstance(profile, dict):
            combined = multiply(m, om)
            kind = 'window' if odata.get('type') == 'window' else 'door'
            onow['profile'] = scaled_opening_detail({kind: profile}, axis_scale(combined, 0), axis_scale(combined, 1), axis_scale(combined, 2),
                                                    om[0] < 0, across_reflected != (om[5] < 0), odata.get('orientation'))[kind]
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
    if isinstance(base.get('ceilingHeight'), (int, float)):
        now['ceilingHeight'] = r6(base['ceilingHeight']*axis_scale(m, 2))
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
        unsupported_geometry = []
        def inspect(groups):
            for group in groups:
                data = get_data(api, to_ref(api, 'SUGroupToEntity', group)) or {}
                if unsupported_group_geometry(api, group, data):
                    unsupported_geometry.append(data.get('id', 'unknown'))
                    warnings.append('Local face edits in ' + str(data.get('id')) + ' need review; automatic rewriting is blocked.')
                inspect(api.collection(api.ref('SUGroupGetEntities', group), 'Groups'))
        inspect(api.collection(entities, 'Groups'))
        walls, rooms, fixtures, untagged_groups, stray = [], [], [], 0, 0
        appearance_cache = {}
        for group in api.collection(entities, 'Groups'):
            data = get_data(api, to_ref(api, 'SUGroupToEntity', group))
            if data is None:
                untagged_groups += 1
                continue
            kind = data.get('kind')
            if kind in ('trim-detail', 'trim-part'):
                raise ValueError('Generated trim was detached from its wall; the native model is preserved for review')
            if kind == 'wall':
                item = read_wall(api, group, data, warnings, appearance_cache)
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
                'unsupportedGeometry': unsupported_geometry, 'untagged': {'faces': count.value, 'groups': untagged_groups, 'instances': instances.value}, 'warnings': warnings}
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
