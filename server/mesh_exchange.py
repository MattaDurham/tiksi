"""Small static-scene GLB writer shared by local native converters (metres, Y-up).

`meshes` are geometry batches: positions, indices, optional uv, a material spec and extras.
Without `nodes`, every batch is its own top-level node (the flat form the CAD readers use).
With `nodes`, the scene is that tree: each node may name a batch by index (`mesh`), carry a
column-major `matrix`, `extras` and `children`. Several nodes may name one batch: its geometry
is written once and shared, which is how a SketchUp component definition is drawn by every
instance. Materials are written once per distinct look (name, colour, texture, roughness,
metalness), so one source material is one glTF material however many batches use it.
"""
import hashlib
import json
import math
from pathlib import Path
import struct

IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
MAX_NODES = 2000000


def write_glb(meshes, path, nodes=None, scene_extras=None):
    doc = {'asset': {'version': '2.0', 'generator': 'Tiksi native conversion'}, 'scene': 0,
           'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [], 'accessors': [], 'bufferViews': [],
           'materials': [], 'images': [], 'textures': [], 'buffers': []}
    binary = bytearray()
    # Many meshes share one texture (every face batch of a SketchUp material); embed each image once.
    shared_textures = {}
    shared_materials = {}
    written = {}
    def view(data, target=None):
        binary.extend(b'\0' * (-len(binary) % 4))
        rec = {'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(data)}
        if target: rec['target'] = target
        doc['bufferViews'].append(rec); binary.extend(data)
        return len(doc['bufferViews']) - 1
    def accessor(values, size, typ, component=5126):
        if not values or len(values) % size or any(not math.isfinite(v) for v in values): raise ValueError('Invalid native mesh coordinates')
        rec = {'bufferView': view(struct.pack('<' + ('f' if component == 5126 else 'I') * len(values), *values), 34962 if component == 5126 else 34963),
               'componentType': component, 'count': len(values) // size, 'type': typ}
        if typ == 'VEC3': rec.update(min=[min(values[i::3]) for i in range(3)], max=[max(values[i::3]) for i in range(3)])
        doc['accessors'].append(rec); return len(doc['accessors']) - 1
    def texture_index(spec):
        data = Path(spec['texture']).read_bytes()
        key = hashlib.sha256(data).digest()
        if key not in shared_textures:
            mime = 'image/jpeg' if data.startswith(b'\xff\xd8') else 'image/png'
            doc['images'].append({'bufferView': view(data), 'mimeType': mime})
            doc['textures'].append({'source': len(doc['images']) - 1})
            shared_textures[key] = len(doc['textures']) - 1
        return shared_textures[key]
    def material_index(spec):
        color = list(spec.get('color', [0.8, 0.8, 0.8, 1]))
        texture = texture_index(spec) if spec.get('texture') else None
        look = json.dumps([spec.get('name', 'Surface'), color, texture, spec.get('roughness', .8), spec.get('metalness', 0)])
        if look in shared_materials: return shared_materials[look]
        # Inputs use sRGB colours; glTF baseColorFactor uses linear components.
        linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in color[:3]] + color[3:4]
        mat = {'name': spec.get('name', 'Surface'), 'doubleSided': True,
               'pbrMetallicRoughness': {'baseColorFactor': linear, 'roughnessFactor': spec.get('roughness', .8), 'metallicFactor': spec.get('metalness', 0)}}
        if len(linear) > 3 and linear[3] < 1: mat['alphaMode'] = 'BLEND'
        if texture is not None: mat['pbrMetallicRoughness']['baseColorTexture'] = {'index': texture}
        doc['materials'].append(mat)
        shared_materials[look] = len(doc['materials']) - 1
        return shared_materials[look]
    def mesh_index(i):
        """The glTF mesh for batch i, written the first time a node names it; None when empty."""
        if i in written: return written[i]
        if not isinstance(i, int) or i < 0 or i >= len(meshes): raise ValueError('Node names a missing mesh')
        mesh = meshes[i]; p, indices = mesh['positions'], mesh['indices']
        if not indices: written[i] = None; return None
        if len(indices) % 3 or any(j < 0 or j >= len(p) // 3 for j in indices): raise ValueError('Invalid native triangle indices')
        attrs = {'POSITION': accessor(p, 3, 'VEC3')}
        if mesh.get('uv'): attrs['TEXCOORD_0'] = accessor(mesh['uv'], 2, 'VEC2')
        primitive = {'attributes': attrs, 'indices': accessor(indices, 1, 'SCALAR', 5125), 'material': material_index(mesh.get('material', {}))}
        doc['meshes'].append({'name': mesh.get('name', 'Mesh'), 'primitives': [primitive]})
        written[i] = len(doc['meshes']) - 1
        return written[i]
    def emit(node):
        """Write one node and its children; returns its index, or None when it draws nothing."""
        if len(doc['nodes']) >= MAX_NODES: raise ValueError('Model node limit exceeded')
        mesh = mesh_index(node['mesh']) if node.get('mesh') is not None else None
        children = [c for c in (emit(child) for child in node.get('children') or []) if c is not None]
        if mesh is None and not children: return None
        out = {'name': node.get('name') or 'Node'}
        if mesh is not None: out['mesh'] = mesh
        matrix = node.get('matrix')
        if matrix is not None:
            if len(matrix) != 16 or any(not math.isfinite(v) for v in matrix): raise ValueError('Invalid node transform')
            if any(abs(a - b) > 1e-12 for a, b in zip(matrix, IDENTITY)): out['matrix'] = [float(v) for v in matrix]
        if children: out['children'] = children
        if node.get('extras'): out['extras'] = node['extras']
        doc['nodes'].append(out)
        return len(doc['nodes']) - 1
    if nodes is None:
        nodes = [{'name': m.get('name', 'Mesh'), 'mesh': i, 'extras': m.get('extras')} for i, m in enumerate(meshes)]
    for node in nodes:
        index = emit(node)
        if index is not None: doc['scenes'][0]['nodes'].append(index)
    if scene_extras: doc['scenes'][0]['extras'] = scene_extras
    if not doc['meshes']: raise ValueError('No surface/solid geometry found; keep the source for agent-assisted interpretation')
    doc['buffers'] = [{'byteLength': len(binary)}]
    for key in ('images', 'textures'):
        if not doc[key]: del doc[key]
    payload = json.dumps(doc, separators=(',', ':')).encode(); payload += b' ' * (-len(payload) % 4)
    binary.extend(b'\0' * (-len(binary) % 4))
    Path(path).write_bytes(struct.pack('<III', 0x46546c67, 2, 28 + len(payload) + len(binary)) + struct.pack('<II', len(payload), 0x4e4f534a) + payload + struct.pack('<II', len(binary), 0x004e4942) + binary)
    return {'meshes': len(doc['meshes']), 'nodes': len(doc['nodes']), 'materials': len(doc['materials'])}
