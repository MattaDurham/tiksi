"""Small static-scene GLB writer shared by local native converters (metres, Y-up)."""
import base64
import json
import math
from pathlib import Path
import struct


def write_glb(meshes, path):
    doc = {'asset': {'version': '2.0', 'generator': 'Tiksi native conversion'}, 'scene': 0,
           'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [], 'accessors': [], 'bufferViews': [],
           'materials': [], 'images': [], 'textures': [], 'buffers': []}
    binary = bytearray()
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
    for mesh in meshes:
        p, indices = mesh['positions'], mesh['indices']
        if not indices: continue
        if len(indices) % 3 or any(i < 0 or i >= len(p) // 3 for i in indices): raise ValueError('Invalid native triangle indices')
        spec = mesh.get('material', {})
        color = spec.get('color', [0.8, 0.8, 0.8, 1])
        # Inputs use sRGB colours; glTF baseColorFactor uses linear components.
        linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in color[:3]] + color[3:4]
        mat = {'name': spec.get('name', 'Surface'), 'doubleSided': True,
               'pbrMetallicRoughness': {'baseColorFactor': linear, 'roughnessFactor': spec.get('roughness', .8), 'metallicFactor': spec.get('metalness', 0)}}
        if linear[3] < 1: mat['alphaMode'] = 'BLEND'
        if spec.get('texture'):
            texture = Path(spec['texture']); data = texture.read_bytes()
            mime = 'image/jpeg' if data.startswith(b'\xff\xd8') else 'image/png'
            doc['images'].append({'bufferView': view(data), 'mimeType': mime})
            doc['textures'].append({'source': len(doc['images']) - 1})
            mat['pbrMetallicRoughness']['baseColorTexture'] = {'index': len(doc['textures']) - 1}
        doc['materials'].append(mat)
        attrs = {'POSITION': accessor(p, 3, 'VEC3')}
        if mesh.get('uv'): attrs['TEXCOORD_0'] = accessor(mesh['uv'], 2, 'VEC2')
        primitive = {'attributes': attrs, 'indices': accessor(indices, 1, 'SCALAR', 5125), 'material': len(doc['materials']) - 1}
        doc['meshes'].append({'name': mesh.get('name', 'Mesh'), 'primitives': [primitive]})
        node = {'name': mesh.get('name', 'Mesh'), 'mesh': len(doc['meshes']) - 1}
        if mesh.get('extras'): node['extras'] = mesh['extras']
        doc['nodes'].append(node); doc['scenes'][0]['nodes'].append(len(doc['nodes']) - 1)
    if not doc['meshes']: raise ValueError('No surface/solid geometry found; keep the source for agent-assisted interpretation')
    doc['buffers'] = [{'byteLength': len(binary)}]
    payload = json.dumps(doc, separators=(',', ':')).encode(); payload += b' ' * (-len(payload) % 4)
    binary.extend(b'\0' * (-len(binary) % 4))
    Path(path).write_bytes(struct.pack('<III', 0x46546c67, 2, 28 + len(payload) + len(binary)) + struct.pack('<II', len(payload), 0x4e4f534a) + payload + struct.pack('<II', len(binary), 0x004e4942) + binary)
