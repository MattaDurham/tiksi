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

def hidden_warnings(tag_faces, hidden):
    """Import warnings for the geometry read_skp leaves out because the SKP hides it.
    tag_faces: faces per hidden tag; hidden: faces in, and counts of, entities hidden themselves."""
    def count(n, noun): return f'{n:,} ' + (noun if n != 1 else noun[:-1])
    out = []
    if tag_faces:
        names = sorted(tag_faces, key=lambda tag: (-tag_faces[tag], tag.casefold()))
        listed = ', '.join(names[:24]) + (f' and {len(names)-24} more' if len(names) > 24 else '')
        out.append(f'{count(sum(tag_faces.values()),"faces")} on {count(len(names),"hidden tags")} ({listed}) kept in the source SKP, not shown')
    parts = [count(n, kind) for kind, n in hidden.items() if kind != 'total' and n]
    if parts: out.append(f'{count(hidden["total"],"faces")} hidden in SketchUp ({", ".join(parts)}) kept in the source SKP, not shown')
    return out


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
        # Geometry the file hides stays in the source SKP and is counted for the import warning.
        tags = {}; tag_faces = {}; hidden = {'total':0,'groups':0,'component instances':0,'single faces':0}; face_totals = {}
        untagged = api.ref('SUModelGetDefaultLayer',model)
        def hidden_tag(element, nested):
            """Name of the element's tag when that tag, or a tag folder holding it, is switched off.
            As in SketchUp, untagged entities inside a group or component follow their container."""
            layer = Ref()
            if api.call('SUDrawingElementGetLayer',element,C.byref(layer),optional=True) or not layer.ptr: return None
            if nested and layer.ptr == untagged.ptr: return None
            if layer.ptr not in tags:
                visible = C.c_bool(True); api.call('SULayerGetVisibility',layer,C.byref(visible),optional=True); shown = visible.value
                folder, child, parent = Ref(), layer, 'SULayerGetParentLayerFolder'
                while shown and hasattr(api.lib,parent) and not api.call(parent,child,C.byref(folder),optional=True) and folder.ptr:
                    api.call('SULayerFolderGetVisibility',folder,C.byref(visible),optional=True); shown = visible.value
                    folder, child, parent = Ref(), folder, 'SULayerFolderGetParentLayerFolder'
                tags[layer.ptr] = None if shown else api.text('SULayerGetDisplayName' if hasattr(api.lib,'SULayerGetDisplayName') else 'SULayerGetName', layer)
            return tags[layer.ptr]
        def faces_within(entities, depth):
            if depth > 64: raise ValueError('SKP hierarchy limit exceeded')
            if entities.ptr not in face_totals:
                count = C.c_size_t(); api.call('SUEntitiesGetNumFaces',entities,C.byref(count))
                groups = [api.ref('SUGroupGetEntities',g) for g in api.collection(entities,'Groups')]
                instances = [api.ref('SUComponentDefinitionGetEntities',api.ref('SUComponentInstanceGetDefinition',i)) for i in api.collection(entities,'Instances')]
                face_totals[entities.ptr] = count.value+sum(faces_within(nested,depth+1) for nested in groups+instances)
            return face_totals[entities.ptr]
        def left_out(element, kind, faces, depth):
            """True when SketchUp does not draw this face, group or instance, nor anything inside it.
            faces() counts the faces that leaves out."""
            tag = hidden_tag(element, depth > 0)
            if tag is not None: tag_faces[tag] = tag_faces.get(tag,0)+faces(); return True
            flag = C.c_bool(False); api.call('SUDrawingElementGetHidden',element,C.byref(flag),optional=True)
            if flag.value: hidden[kind] += 1; hidden['total'] += faces()
            return flag.value
        to_element = api.lib.SUFaceToDrawingElement; to_element.restype = Ref
        def walk(entities, matrix, name, inherited=Ref(), depth=0):
            if depth > 64 or len(meshes) > 2000000: raise ValueError('SKP hierarchy limit exceeded')
            faces = api.collection(entities,'Faces')
            batches = {}
            for face in faces:
                if left_out(to_element(face),'single faces',lambda:1,depth): continue
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
                    get=api.lib.SUComponentInstanceToDrawingElement;get.restype=Ref;drawn=get(instance)
                    if left_out(drawn,'groups' if kind=='Groups' else 'component instances',lambda:faces_within(nested,depth+1),depth):continue
                    t=Transform();api.call('SUComponentInstanceGetTransform',instance,C.byref(t))
                    mat=Ref();api.call('SUDrawingElementGetMaterial',drawn,C.byref(mat),optional=True)
                    walk(nested,multiply(matrix,list(t.values)),child_name or name,mat if mat.ptr else inherited,depth+1)
            for suffix in ['Images','Texts','Dimensions','SectionPlanes']:
                count=C.c_size_t();api.call('SUEntitiesGetNum'+suffix,entities,C.byref(count))
                if count.value:warnings.append(f'{count.value} {suffix.lower()} retained in original SKP; not represented in mesh')
        walk(entities,IDENTITY,'SketchUp model');write_glb(meshes,output)
        return {'warnings': hidden_warnings(tag_faces,hidden)+sorted(set(warnings))+['Native SKP faces, holes, component placements, names, diffuse textures and colours converted. Scenes, guides, dynamic component logic and PBR extensions remain in the source SKP.']}
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
