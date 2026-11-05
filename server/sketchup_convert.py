"""Native SKP reader/writer using the locally installed SketchUp C API.

Only documented API entry points are used. No SketchUp libraries are redistributed.
Every invocation is a separate process, operating on uploaded/synthetic files only.
"""
import base64
import ctypes as C
import hashlib
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
def determinant(m): return m[0]*(m[5]*m[10]-m[9]*m[6])-m[4]*(m[1]*m[10]-m[9]*m[2])+m[8]*(m[1]*m[6]-m[5]*m[2])
# Column-major change of frame: SketchUp inches, Z up <-> glTF metres, Y up (from_skp / to_skp).
SKP_TO_GLTF = [.0254,0,0,0, 0,0,-.0254,0, 0,.0254,0,0, 0,0,0,1]
GLTF_TO_SKP = [1/.0254,0,0,0, 0,0,1/.0254,0, 0,-1/.0254,0,0, 0,0,0,1]
def gltf_matrix(m): return multiply(multiply(SKP_TO_GLTF,m),GLTF_TO_SKP)
def skp_matrix(m): return multiply(multiply(GLTF_TO_SKP,m),SKP_TO_GLTF)


def read_skp(source, output):
    """SKP -> GLB the SketchUp way: one glTF material per SketchUp material, each component
    definition's geometry written once (in definition coordinates) and shared by every instance,
    each instance a node with its transform and extras naming its definition. Groups are unique,
    so their faces are placed in the frame they sit in. Faces on the default material take the
    nearest enclosing instance's or group's material (SketchUp's rule), so a definition's shared
    meshes are keyed by definition and that inherited material."""
    if __package__:from .mesh_exchange import write_glb
    else:from mesh_exchange import write_glb
    api = API(); model = Ref(); meshes = []; material_cache = {}; warnings = []; templates = {}; counts = {'nodes': 0}
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
        def optional_text(name, ref):
            if not hasattr(api.lib, name): return ''
            try: return api.text(name, ref).strip()
            except ValueError: return ''
        # Each face batch carries the SketchUp tag it is drawn on, so Tiksi can rebuild the
        # file's tags: a face's own tag, else the tag of the innermost tagged group or instance.
        untagged_layer = api.ref('SUModelGetDefaultLayer',model); layer_names = {}
        def tag_of(element, inherited_tag):
            layer = Ref()
            if api.call('SUDrawingElementGetLayer',element,C.byref(layer),optional=True) or not layer.ptr or layer.ptr == untagged_layer.ptr: return inherited_tag
            if layer.ptr not in layer_names:
                layer_names[layer.ptr] = api.text('SULayerGetDisplayName' if hasattr(api.lib,'SULayerGetDisplayName') else 'SULayerGetName', layer).strip() or None
            return layer_names[layer.ptr] or inherited_tag
        face_element = api.lib.SUFaceToDrawingElement; face_element.restype = Ref
        group_instance = api.lib.SUGroupToComponentInstance; group_instance.restype = Ref
        instance_element = api.lib.SUComponentInstanceToDrawingElement; instance_element.restype = Ref
        def collect(entities, matrix, name, inherited, depth, tag, out):
            """Faces of `entities`, placed by `matrix` in the current frame, become batch nodes in
            `out` (one per material and tag); groups are placed in the same frame; component
            instances become instance nodes over their definition's shared meshes. A batch's
            `tag` is the innermost tag inside the current frame (None: the frame's own tag)."""
            if depth > 64 or len(meshes) > 2000000: raise ValueError('SKP hierarchy limit exceeded')
            batches = {}
            det = determinant(matrix)
            for face in api.collection(entities,'Faces'):
                mat = Ref(); api.call('SUFaceGetFrontMaterial',face,C.byref(mat),optional=True)
                if not mat.ptr: mat=inherited
                face_tag = tag_of(face_element(face), tag)
                batch = batches.get((mat.ptr, face_tag))
                if batch is None:
                    batch = batches[(mat.ptr, face_tag)] = {'name':name,'positions':[],'uv':[],'indices':[],'material':material(mat)}
                    meshes.append(batch); out.append({'name':name,'mesh':len(meshes)-1,'tag':face_tag})
                mesh=Ref();api.call('SUMeshHelperCreate',C.byref(mesh),face)
                try:
                    count=C.c_size_t();api.call('SUMeshHelperGetNumVertices',mesh,C.byref(count));verts=(Point*count.value)();stq=(Point*count.value)()
                    api.call('SUMeshHelperGetVertices',mesh,count,verts,C.byref(count))
                    api.call('SUMeshHelperGetFrontSTQCoords',mesh,count,stq,C.byref(count))
                    offset=len(batch['positions'])//3
                    if len(batch['positions']) > 60000000: raise ValueError('SKP vertex limit exceeded')
                    for v,u in zip(verts,stq):
                        batch['positions'].extend(from_skp(transform(v,matrix)))
                        q=u.z or 1;batch['uv'].extend([u.x/q,1-u.y/q])
                    triangles=C.c_size_t();api.call('SUMeshHelperGetNumTriangles',mesh,C.byref(triangles));n=C.c_size_t(triangles.value*3);indices=(C.c_size_t*n.value)()
                    api.call('SUMeshHelperGetVertexIndices',mesh,n,indices,C.byref(n))
                    # Mirrored placements reverse orientation.
                    for i in range(0,len(indices),3):
                        order=[indices[i],indices[i+1],indices[i+2]]
                        if det<0:order.reverse()
                        batch['indices'].extend(v+offset for v in order)
                finally:api.call('SUMeshHelperRelease',C.byref(mesh))
            for child in api.collection(entities,'Groups'):
                instance=group_instance(child)
                t=Transform();api.call('SUComponentInstanceGetTransform',instance,C.byref(t))
                mat=Ref();api.call('SUDrawingElementGetMaterial',instance_element(instance),C.byref(mat),optional=True)
                collect(api.ref('SUGroupGetEntities',child),multiply(matrix,list(t.values)),api.text('SUGroupGetName',child) or name,
                        mat if mat.ptr else inherited,depth+1,tag_of(instance_element(instance),tag),out)
            for instance in api.collection(entities,'Instances'):
                definition=api.ref('SUComponentInstanceGetDefinition',instance)
                t=Transform();api.call('SUComponentInstanceGetTransform',instance,C.byref(t))
                mat=Ref();api.call('SUDrawingElementGetMaterial',instance_element(instance),C.byref(mat),optional=True)
                own=mat if mat.ptr else inherited
                template=template_for(definition,own,depth+1)
                extras={'sketchupComponent':template['name']}
                if template['guid']:extras['sketchupDefinitionId']=template['guid']
                if template['description']:extras['sketchupDescription']=template['description']
                guid=optional_text('SUComponentInstanceGetGuid',instance)
                if guid:extras['sketchupInstance']=guid
                label=optional_text('SUComponentInstanceGetName',instance)
                if label:extras['sketchupInstanceName']=label
                out.append({'name':label or template['name'],'matrix':gltf_matrix(multiply(matrix,list(t.values))),'extras':extras,
                            'tag':tag_of(instance_element(instance),tag),'children':template['nodes']})
            for suffix in ['Images','Texts','Dimensions','SectionPlanes']:
                count=C.c_size_t();api.call('SUEntitiesGetNum'+suffix,entities,C.byref(count))
                if count.value:warnings.append(f'{count.value} {suffix.lower()} retained in original SKP; not represented in mesh')
        def template_for(definition, inherited, depth):
            """A definition's contents in its own coordinates, built once per inherited material."""
            key=(definition.ptr,inherited.ptr)
            if key not in templates:
                name=api.text('SUComponentDefinitionGetName',definition) or 'Component'
                nodes=[]
                templates[key]={'name':name,'guid':optional_text('SUComponentDefinitionGetGuid',definition),
                                'description':optional_text('SUComponentDefinitionGetDescription',definition)[:2000],'nodes':nodes}
                collect(api.ref('SUComponentDefinitionGetEntities',definition),IDENTITY,name,inherited,depth,None,nodes)
                if not templates[key]['guid']:
                    # No GUID from this SDK: name plus a hash of the geometry stays the same
                    # across conversions of the same file and differs between definitions.
                    digest=hashlib.sha1(name.encode('utf-8'))
                    def feed(items):
                        for node in items:
                            if 'mesh' in node:digest.update(json.dumps([round(v,6) for v in meshes[node['mesh']]['positions']]).encode())
                            feed(node.get('children') or [])
                    feed(nodes);templates[key]['guid']='hash:'+digest.hexdigest()
            return templates[key]
        def place(nodes, inherited_tag):
            """Node dicts for the GLB: every instance gets its own nodes (glTF nodes have one
            parent) over the shared meshes; each node's sketchupTag is its innermost tag."""
            out=[]
            for node in nodes:
                counts['nodes']+=1
                if counts['nodes']>2000000:raise ValueError('SKP instance limit exceeded')
                tag=node.get('tag') or inherited_tag
                extras=dict(node.get('extras') or {})
                if tag:extras['sketchupTag']=tag
                placed={'name':node['name'],'extras':extras or None}
                if 'mesh' in node:placed['mesh']=node['mesh']
                if 'matrix' in node:placed['matrix']=node['matrix']
                if node.get('children'):placed['children']=place(node['children'],tag)
                out.append(placed)
            return out
        top=[];collect(entities,IDENTITY,'SketchUp model',Ref(),0,None,top)
        # The scene says it was written with components, so Tiksi knows not to offer converting again.
        stats=write_glb(meshes,output,place(top,None),{'sketchupComponents':1})
        components=len({k[0] for k in templates})
        summary=f'{components} component definition{"s" if components!=1 else ""} written once and shared by their instances; {stats["materials"]} material{"s" if stats["materials"]!=1 else ""}.' if components else f'{stats["materials"]} material{"s" if stats["materials"]!=1 else ""}.'
        return {'warnings': sorted(set(warnings))+['Native SKP faces, holes, component definitions and instances, names, tags, diffuse textures and colours converted. '+summary+' Scenes, guides, dynamic component logic and PBR extensions remain in the source SKP.']}
    finally:
        if model.ptr:api.call('SUModelRelease',C.byref(model))
        api.lib.SUTerminate()


def write_skp(source, output):
    """JSON from the browser's static exporter -> SKP. `meshes` are world-space triangles, each
    written as a group; `components` are definitions (triangles in definition coordinates) and
    `instances` place them with a column-major glTF-space matrix, so a model's components go
    back to SketchUp as components. Materials are created once per name, colour and texture."""
    api=API();model=Ref();data=json.loads(Path(source).read_text(encoding='utf-8'))
    try:
        api.call('SUModelCreate',C.byref(model));entities=api.ref('SUModelGetEntities',model)
        # A part may name its Tiksi tag; it becomes a SketchUp tag of the same name and visibility.
        layers={};materials={};to_drawing=api.lib.SUGroupToDrawingElement;to_drawing.restype=Ref
        instance_drawing=api.lib.SUComponentInstanceToDrawingElement;instance_drawing.restype=Ref
        def layer_for(name, visible):
            if name not in layers:
                layer=Ref();api.call('SULayerCreate',C.byref(layer));api.call('SULayerSetName',layer,name.encode('utf-8'))
                api.call('SULayerSetVisibility',layer,C.c_bool(bool(visible)),optional=True)
                api.call('SUModelAddLayers',model,C.c_size_t(1),(Ref*1)(layer));layers[name]=layer
            return layers[name]
        def set_tag(element, part):
            tag=part.get('tag')
            if isinstance(tag,str) and tag.strip():
                api.call('SUDrawingElementSetLayer',element,layer_for(tag.strip()[:120],part.get('tagVisible',True) is not False))
        def material_for(spec):
            rgba=spec.get('color',[.8,.8,.8,1]);texture=spec.get('texture')
            key=(spec.get('name','Surface'),tuple(round(v,4) for v in rgba),texture)
            if key in materials:return materials[key]
            mat=Ref();api.call('SUMaterialCreate',C.byref(mat))
            api.call('SUMaterialSetName',mat,spec.get('name','Surface').encode())
            color=Color(*(round(v*255) for v in rgba));api.call('SUMaterialSetColor',mat,C.byref(color))
            api.call('SUMaterialSetOpacity',mat,C.c_double(rgba[3]));api.call('SUModelAddMaterials',model,C.c_size_t(1),(Ref*1)(mat))
            if texture:
                path=Path(output).parent/('write-texture-'+str(len(materials))+'.png')
                path.write_bytes(base64.b64decode(texture,validate=True))
                tex=Ref();api.call('SUTextureCreateFromFile',C.byref(tex),os.fsencode(path),C.c_double(1),C.c_double(1));api.call('SUMaterialSetTexture',mat,tex)
            materials[key]=mat;return mat
        def add_faces(target, part):
            spec=part.get('material',{});mat=material_for(spec);texture=spec.get('texture')
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
        for part in data.get('meshes',[]):
            group=Ref();api.call('SUGroupCreate',C.byref(group));api.call('SUGroupSetName',group,part['name'].encode());api.call('SUEntitiesAddGroup',entities,group)
            set_tag(to_drawing(group),part)
            add_faces(api.ref('SUGroupGetEntities',group),part)
        # Definitions first, so one can place another (a cabinet's hinges, a hinge's screws).
        definitions={};components=data.get('components',[])
        for component in components:
            definition=Ref();api.call('SUComponentDefinitionCreate',C.byref(definition))
            api.call('SUComponentDefinitionSetName',definition,str(component.get('name') or 'Component')[:200].encode('utf-8'))
            if component.get('description'):api.call('SUComponentDefinitionSetDescription',definition,str(component['description'])[:2000].encode('utf-8'),optional=True)
            api.call('SUModelAddComponentDefinitions',model,C.c_size_t(1),(Ref*1)(definition))
            definitions[component.get('id')]=definition
        def place(target, placement, depth=0):
            definition=definitions.get(placement.get('component'))
            if definition is None:raise ValueError('Instance names a missing component definition')
            matrix=placement.get('matrix')
            if not isinstance(matrix,list) or len(matrix)!=16 or any(not isinstance(v,(int,float)) or not math.isfinite(v) for v in matrix):raise ValueError('Invalid component instance transform')
            instance=Ref();api.call('SUComponentDefinitionCreateInstance',definition,C.byref(instance))
            t=Transform();t.values[:]=skp_matrix(matrix);api.call('SUComponentInstanceSetTransform',instance,C.byref(t))
            if placement.get('name'):api.call('SUComponentInstanceSetName',instance,str(placement['name'])[:200].encode('utf-8'))
            api.call('SUEntitiesAddInstance',target,instance,None)
            set_tag(instance_drawing(instance),placement)
        for component in components:
            target=api.ref('SUComponentDefinitionGetEntities',definitions[component.get('id')])
            for part in component.get('meshes',[]):
                if part.get('tag'):
                    # A tagged part of a definition is a group inside it, on that tag.
                    group=Ref();api.call('SUGroupCreate',C.byref(group));api.call('SUGroupSetName',group,str(part.get('name') or '').encode());api.call('SUEntitiesAddGroup',target,group)
                    set_tag(to_drawing(group),part);add_faces(api.ref('SUGroupGetEntities',group),part)
                else:add_faces(target,part)
            # Nested placements are in the definition's own coordinates.
            for placement in component.get('instances',[]):place(target,placement)
        for placement in data.get('instances',[]):place(entities,placement)
        api.call('SUModelSaveToFile',model,os.fsencode(output))
        note='Native SKP contains editable grouped triangle faces on their Tiksi tags, diffuse textures and colours.'
        if data.get('components'):note+=f' {len(data["components"])} component definition{"s" if len(data["components"])!=1 else ""} with {len(data.get("instances",[]))} instance{"s" if len(data.get("instances",[]))!=1 else ""}.'
        return {'warnings':[note+' Use GLB for PBR map fidelity.']}
    finally:
        if model.ptr:api.call('SUModelRelease',C.byref(model))
        api.lib.SUTerminate()

if __name__=='__main__':
    # CLI paths are supplied only by the local service, never accepted from HTTP payloads.
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
    try:print(json.dumps(read_skp(sys.argv[1],sys.argv[2]) if Path(sys.argv[1]).suffix.lower()=='.skp' else write_skp(sys.argv[1],sys.argv[2])))
    except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
