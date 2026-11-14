"""The standard view set as SketchUp scenes: the same rules as js/standard-views.js, so a model a
SketchUp build script makes gets the views Tiksi makes for a property: an overview, a plan from
above for each level (parallel, north up, cut 4'-0" above the floor) and one cut-open parallel
elevation for each wall of each room. test/fixtures/standard-views.json holds inputs and the set
both copies must make from them; keep the two in step.

Input (Tiksi plan metres; world x = plan x, world z = plan y, world y up):
  { north, levels: [{ id, name, elevation, height }], rooms: [{ id, name, level, z, height,
    pts: [[x, y]] }], walls: [{ level, ax, ay, bx, by }] }
`from_sync_file` reads it from the Tiksi groups of a SketchUp sync file.
"""
import json
import math
import re

if __package__:
    from .sketchup_convert import Ref, get_data, to_ref
    from .sketchup_scenes import model_scenes, write_views
else:
    from sketchup_convert import Ref, get_data, to_ref
    from sketchup_scenes import model_scenes, write_views

RULES = {'fov': 50, 'aspect': 1.5, 'margin': 1.12, 'planCut': 1.2192, 'minWall': 0.6096,
         'cutInset': 0.0254, 'straight': 1, 'height': 2.44}
DEG = math.pi / 180
R = math.sqrt(0.5)
PARALLEL_BACK = 100   # m (328'-1"): how far back a parallel scene's camera stands
COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']


def js_round(v):
    """Math.round: halves go up."""
    return math.floor(v + 0.5)


def r6(v):
    v = js_round(v * 1e6) / 1e6
    return 0.0 if v == 0 else v


def v6(a):
    return [r6(x) for x in a]


def area(pts):
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts))) / 2


def room_walls(pts):
    ring = [p for i, p in enumerate(pts) if math.hypot(pts[(i + 1) % len(pts)][0] - p[0], pts[(i + 1) % len(pts)][1] - p[1]) > 1e-6]
    turn = math.sin(RULES['straight'] * DEG)
    i = 0
    while len(ring) > 3 and i < len(ring):
        p, q, s = ring[(i + len(ring) - 1) % len(ring)], ring[i], ring[(i + 1) % len(ring)]
        d1, d2 = [q[0] - p[0], q[1] - p[1]], [s[0] - q[0], s[1] - q[1]]
        cross = (d1[0] * d2[1] - d1[1] * d2[0]) / (math.hypot(*d1) * math.hypot(*d2))
        if abs(cross) < turn and d1[0] * d2[0] + d1[1] * d2[1] > 0:
            ring.pop(i); i = 0
        else:
            i += 1
    out = []
    for i, a in enumerate(ring):
        b = ring[(i + 1) % len(ring)]
        out.append({'a': a, 'b': b, 'length': math.hypot(b[0] - a[0], b[1] - a[1])})
    return out


def compass(dx, dy, north):
    n = north * DEG
    N, E = [math.sin(n), -math.cos(n)], [math.cos(n), math.sin(n)]
    bearing = math.atan2(dx * E[0] + dy * E[1], dx * N[0] + dy * N[1]) / DEG
    return COMPASS[(js_round(bearing / 45) % 8 + 8) % 8]


def parallel_camera(target, d3, half_h):
    d = half_h / math.tan(RULES['fov'] * DEG / 2)
    return {'position': v6([target[i] - d3[i] * d for i in range(3)]), 'target': v6(target), 'fov': RULES['fov'], 'parallel': True}


def extent(points, axis):
    values = [p[0] * axis[0] + p[1] * axis[1] for p in points]
    return min(values), max(values)


def standard_set(data):
    """The set, in order: overview, plans, elevations (saved views without ids, each with
    standard: { key, name }), exactly as js/standard-views.js standardSet makes it."""
    out = []
    levels, rooms, walls = data.get('levels') or [], data.get('rooms') or [], data.get('walls') or []
    used = [l for l in levels if any(r['level'] == l['id'] for r in rooms) or any(w['level'] == l['id'] for w in walls)]
    if not used:
        return out
    north = data.get('north') or 0

    def points_on(lid):
        return [p for r in rooms if r['level'] == lid for p in r['pts']] + \
               [p for w in walls if w['level'] == lid for p in ([w['ax'], w['ay']], [w['bx'], w['by']])]

    def others(lid):
        return [l['id'] for l in levels if l['id'] != lid]

    def view(key, name, camera, mode, section, hidden_levels):
        return {'name': name, 'camera': camera, 'mode': mode, 'tags': {}, 'section': section, 'xray': False,
                'hiddenLevels': hidden_levels, 'standard': {'key': key, 'name': name}}

    every = [p for l in used for p in points_on(l['id'])]
    x0, x1 = extent(every, [1, 0]); y0, y1 = extent(every, [0, 1])
    z0 = min(l['elevation'] for l in used); z1 = max(l['elevation'] + l['height'] for l in used)
    direction = [-0.72, 0.62, 0.72]; dl = math.hypot(*direction)
    target = [(x0 + x1) / 2, z0 + (z1 - z0) * 0.45, (y0 + y1) / 2]
    d = math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 / math.sin(RULES['fov'] * DEG / 2) * 1.08
    out.append(view('overview', 'Overview', {'position': v6([target[i] + direction[i] / dl * d for i in range(3)]), 'target': v6(target), 'fov': RULES['fov']},
                    'orbit', {'on': False, 'height': 1.2}, []))

    n = north * DEG
    N, E = [math.sin(n), -math.cos(n)], [math.cos(n), math.sin(n)]
    for l in used:
        pts = points_on(l['id'])
        e0, e1 = extent(pts, E); n0, n1 = extent(pts, N)
        ce, cn = (e0 + e1) / 2, (n0 + n1) / 2
        cx, cy = E[0] * ce + N[0] * cn, E[1] * ce + N[1] * cn
        half_h = max(n1 - n0, (e1 - e0) / RULES['aspect']) / 2 * RULES['margin']
        d3 = [N[0] * 0.002, -1, N[1] * 0.002]; dl = math.hypot(*d3)
        cut = {'id': 'cut-std-plan', 'kind': 'level', 'q': [-R, 0, 0, R], 'pos': v6([cx, l['elevation'] + RULES['planCut'], cy])}
        out.append(view('plan:' + l['id'], 'Plan, ' + l['name'][:50] if len(used) > 1 else 'Plan',
                        parallel_camera([cx, l['elevation'], cy], [c / dl for c in d3], half_h), 'top',
                        {'on': True, 'height': r6(l['elevation'] + RULES['planCut']), 'planes': [cut], 'active': cut['id'], 'done': True}, others(l['id'])))

    for ri, room in enumerate(rooms):
        if not any(l['id'] == room['level'] for l in levels):
            continue
        ccw = area(room['pts']) > 0
        label = ((room.get('name') or '').strip() or 'Room ' + str(ri + 1))[:40]
        seen = {}
        for w in room_walls(room['pts']):
            if w['length'] < RULES['minWall']:
                continue
            ux, uy = (w['b'][0] - w['a'][0]) / w['length'], (w['b'][1] - w['a'][1]) / w['length']
            nx, ny = (-uy, ux) if ccw else (uy, -ux)
            side = compass(-nx, -ny, north)
            seen[side] = seen.get(side, 0) + 1
            depth = max((p[0] - w['a'][0]) * nx + (p[1] - w['a'][1]) * ny for p in room['pts'])
            cut_at = depth - RULES['cutInset'] if depth > 2 * RULES['cutInset'] else depth / 2
            mx, my = (w['a'][0] + w['b'][0]) / 2, (w['a'][1] + w['b'][1]) / 2
            mid = room['z'] + room['height'] / 2
            half_h = max(room['height'], w['length'] / RULES['aspect']) / 2 * RULES['margin']
            yaw = math.atan2(nx, ny)
            cut = {'id': 'cut-std-elev', 'kind': 'custom', 'q': v6([0, math.sin(yaw / 2), 0, math.cos(yaw / 2)]), 'pos': v6([mx + nx * cut_at, mid, my + ny * cut_at])}
            name = label + ', ' + side + ' wall' + (' ' + str(seen[side]) if seen[side] > 1 else '')
            out.append(view('elevation:' + room['id'] + ':' + side + ':' + str(seen[side]), name,
                            parallel_camera([mx, mid, my], [-nx, 0, -ny], half_h), 'orbit',
                            {'on': True, 'height': 1.2, 'planes': [cut], 'active': cut['id'], 'done': True}, others(room['level'])))
    return out[:100]


# ---------- as scenes ----------

def quat_z(q):
    """section-planes.js planeNormal: the quaternion's turn of +Z."""
    x, y, z, w = q
    return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]


def scene_of(view, levels, north=0, view_id=None):
    """A saved view as sketchup_scenes.write_views takes it (js/mirror-views.js viewScene)."""
    c = view['camera']
    eye, target = list(c['position']), list(c['target'])
    parallel = c.get('parallel') is True
    fov = c.get('fov') or 50
    form = {'name': view['name'][:200] or 'View', 'perspective': not parallel, 'eye': eye, 'target': target}
    if parallel:
        form['height'] = r6(2 * math.dist(eye, target) * math.tan(fov * DEG / 2))
    else:
        form['fov'] = r6(fov)
    names = {l['id']: 'Tiksi: ' + (l.get('name') or l['id']) for l in levels}
    form['hidden'] = sorted({names[i] for i in view.get('hiddenLevels') or [] if i in names})
    s = view.get('section') or {}
    planes = s.get('planes') or []
    plane = next((p for p in planes if p['id'] == s.get('active')), planes[0] if planes else None) if s.get('on') else None
    form['cut'] = {'point': list(plane['pos']), 'normal': v6(quat_z(plane['q']))} if plane else None
    direction = [target[i] - eye[i] for i in range(3)]
    length = math.hypot(*direction) or 1
    direction = [v / length for v in direction]
    up = [0, 1, 0]
    if abs(direction[1]) > 0.9995:
        flat = math.hypot(direction[0], direction[2])
        up = [direction[0] / flat, 0, direction[2] / flat] if flat > 1e-12 else [math.sin(north * DEG), 0, -math.cos(north * DEG)]
        if direction[1] > 0: up = [-v for v in up]
    # A parallel scene's camera stands well back, past any cut (js/mirror-views.js viewScene).
    if parallel:
        back = max(PARALLEL_BACK, math.dist(eye, target))
        eye = [target[i] - direction[i] * back for i in range(3)]
    camera = {'eye': v6(eye), 'target': v6(target), 'up': v6(up), 'perspective': not parallel}
    if parallel: camera['height'] = form['height']
    else: camera['fov'] = form['fov']
    if view.get('standard'): form['standard'] = view['standard']
    return {'id': view_id or view.get('id'), 'name': form['name'], 'camera': camera, 'hidden': form['hidden'], 'cut': form['cut'], 'base': form}


def scene_id(key):
    return 'std-' + re.sub(r'[^\w.:-]', '-', key)[:76]


def from_sync_file(api, model, north=0):
    """The rules' input from the Tiksi groups of a SketchUp sync file (sketchup_mirror.py): rooms
    and walls as Tiksi wrote them, levels by elevation, heights from the walls on them."""
    entities = api.ref('SUModelGetEntities', model)
    rooms, walls = [], []
    for group in api.collection(entities, 'Groups'):
        data = get_data(api, to_ref(api, 'SUGroupToEntity', group)) or {}
        base = data.get('base') or {}
        if data.get('kind') == 'room' and len(base.get('pts') or []) >= 3:
            rooms.append({'id': data.get('id') or 'room', 'name': base.get('name') or '', 'z': base.get('elevation') or 0, 'pts': base['pts'], 'ceiling': base.get('ceilingHeight')})
        elif data.get('kind') == 'wall' and all(k in base for k in ('ax', 'ay', 'bx', 'by')):
            walls.append({'z': base.get('elevation') or 0, 'height': base.get('height') or RULES['height'], 'ax': base['ax'], 'ay': base['ay'], 'bx': base['bx'], 'by': base['by']})
    elevations = sorted({round(r['z'], 4) for r in rooms} | {round(w['z'], 4) for w in walls})
    levels = []
    for i, z in enumerate(elevations):
        heights = [w['height'] for w in walls if round(w['z'], 4) == z]
        levels.append({'id': 'level-' + str(i + 1), 'name': 'Level ' + str(i + 1), 'elevation': z, 'height': max(heights) if heights else RULES['height']})
    lid = {l['elevation']: l['id'] for l in levels}
    height = {l['id']: l['height'] for l in levels}
    out_rooms = [{'id': r['id'], 'name': r['name'], 'level': lid[round(r['z'], 4)], 'z': r['z'],
                  'height': r['ceiling'] if r['ceiling'] and r['ceiling'] > 0 else height[lid[round(r['z'], 4)]], 'pts': r['pts']} for r in rooms]
    out_walls = [{'level': lid[round(w['z'], 4)], 'ax': w['ax'], 'ay': w['ay'], 'bx': w['bx'], 'by': w['by']} for w in walls]
    return {'north': north, 'levels': levels, 'rooms': out_rooms, 'walls': out_walls}


def add_standard_scenes(api, model, data, warnings):
    """Add or refresh the standard scenes in a model. They have ids 'std-<what they show>'; a view
    of the set Tiksi already wrote into the file (a sync file) is not made twice. Returns the
    number of scenes written."""
    have = set()
    for scene in model_scenes(api, model):
        d = get_data(api, to_ref(api, 'SUSceneToEntity', scene)) or {}
        key = ((d.get('base') or {}).get('standard') or {}).get('key')
        if d.get('kind') == 'view' and key and not str(d.get('id', '')).startswith('std-'): have.add(key)
    views = [scene_of(v, data.get('levels') or [], data.get('north') or 0, scene_id(v['standard']['key']))
             for v in standard_set(data) if v['standard']['key'] not in have]
    known = {'Tiksi: ' + (l.get('name') or l['id']) for l in data.get('levels') or []}
    return write_views(api, model, views, known, warnings, owns=lambda vid: vid.startswith('std-'))


if __name__ == '__main__':
    import sys
    data = json.load(sys.stdin)
    json.dump(standard_set(data), sys.stdout)
