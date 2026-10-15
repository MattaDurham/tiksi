"""Native SKP reader/writer using the locally installed SketchUp C API.

Only documented API entry points are used. No SketchUp libraries are redistributed.
Every invocation is a separate process, operating on uploaded/synthetic files only.
"""
import base64
import ctypes as C
import json
import math
import os
from pathlib import Path
import sys

class Ref(C.Structure): _fields_ = [('ptr', C.c_void_p)]
class Point(C.Structure): _fields_ = [('x', C.c_double), ('y', C.c_double), ('z', C.c_double)]
class Point2(C.Structure): _fields_ = [('x', C.c_double), ('y', C.c_double)]
class Mapping(C.Structure): _fields_ = [('num_uv_coords', C.c_size_t), ('uv_coords', Point2 * 4), ('points', Point * 4), ('material', Ref), ('projection', Point)]
class Transform(C.Structure): _fields_ = [('values', C.c_double * 16)]
class Color(C.Structure): _fields_ = [('red', C.c_ubyte), ('green', C.c_ubyte), ('blue', C.c_ubyte), ('alpha', C.c_ubyte)]


def library_path():
    configured = os.environ.get('TIKSI_SKETCHUP_API')
    if configured: return Path(configured)
    paths = sorted(Path('/Applications').glob('SketchUp */SketchUp.app/Contents/Frameworks/SketchUpAPI.framework/SketchUpAPI'))
    return paths[-1] if paths else None

class API:
    def __init__(self):
        path = library_path()
        if not path or not path.is_file(): raise ValueError('Install SketchUp or set TIKSI_SKETCHUP_API to its C SDK library')
        self.lib = C.CDLL(str(path))
        self.lib.SUInitialize()
    def call(self, name, *args, optional=False):
        fn = getattr(self.lib, name); fn.restype = C.c_int
        code = fn(*args)
        if code and not optional: raise ValueError(f'{name} failed (SketchUp status {code})')
        return code
    def ref(self, name, *args):
        out = Ref(); self.call(name, *args, C.byref(out)); return out
    def text(self, name, ref):
        string = self.ref('SUStringCreate')
        try:
            self.call(name, ref, C.byref(string)); size = C.c_size_t()
            self.call('SUStringGetUTF8Length', string, C.byref(size))
            data = C.create_string_buffer(size.value + 1)
            self.call('SUStringGetUTF8', string, C.c_size_t(len(data)), data, C.byref(size))
            return data.value.decode('utf-8')
        finally: self.call('SUStringRelease', C.byref(string))
    def collection(self, ref, kind):
        count = C.c_size_t(); self.call('SUEntitiesGetNum' + kind, ref, C.byref(count))
        if count.value > 2000000: raise ValueError('SKP entity limit exceeded')
        values = (Ref * count.value)()
        if count.value: self.call('SUEntitiesGet' + kind, ref, count, values, C.byref(count))
        return values

IDENTITY = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
def multiply(a,b): return [sum(a[k*4+r]*b[c*4+k] for k in range(4)) for c in range(4) for r in range(4)]
def transform(p,m): return [sum(m[k*4+r]*v for k,v in enumerate([p.x,p.y,p.z,1])) for r in range(3)]
def from_skp(p): return [p[0]*.0254,p[2]*.0254,-p[1]*.0254]
def to_skp(p): return Point(p[0]/.0254,-p[2]/.0254,p[1]/.0254)


def read_skp(source, output):
    if __package__:from .mesh_exchange import write_glb
    else:from mesh_exchange import write_glb
    api = API(); model = Ref(); meshes = []; material_cache = {}; warnings = []
    try:
        api.call('SUModelCreateFromFile', C.byref(model), os.fsencode(source))
        entities = api.ref('SUModelGetEntities', model)
        def material(ref):
            if not ref.ptr: return {}
            if ref.ptr in material_cache: return material_cache[ref.ptr]
            color = Color(204,204,204,255); api.call('SUMaterialGetColor', ref, C.byref(color), optional=True)
            opacity = C.c_double(1); api.call('SUMaterialGetOpacity', ref, C.byref(opacity), optional=True)
            spec = {'name': api.text('SUMaterialGetName',ref), 'color': [color.red/255,color.green/255,color.blue/255,opacity.value]}
            tex = Ref()
            if not api.call('SUMaterialGetTexture', ref, C.byref(tex), optional=True) and tex.ptr:
                path = Path(output).parent / ('texture-' + str(len(material_cache)) + '.png')
                api.call('SUTextureWriteToFile',tex,os.fsencode(path)); spec['texture']=str(path)
            material_cache[ref.ptr]=spec; return spec
        def walk(entities, matrix, name, inherited=Ref(), depth=0):
            if depth > 64 or len(meshes) > 2000000: raise ValueError('SKP hierarchy limit exceeded')
            faces = api.collection(entities,'Faces')
            batches = {}
            for face in faces:
                mat = Ref(); api.call('SUFaceGetFrontMaterial',face,C.byref(mat),optional=True)
                if not mat.ptr: mat=inherited
                batch = batches.setdefault(mat.ptr,{'name':name,'positions':[],'uv':[],'indices':[],'material':material(mat)})
                mesh=Ref();api.call('SUMeshHelperCreate',C.byref(mesh),face)
                try:
                    count=C.c_size_t();api.call('SUMeshHelperGetNumVertices',mesh,C.byref(count));verts=(Point*count.value)();stq=(Point*count.value)()
                    api.call('SUMeshHelperGetVertices',mesh,count,verts,C.byref(count))
                    api.call('SUMeshHelperGetFrontSTQCoords',mesh,count,stq,C.byref(count))
                    offset=len(batch['positions'])//3
                    for v,u in zip(verts,stq):
                        batch['positions'].extend(from_skp(transform(v,matrix)))
                        q=u.z or 1;batch['uv'].extend([u.x/q,1-u.y/q])
                    triangles=C.c_size_t();api.call('SUMeshHelperGetNumTriangles',mesh,C.byref(triangles));n=C.c_size_t(triangles.value*3);indices=(C.c_size_t*n.value)()
                    api.call('SUMeshHelperGetVertexIndices',mesh,n,indices,C.byref(n))
                    # Mirrored component instances reverse orientation.
                    det=matrix[0]*(matrix[5]*matrix[10]-matrix[9]*matrix[6])-matrix[4]*(matrix[1]*matrix[10]-matrix[9]*matrix[2])+matrix[8]*(matrix[1]*matrix[6]-matrix[5]*matrix[2])
                    for i in range(0,len(indices),3):
                        order=[indices[i],indices[i+1],indices[i+2]]
                        if det<0:order.reverse()
                        batch['indices'].extend(v+offset for v in order)
                finally:api.call('SUMeshHelperRelease',C.byref(mesh))
            meshes.extend(batches.values())
            for kind in ['Groups','Instances']:
                for child in api.collection(entities,kind):
                    if kind=='Groups':
                        get=api.lib.SUGroupToComponentInstance;get.restype=Ref;instance=get(child)
                        nested=api.ref('SUGroupGetEntities',child);child_name=api.text('SUGroupGetName',child)
                    else:
                        instance=child;definition=api.ref('SUComponentInstanceGetDefinition',child)
                        nested=api.ref('SUComponentDefinitionGetEntities',definition);child_name=api.text('SUComponentDefinitionGetName',definition)
                    t=Transform();api.call('SUComponentInstanceGetTransform',instance,C.byref(t))
                    mat=Ref();get=api.lib.SUComponentInstanceToDrawingElement;get.restype=Ref
                    api.call('SUDrawingElementGetMaterial',get(instance),C.byref(mat),optional=True)
                    walk(nested,multiply(matrix,list(t.values)),child_name or name,mat if mat.ptr else inherited,depth+1)
            for suffix in ['Images','Texts','Dimensions','SectionPlanes']:
                count=C.c_size_t();api.call('SUEntitiesGetNum'+suffix,entities,C.byref(count))
                if count.value:warnings.append(f'{count.value} {suffix.lower()} retained in original SKP; not represented in mesh')
        walk(entities,IDENTITY,'SketchUp model');write_glb(meshes,output)
        return {'warnings': sorted(set(warnings))+['Native SKP faces, holes, component placements, names, diffuse textures and colours converted. Scenes, guides, dynamic component logic and PBR extensions remain in the source SKP.']}
    finally:
        if model.ptr:api.call('SUModelRelease',C.byref(model))
        api.lib.SUTerminate()


def write_skp(source, output):
    # JSON triangles are produced by the browser's world-space static exporter.
    api=API();model=Ref();data=json.loads(Path(source).read_text(encoding='utf-8'))
    try:
        api.call('SUModelCreate',C.byref(model));entities=api.ref('SUModelGetEntities',model)
        for part in data['meshes']:
            group=Ref();api.call('SUGroupCreate',C.byref(group));api.call('SUGroupSetName',group,part['name'].encode());api.call('SUEntitiesAddGroup',entities,group)
            target=api.ref('SUGroupGetEntities',group)
            mat=Ref();api.call('SUMaterialCreate',C.byref(mat));spec=part.get('material',{})
            api.call('SUMaterialSetName',mat,spec.get('name','Surface').encode())
            rgba=spec.get('color',[.8,.8,.8,1]);color=Color(*(round(v*255) for v in rgba));api.call('SUMaterialSetColor',mat,C.byref(color))
            api.call('SUMaterialSetOpacity',mat,C.c_double(rgba[3]));api.call('SUModelAddMaterials',model,C.c_size_t(1),(Ref*1)(mat))
            texture = spec.get('texture')
            if texture:
                path=Path(output).parent/('write-texture-'+str(group.ptr)+'.png')
                path.write_bytes(base64.b64decode(texture,validate=True))
                tex=Ref();api.call('SUTextureCreateFromFile',C.byref(tex),os.fsencode(path),C.c_double(1),C.c_double(1));api.call('SUMaterialSetTexture',mat,tex)
            uv=part.get('uv',[])
            p=part['positions']
            if len(p)%9:raise ValueError('SKP writer expects expanded triangles')
            for i in range(0,len(p),9):
                verts=(Point*3)(*(to_skp(p[j:j+3]) for j in [i,i+3,i+6]))
                face=Ref();api.call('SUFaceCreateSimple',C.byref(face),verts,C.c_size_t(3))
                api.call('SUEntitiesAddFaces',target,C.c_size_t(1),(Ref*1)(face));api.call('SUFaceSetFrontMaterial',face,mat)
                api.call('SUFaceSetBackMaterial',face,mat)
                if texture:
                    mapping=Mapping();mapping.num_uv_coords=3;mapping.material=mat
                    for k in range(3):
                        mapping.points[k]=verts[k];j=(i//3+k)*2
                        mapping.uv_coords[k]=Point2(uv[j],1-uv[j+1])
                    api.call('SUFacePositionMaterial',face,C.c_bool(True),C.byref(mapping))
                    api.call('SUFacePositionMaterial',face,C.c_bool(False),C.byref(mapping))
        api.call('SUModelSaveToFile',model,os.fsencode(output))
        return {'warnings':['Native SKP contains editable grouped triangle faces, diffuse textures and colours. Use GLB for PBR map fidelity.']}
    finally:
        if model.ptr:api.call('SUModelRelease',C.byref(model))
        api.lib.SUTerminate()

if __name__=='__main__':
    # CLI paths are supplied only by the local service, never accepted from HTTP payloads.
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
    try:print(json.dumps(read_skp(sys.argv[1],sys.argv[2]) if Path(sys.argv[1]).suffix.lower()=='.skp' else write_skp(sys.argv[1],sys.argv[2])))
    except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
