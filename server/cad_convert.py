"""Optional local IFC, STEP/IGES, DXF and LAZ converters, installed in instance state."""
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
if __package__:from .mesh_exchange import write_glb
else:from mesh_exchange import write_glb


def convert(source, output):
    suffix=source.suffix.lower();meshes=[];warnings=[]
    if suffix=='.ifc':
        import ifcopenshell
        import ifcopenshell.geom
        import ifcopenshell.util.element
        model=ifcopenshell.open(str(source));settings=ifcopenshell.geom.settings();settings.set(settings.USE_WORLD_COORDS,True)
        failures=[];semantic_volumes=[]
        for product in model.by_type('IfcProduct'):
            if product.is_a('IfcOpeningElement') or product.is_a('IfcSpace'):
                semantic_volumes.append({'id':product.GlobalId,'class':product.is_a(),'name':product.Name});continue
            if not product.Representation:continue
            try:
                shape=ifcopenshell.geom.create_shape(settings,product);geo=shape.geometry
                p=geo.verts;positions=[v for i in range(0,len(p),3) for v in [p[i],p[i+2],-p[i+1]]]
                mat_ids=list(geo.material_ids);faces=list(geo.faces)
                for mid in set(mat_ids):
                    mat=geo.materials[mid] if mid>=0 else None
                    color=[.8,.8,.8,1]
                    if mat:
                        diffuse=mat.diffuse;color=[diffuse.r(),diffuse.g(),diffuse.b(),1-(mat.transparency if mat.has_transparency() else 0)]
                    indices=[v for i,m in enumerate(mat_ids) if m==mid for v in faces[i*3:i*3+3]]
                    meshes.append({'name':product.Name or product.is_a(),'positions':positions,'indices':indices,'material':{'name':mat.name if mat else 'Default','color':color},
                                   'extras':{'ifcGlobalId':product.GlobalId,'ifcClass':product.is_a(),'ifcProperties':ifcopenshell.util.element.get_psets(product)}})
            except Exception as e:failures.append((product.GlobalId,str(e)))
        if semantic_volumes:
            (output.parent/'ifc-spaces-openings.json').write_text(json.dumps(semantic_volumes,indent=2))
            warnings.append(f'{len(semantic_volumes)} IFC space/void volumes kept as semantics in the source/handoff, rather than drawn as opaque solids. Wall opening subtraction remains in the wall geometry.')
        if failures:raise ValueError('IFC geometry could not be converted for '+str(len(failures))+' elements; first: '+str(failures[0]))
        warnings.append('IFC GlobalIds, classes and property sets retained in GLB metadata; tessellated meshes do not preserve parametric BIM relationships.')
    elif suffix in {'.step','.stp','.iges','.igs'}:
        from OCP.STEPControl import STEPControl_Reader
        from OCP.IGESControl import IGESControl_Reader
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopAbs import TopAbs_FACE,TopAbs_REVERSED
        from OCP.TopoDS import TopoDS
        from OCP.BRep import BRep_Tool
        from OCP.TopLoc import TopLoc_Location
        reader=STEPControl_Reader() if suffix in {'.step','.stp'} else IGESControl_Reader()
        if reader.ReadFile(str(source))!=IFSelect_RetDone:raise ValueError('Invalid STEP/IGES file')
        reader.TransferRoots();shape=reader.OneShape();BRepMesh_IncrementalMesh(shape,.1,False,.2,True)
        exp=TopExp_Explorer(shape,TopAbs_FACE);positions=[];indices=[]
        while exp.More():
            face=(getattr(TopoDS,"Face_s",None) or TopoDS.Face)(exp.Current());location=TopLoc_Location();tri=BRep_Tool.Triangulation_s(face,location)
            if tri:
                offset=len(positions)//3
                for i in range(1,tri.NbNodes()+1):
                    p=tri.Node(i).Transformed(location.Transformation());positions.extend([p.X()/1000,p.Z()/1000,-p.Y()/1000])
                for i in range(1,tri.NbTriangles()+1):
                    a,b,c=tri.Triangle(i).Get()
                    indices.extend([offset+a-1,offset+(c if face.Orientation()==TopAbs_REVERSED else b)-1,offset+(b if face.Orientation()==TopAbs_REVERSED else c)-1])
            exp.Next()
        meshes.append({'name':'CAD surfaces','positions':positions,'indices':indices})
        warnings.append('STEP/IGES solids tessellated at 0.1 mm deflection, converted from OpenCASCADE millimetres/Z-up. BRep editing remains in the native source.')
    elif suffix=='.dxf':
        import ezdxf
        from ezdxf import units
        doc=ezdxf.readfile(source);factor=units.conversion_factor(doc.units,units.M) if doc.units else 1
        unsupported={};lines=[]
        for entity in doc.modelspace():
            typ=entity.dxftype();verts=[];faces=[]
            if typ=='3DFACE':
                verts=[entity.dxf.vtx0,entity.dxf.vtx1,entity.dxf.vtx2,entity.dxf.vtx3];faces=[0,1,2]
                if verts[2]!=verts[3]:faces += [0,2,3]
            elif typ=='MESH':
                verts=list(entity.vertices)
                for face in entity.faces:
                    for i in range(1,len(face)-1):faces.extend([face[0],face[i],face[i+1]])
            elif typ=='LINE':lines.append([list(entity.dxf.start),list(entity.dxf.end),entity.dxf.layer])
            else:unsupported[typ]=unsupported.get(typ,0)+1
            if verts:meshes.append({'name':entity.dxf.layer,'positions':[v for p in verts for v in [p.x*factor,p.z*factor,-p.y*factor]],'indices':faces})
        if not meshes:
            # A deterministic interpretation handoff; an agent can use real coordinates
            # to propose wall heights/thicknesses instead of pretending linework is solid.
            (output.parent/'interpretation.json').write_text(json.dumps({'format':'tiksi-interpretation','unitsToMetres':factor,'lines':lines,'unsupportedEntities':unsupported,'questions':['Confirm wall height and which layers are walls; review inferred rooms/openings.']}))
            raise ValueError('DXF contains drafting linework, not surfaces. Coordinate/layer interpretation report saved for Codex/Claude.')
        if unsupported or lines: warnings.append('DXF linework/non-mesh entities remain in the source: '+json.dumps(unsupported)+f', {len(lines)} lines')
        if not doc.units:warnings.append('DXF has no units; assuming metres. Verify a known dimension.')
    elif suffix=='.3dm':
        import base64
        import rhino3dm as rhino
        doc=rhino.File3dm.Read(str(source))
        if not doc:raise ValueError('Invalid Rhino 3DM')
        factor=rhino.UnitSystem.UnitScale(doc.Settings.ModelUnitSystem,rhino.UnitSystem.Meters)
        failures=[]
        def read_object(obj,transform=None,depth=0):
            if depth>64:raise ValueError('Rhino instance hierarchy too deep')
            geometry=obj.Geometry
            if isinstance(geometry,rhino.InstanceReference):
                definition=next((d for d in doc.InstanceDefinitions if d.Id==geometry.ParentIdefId),None)
                if not definition:raise ValueError('Missing Rhino instance definition')
                matrix=geometry.Xform if transform is None else transform*geometry.Xform
                for id in definition.GetObjectIds():read_object(doc.Objects.FindId(id),matrix,depth+1)
                return
            render=[]
            if isinstance(geometry,rhino.Mesh):render=[geometry]
            elif isinstance(geometry,rhino.Brep):render=[face.GetMesh(rhino.MeshType.Any) for face in geometry.Faces]
            elif isinstance(geometry,rhino.Extrusion):render=[geometry.GetMesh(rhino.MeshType.Any)]
            else:failures.append(type(geometry).__name__);return
            if not render or any(mesh is None for mesh in render):failures.append('BRep without stored render mesh');return
            material=doc.Materials[obj.Attributes.MaterialIndex] if obj.Attributes.MaterialIndex>=0 else None
            c=material.DiffuseColor if material else (204,204,204,255);spec={'name':material.Name if material else 'Default','color':[v/255 for v in c]}
            if material:
                texture=material.GetBitmapTexture()
                if texture and texture.Enabled:
                    encoded=doc.GetEmbeddedFileAsBase64(texture.FileName)
                    if not encoded:raise ValueError('Rhino diffuse texture is not embedded: '+texture.FileName)
                    path=output.parent/('rhino-texture-'+str(len(meshes))+'.png');path.write_bytes(base64.b64decode(encoded));spec['texture']=str(path)
            for mesh in render:
                mesh=mesh.Duplicate()
                if transform:mesh.Transform(transform)
                positions=[v for p in mesh.Vertices for v in [p.X*factor,p.Z*factor,-p.Y*factor]];indices=[]
                for a,b,c,d in mesh.Faces:
                    indices.extend([a,b,c])
                    if c!=d:indices.extend([a,c,d])
                uv=[v for p in mesh.TextureCoordinates for v in [p.X,1-p.Y]]
                meshes.append({'name':obj.Attributes.Name or 'Rhino object','positions':positions,'indices':indices,'uv':uv,'material':spec,'extras':{'rhinoObjectId':str(obj.Attributes.Id)}})
        for obj in doc.Objects:
            if not obj.Attributes.IsInstanceDefinitionObject:read_object(obj)
        if failures:raise ValueError('Rhino objects need meshing/agent interpretation: '+', '.join(sorted(set(failures)))+'. In Rhino use Save with render meshes, or export GLB.')
        warnings.append('Rhino stored render meshes, names, object IDs, instance placement and diffuse material data converted. Curves/NURBS editing stays in 3DM.')
    elif suffix=='.e57':
        import numpy as np
        import laspy
        import pye57
        cloud=pye57.E57(str(source));scans=[cloud.read_scan(i,colors=True,transform=True,ignore_missing_fields=True) for i in range(cloud.scan_count)]
        if not scans or sum(len(s['cartesianX']) for s in scans)==0:raise ValueError('E57 contains no valid points')
        xyz=[np.concatenate([s['cartesian'+axis] for s in scans]) for axis in 'XYZ']
        if any(not np.isfinite(a).all() for a in xyz):raise ValueError('E57 coordinates are not finite')
        header=laspy.LasHeader(point_format=3,version='1.2');header.offsets=np.array([a.min() for a in xyz]);header.scales=np.array([max(.00001,(a.max()-a.min())/(2**31-1)) for a in xyz]);las=laspy.LasData(header);las.x,las.y,las.z=xyz
        for field,name in [('colorRed','red'),('colorGreen','green'),('colorBlue','blue')]:setattr(las,name,np.concatenate([s.get(field,np.full(len(s['cartesianX']),255,dtype=np.uint8)) for s in scans]).astype(np.uint16)*257)
        las.write(output);return {'warnings':[f'E57: {len(scans)} scans combined with their recorded poses; invalid points excluded by E57 reader. Scanner images and extra channels remain in original E57.']}
    elif suffix=='.laz':
        import laspy
        las=laspy.read(source);las.write(output,do_compress=False)
        return {'warnings':['LAZ decompressed losslessly to LAS; original LAZ retained.']}
    else:raise ValueError('No CAD converter for '+suffix)
    write_glb(meshes,output);return {'warnings':warnings}

if __name__=='__main__':
    try:print(json.dumps(convert(Path(sys.argv[1]),Path(sys.argv[2]))))
    except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
