"""Write IFC4 tessellated building elements from Tiksi's measured static mesh packet."""
import json
from pathlib import Path
import sys
import ifcopenshell
import ifcopenshell.api

def write_ifc(source,output):
    data=json.loads(Path(source).read_text());model=ifcopenshell.api.run('project.create_file',version='IFC4')
    project=ifcopenshell.api.run('root.create_entity',model,ifc_class='IfcProject',name='Tiksi design')
    unit=ifcopenshell.api.run('unit.add_si_unit',model,unit_type='LENGTHUNIT');ifcopenshell.api.run('unit.assign_unit',model,units=[unit])
    context=ifcopenshell.api.run('context.add_context',model,context_type='Model')
    body=ifcopenshell.api.run('context.add_context',model,context_type='Model',context_identifier='Body',target_view='MODEL_VIEW',parent=context)
    site=ifcopenshell.api.run('root.create_entity',model,ifc_class='IfcSite',name='Site');building=ifcopenshell.api.run('root.create_entity',model,ifc_class='IfcBuilding',name='Building');storey=ifcopenshell.api.run('root.create_entity',model,ifc_class='IfcBuildingStorey',name='Design')
    for parent,child in [(project,site),(site,building),(building,storey)]:ifcopenshell.api.run('aggregate.assign_object',model,products=[child],relating_object=parent)
    elements={}
    for part in data['meshes']:
        p=part['positions'];points=[[float(p[i]),float(-p[i+2]),float(p[i+1])] for i in range(0,len(p),3)]
        if len(points)%3:raise ValueError('IFC export requires triangles')
        name=part.get('name','Mesh');kind=name.split(':')[0]
        extras=part.get('extras',{})
        kind=extras.get('tiksiElementKind',kind)
        cls=extras.get('ifcClass') or {'wall':'IfcWall','room':'IfcSlab','ceiling':'IfcCovering','opening':'IfcBuildingElementProxy'}.get(kind,'IfcBuildingElementProxy')
        if cls not in {'IfcWall','IfcSlab','IfcCovering','IfcDoor','IfcWindow','IfcBuildingElementProxy','IfcBeam','IfcColumn','IfcRoof','IfcFurniture'}:cls='IfcBuildingElementProxy'
        identity=extras.get('ifcGlobalId') or extras.get('tiksiElementId') or name
        element=elements.get(identity)
        fresh=element is None
        if fresh:
            element=ifcopenshell.api.run('root.create_entity',model,ifc_class=cls,name=name);elements[identity]=element
            if extras.get('ifcGlobalId'):element.GlobalId=extras['ifcGlobalId']
        coords=model.create_entity('IfcCartesianPointList3D',CoordList=points)
        faces=model.create_entity('IfcTriangulatedFaceSet',Coordinates=coords,CoordIndex=[[i+1,i+2,i+3] for i in range(0,len(points),3)],Closed=False)
        if fresh:
            representation=model.create_entity('IfcShapeRepresentation',ContextOfItems=body,RepresentationIdentifier='Body',RepresentationType='Tessellation',Items=[faces])
            ifcopenshell.api.run('geometry.assign_representation',model,product=element,representation=representation)
            ifcopenshell.api.run('spatial.assign_container',model,products=[element],relating_structure=storey)
        else:
            representation=element.Representation.Representations[0];representation.Items=(*representation.Items,faces)
        spec=part.get('material',{});c=spec.get('color',[.8,.8,.8,1]);style=ifcopenshell.api.run('style.add_style',model,name=spec.get('name','Surface'))
        ifcopenshell.api.run('style.add_surface_style',model,style=style,ifc_class='IfcSurfaceStyleRendering',attributes={'SurfaceColour':{'Name':None,'Red':float(c[0]),'Green':float(c[1]),'Blue':float(c[2])},'Transparency':1-float(c[3]),'ReflectanceMethod':'NOTDEFINED'})
        ifcopenshell.api.run('style.assign_item_style',model,item=faces,style=style)
        pset=ifcopenshell.api.run('pset.add_pset',model,product=element,name='TiksiExchange')
        ifcopenshell.api.run('pset.edit_pset',model,pset=pset,properties={'SourceElement':name,'MaterialName':spec.get('name','Surface'),'Representation':'Static tessellated geometry; original parametric design remains in .tiksi'})
        for pset_name,values in extras.get('ifcProperties',{}).items():
            scalar={k:v for k,v in values.items() if k!='id' and isinstance(v,(str,int,float,bool))}
            if scalar:
                original=ifcopenshell.api.run('pset.add_pset',model,product=element,name=pset_name);ifcopenshell.api.run('pset.edit_pset',model,pset=original,properties=scalar)
    model.write(str(output));return {'warnings':['IFC4 building hierarchy, classified tessellated elements, material colours and source identifiers exported. Assemblies, textures and parametric BRep are retained in native/.tiksi originals.']}
if __name__=='__main__':
    try:print(json.dumps(write_ifc(sys.argv[1],sys.argv[2])))
    except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
