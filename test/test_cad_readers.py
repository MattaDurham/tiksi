"""Real optional CAD engines, with generated synthetic geometry and temporary files."""
import os
from pathlib import Path
import subprocess
import unittest

ROOT=Path(__file__).resolve().parent.parent
PYTHON=Path(os.environ.get('TIKSI_CAD_PYTHON',str(ROOT/'.tiksi-state/converters/venv/bin/python')))

@unittest.skipUnless(PYTHON.is_file(),'Optional CAD runtime not installed')
class CADReadersTests(unittest.TestCase):
    def test_real_cad_and_point_cloud_converters(self):
        code=r'''
from pathlib import Path
from tempfile import TemporaryDirectory
import json,struct
from server.cad_convert import convert
from server.ifc_write import write_ifc
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.STEPControl import STEPControl_Writer,STEPControl_AsIs
import ezdxf,laspy,numpy as np,rhino3dm,pye57,ifcopenshell

def doc(path):
 b=path.read_bytes();n=struct.unpack_from('<I',b,12)[0];return json.loads(b[20:20+n])
with TemporaryDirectory() as temp:
 p=Path(temp)
 writer=STEPControl_Writer();writer.Transfer(BRepPrimAPI_MakeBox(1000,2000,3000).Shape(),STEPControl_AsIs);writer.Write(str(p/'box.step'))
 convert(p/'box.step',p/'box.glb');g=doc(p/'box.glb');mins=g['accessors'][0]['min'];maxs=g['accessors'][0]['max'];assert np.allclose(np.subtract(maxs,mins),[1,3,2]),(mins,maxs)
 drawing=ezdxf.new();drawing.units=ezdxf.units.M;drawing.modelspace().add_3dface([(0,0,0),(2,0,0),(2,3,0),(0,3,0)]);drawing.saveas(p/'face.dxf');convert(p/'face.dxf',p/'face.glb');assert doc(p/'face.glb')['accessors'][0]['max']==[2,0,0]
 lines=ezdxf.new();lines.units=ezdxf.units.M;lines.modelspace().add_line((0,0),(4,0),dxfattribs={'layer':'WALL'});lines.saveas(p/'lines.dxf')
 try:convert(p/'lines.dxf',p/'no.glb');raise AssertionError('Drafting-only DXF claimed to be a solid')
 except ValueError:pass
 handoff=json.loads((p/'interpretation.json').read_text());assert handoff['lines'][0][2]=='WALL';assert handoff['unitsToMetres']==1
 las=laspy.create(point_format=3);las.x=np.array([0,1,2]);las.y=np.array([0,2,4]);las.z=np.array([0,0,0]);las.write(p/'points.laz');convert(p/'points.laz',p/'points.las');assert np.allclose(laspy.read(p/'points.las').x,[0,1,2])
 with pye57.E57(str(p/'points.e57'),mode='w') as e:e.write_scan_raw({'cartesianX':np.array([0.,1.,2.]),'cartesianY':np.array([0.,2.,4.]),'cartesianZ':np.array([0.,0.,0.]),'colorRed':np.array([255,0,0],dtype='uint8'),'colorGreen':np.array([0,255,0],dtype='uint8'),'colorBlue':np.array([0,0,255],dtype='uint8')})
 convert(p/'points.e57',p/'e57.las');converted=laspy.read(p/'e57.las');assert np.allclose(converted.x,[0,1,2]);assert list(converted.red)==[65535,0,0]
 rhino=rhino3dm.File3dm();rhino.Settings.ModelUnitSystem=rhino3dm.UnitSystem.Meters;mesh=rhino3dm.Mesh()
 for v in [(0,0,0),(2,0,0),(0,3,0)]:mesh.Vertices.Add(*v)
 mesh.Faces.AddFace(0,1,2);rhino.Objects.AddMesh(mesh);rhino.Write(str(p/'mesh.3dm'),8);convert(p/'mesh.3dm',p/'rhino.glb');assert doc(p/'rhino.glb')['accessors'][0]['max']==[2,0,0]
 part={'name':'wall:synthetic','positions':[0,0,0,2,0,0,0,3,0],'material':{'name':'Synthetic paint','color':[.8,.1,.2,1]},'extras':{'ifcGlobalId':'0gqDwbvY19fP7zxuJDDCKA','ifcClass':'IfcWall','ifcProperties':{'SyntheticPset':{'Finish':'Paint','id':1}}}}
 (p/'mesh.json').write_text(json.dumps({'meshes':[part,part]}));write_ifc(p/'mesh.json',p/'wall.ifc');native=ifcopenshell.open(str(p/'wall.ifc'));assert len(native.by_type('IfcWall'))==1,'material primitives share one IFC element';convert(p/'wall.ifc',p/'ifc.glb');g=doc(p/'ifc.glb');assert g['nodes'][0]['extras']['ifcGlobalId']==part['extras']['ifcGlobalId'];assert g['nodes'][0]['extras']['ifcProperties']['SyntheticPset']['Finish']=='Paint'
 # Semantic room/void volumes must never fill physical rooms or door openings.
 import ifcopenshell.api
 for cls in ['IfcSpace','IfcOpeningElement']:
  semantic=ifcopenshell.api.run('root.create_entity',native,ifc_class=cls,name='Synthetic '+cls);semantic.Representation=native.by_type('IfcWall')[0].Representation
 native.write(str(p/'semantic.ifc'));convert(p/'semantic.ifc',p/'semantic.glb');classes=[node['extras']['ifcClass'] for node in doc(p/'semantic.glb')['nodes']];assert classes and set(classes)=={'IfcWall'},classes;assert len(json.loads((p/'ifc-spaces-openings.json').read_text()))==2
print('Real STEP, DXF, drafting handoff, LAZ, E57, Rhino and IFC metadata converters passed')
'''
        result=subprocess.run([str(PYTHON),'-c',code],cwd=ROOT,capture_output=True,text=True,timeout=120)
        self.assertEqual(result.returncode,0,result.stderr+'\n'+result.stdout)
