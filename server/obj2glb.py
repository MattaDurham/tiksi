"""Pack Object Capture's textured OBJ output into a self-contained glTF 2.0 binary.

No decimation, texture resizing or network dependencies. Coordinate scale is preserved;
ordinary photos without camera depth cannot establish metric scale by themselves.
"""
import array
import json
import math
from pathlib import Path
import shlex
import struct
import sys


def inside(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Model references a file outside its output folder")
    return path


def convert(obj_path, destination):
    obj_path, destination = Path(obj_path), Path(destination)
    root = obj_path.parent.resolve()
    positions, normals, uvs, material_libs = [], [], [], []
    groups, material = {}, "default"
    with obj_path.open(encoding="utf-8") as source:
        for line in source:
            parts = line.strip().split()
            if not parts or parts[0].startswith("#"):
                continue
            command = parts[0]
            if command in ("v", "vn", "vt"):
                values = tuple(float(v) for v in parts[1:4 if command != "vt" else 3])
                if not all(math.isfinite(v) for v in values):
                    raise ValueError("Non-finite OBJ coordinates")
                if command == "v": positions.append(values)
                elif command == "vn": normals.append(values)
                else: uvs.append(values)
            elif command == "mtllib": material_libs.extend(shlex.split(line.strip())[1:])
            elif command == "usemtl": material = " ".join(parts[1:])
            elif command == "f":
                vertices = []
                for reference in parts[1:]:
                    ids = reference.split("/")
                    resolved = []
                    for i, seq in enumerate((positions, uvs, normals)):
                        n = int(ids[i]) if i < len(ids) and ids[i] else None
                        index = (n - 1 if n > 0 else len(seq) + n) if n is not None else None
                        if index is not None and not 0 <= index < len(seq): raise ValueError("Invalid OBJ vertex index")
                        resolved.append(index)
                    if resolved[0] is None: raise ValueError("Face has no position")
                    vertices.append(tuple(resolved))
                for i in range(1, len(vertices) - 1):
                    groups.setdefault(material, []).extend((vertices[0], vertices[i], vertices[i + 1]))
    if not groups: raise ValueError("Reconstruction contains no triangles")
    mats = {}
    for library in material_libs:
        current = None
        with inside(root, library).open(encoding="utf-8") as source:
            for line in source:
                parts = shlex.split(line, comments=True)
                if not parts: continue
                if parts[0] == "newmtl": current = " ".join(parts[1:]); mats[current] = {}
                elif current and parts[0] in {"map_Kd", "norm", "map_ao", "map_Pr", "disp"}:
                    # Apple emits plain relative paths. Unknown options must be reported,
                    # rather than silently importing a gray model.
                    if parts[1].startswith("-"): raise ValueError("Texture map options are unsupported")
                    key = {"map_Kd": "texture", "norm": "normal", "map_ao": "occlusion", "map_Pr": "roughness", "disp": "displacement"}[parts[0]]
                    mats[current][key] = " ".join(parts[1:])
                elif current and parts[0] == "Kd": mats[current]["color"] = [float(v) for v in parts[1:4]]
    document = {"asset": {"version": "2.0", "generator": "Tiksi Object Capture"}, "scene": 0,
                "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}], "meshes": [{"primitives": []}],
                "bufferViews": [], "accessors": [], "materials": [], "textures": [], "images": [], "buffers": []}
    binary = bytearray()
    def view(data, target=None):
        binary.extend(b"\0" * (-len(binary) % 4))
        rec = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(data)}
        if target: rec["target"] = target
        document["bufferViews"].append(rec); binary.extend(data)
        return len(document["bufferViews"]) - 1
    def accessor(data, size, kind, component, target, bounds=False):
        if sys.byteorder != "little": data.byteswap()
        rec = {"bufferView": view(data.tobytes(), target), "componentType": component, "count": len(data) // size, "type": kind}
        if bounds:
            rec["min"] = [min(data[i::size]) for i in range(size)]
            rec["max"] = [max(data[i::size]) for i in range(size)]
        document["accessors"].append(rec)
        return len(document["accessors"]) - 1
    triangles = 0
    for name, refs in groups.items():
        lookup, p, n, uv, indices = {}, array.array("f"), array.array("f"), array.array("f"), array.array("I")
        has_uv = all(r[1] is not None for r in refs)
        has_normal = all(r[2] is not None for r in refs)
        for ref in refs:
            if ref not in lookup:
                lookup[ref] = len(lookup)
                p.extend(positions[ref[0]])
                if has_uv: uv.extend((uvs[ref[1]][0], 1 - uvs[ref[1]][1]))
                if has_normal: n.extend(normals[ref[2]])
            indices.append(lookup[ref])
        attributes = {"POSITION": accessor(p, 3, "VEC3", 5126, 34962, True)}
        if has_normal: attributes["NORMAL"] = accessor(n, 3, "VEC3", 5126, 34962)
        if has_uv: attributes["TEXCOORD_0"] = accessor(uv, 2, "VEC2", 5126, 34962)
        material_spec = mats.get(name, {})
        pbr = {"baseColorFactor": material_spec.get("color", [1, 1, 1]) + [1], "metallicFactor": 0, "roughnessFactor": .8}
        gltf_material = {"name": name, "doubleSided": True, "pbrMetallicRoughness": pbr}
        for key in ("texture", "normal", "occlusion", "roughness"):
            if key not in material_spec: continue
            if not has_uv: raise ValueError("Textured geometry has missing UV coordinates")
            texture = inside(root, material_spec[key])
            data = texture.read_bytes()
            mime = "image/png" if data.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg" if data.startswith(b"\xff\xd8") else None
            if not mime: raise ValueError("Object Capture texture must be PNG or JPEG")
            image_index = len(document["images"])
            document["images"].append({"bufferView": view(data), "mimeType": mime})
            document["textures"].append({"source": image_index})
            texture_ref = {"index": len(document["textures"]) - 1}
            if key == "texture":
                pbr["baseColorTexture"] = texture_ref
                pbr["baseColorFactor"] = [1, 1, 1, 1]
            elif key == "normal": gltf_material["normalTexture"] = texture_ref
            elif key == "occlusion": gltf_material["occlusionTexture"] = texture_ref
            elif key == "roughness":
                # Native grayscale PNG expands equally into RGB; glTF reads G for
                # roughness. MetallicFactor=0 suppresses its unused blue channel.
                pbr["metallicRoughnessTexture"] = texture_ref
                pbr["roughnessFactor"] = 1
        document["materials"].append(gltf_material)
        document["meshes"][0]["primitives"].append({"attributes": attributes, "indices": accessor(indices, 1, "SCALAR", 5125, 34963), "material": len(document["materials"]) - 1})
        triangles += len(indices) // 3
    document["buffers"] = [{"byteLength": len(binary)}]
    encoded = json.dumps(document, separators=(",", ":"), allow_nan=False).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4); binary.extend(b"\0" * (-len(binary) % 4))
    with destination.open("wb") as stream:
        stream.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(encoded) + 8 + len(binary)))
        stream.write(struct.pack("<I4s", len(encoded), b"JSON")); stream.write(encoded)
        stream.write(struct.pack("<I4s", len(binary), b"BIN\0")); stream.write(binary)
    return {"triangles": triangles, "textures": len(document["images"]), "bytes": destination.stat().st_size,
            "displacementMaps": sum("displacement" in material for material in mats.values())}


if __name__ == "__main__":
    if len(sys.argv) != 3: raise SystemExit("Usage: python -m server.obj2glb INPUT.obj OUTPUT.glb")
    print(json.dumps(convert(sys.argv[1], sys.argv[2])))
