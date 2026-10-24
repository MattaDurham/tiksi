"""Synthetic local conversion lifecycle and native SDK tests; no owner stores."""
import ctypes as C
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from server.mesh_exchange import write_glb
from server.model_conversion import ModelConversionService, ConversionError
from server.sketchup_convert import hidden_warnings, library_path

class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.service=ModelConversionService(self.root)
    def tearDown(self):self.service.close();self.temp.cleanup()
    def test_glb_writer_retains_units_metadata_and_alpha(self):
        out=self.root/'mesh.glb'
        write_glb([{'name':'Synthetic IFC wall','positions':[0,0,0,4,0,0,0,3,0],'indices':[0,1,2], 'material':{'name':'Paint','color':[1,0,0,.5]},'extras':{'ifcGlobalId':'synthetic','ifcClass':'IfcWall'}}],out)
        b=out.read_bytes();magic,version,length=struct.unpack_from('<III',b);self.assertEqual((magic,version,length),(0x46546c67,2,len(b)))
        n=struct.unpack_from('<I',b,12)[0];doc=json.loads(b[20:20+n]);self.assertEqual(doc['nodes'][0]['extras']['ifcClass'],'IfcWall');self.assertEqual(doc['accessors'][0]['max'],[4,3,0]);self.assertEqual(doc['materials'][0]['alphaMode'],'BLEND')
    def test_glb_writer_embeds_each_texture_once(self):
        # Two face batches of one material and a copy of its texture under another name share an image;
        # a different texture gets its own.
        png=lambda tag:b'\x89PNG\r\n\x1a\n'+tag*64
        (self.root/'brick.png').write_bytes(png(b'b'));(self.root/'brick-copy.png').write_bytes(png(b'b'));(self.root/'soil.png').write_bytes(png(b's'))
        tri={'positions':[0,0,0,1,0,0,0,1,0],'uv':[0,0,1,0,0,1],'indices':[0,1,2]}
        meshes=[dict(tri,name=n,material={'name':m,'texture':str(self.root/f)}) for n,m,f in
                [('Wall A','Brick','brick.png'),('Wall B','Brick','brick.png'),('Chimney','Brick (copy)','brick-copy.png'),('Bed','Soil','soil.png')]]
        out=self.root/'textured.glb';write_glb(meshes,out)
        b=out.read_bytes();n=struct.unpack_from('<I',b,12)[0];doc=json.loads(b[20:20+n])
        self.assertEqual(len(doc['materials']),4);self.assertEqual(len(doc['images']),2);self.assertEqual(len(doc['textures']),2)
        used=[m['pbrMetallicRoughness']['baseColorTexture']['index'] for m in doc['materials']]
        self.assertEqual(used[:3],[used[0]]*3);self.assertNotEqual(used[3],used[0])
        binary=b[20+n+8:];self.assertEqual(binary.count(png(b'b')),1);self.assertEqual(binary.count(png(b's')),1)
        self.assertEqual({im['mimeType'] for im in doc['images']},{'image/png'})
    def test_invalid_mesh_does_not_create_output(self):
        for indices in [[0,1,9],[0,1]]:
            with self.assertRaises(ValueError):write_glb([{'positions':[0,0,0,1,0,0,0,1,0],'indices':indices}],self.root/'bad.glb')
    def test_unknown_native_preserves_source_and_report(self):
        with self.assertRaises(ConversionError) as caught:self.service.convert(b'synthetic native content','.rvt')
        folder=self.root/caught.exception.job_id;self.assertEqual((folder/'source.rvt').read_bytes(),b'synthetic native content');self.assertEqual(json.loads((folder/'report.json').read_text())['state'],'failed')
    def test_upload_and_argument_bounds(self):
        for ext,target,body in [('../evil','glb',b'abc'),('.rvt','sh',b'abc'),('.rvt','glb',b'')]:
            with self.assertRaises(ConversionError):self.service.convert(body,ext,target)
        self.assertFalse(any(self.root.glob('*/report.json')))
    def test_busy_converter_does_not_store_second_upload(self):
        self.service.lock.acquire()
        try:
            with self.assertRaises(ConversionError) as caught:self.service.convert(b'abc','.rvt')
            self.assertEqual(caught.exception.status,409)
        finally:self.service.lock.release()
    def test_http_requires_same_origin_and_token(self):
        class Handler:
            path='/api/model-conversion/convert';command='POST'
            headers={'Host':'localhost:8888','Origin':'https://other.example'}
            rfile=io.BytesIO(b'abc');wfile=io.BytesIO()
            def send_response(self,status):self.status=status
            def send_header(self,*args):pass
            def end_headers(self):pass
        handler=Handler();self.assertTrue(self.service.dispatch(handler));self.assertEqual(handler.status,403)
        handler.headers={'Host':'localhost:8888'};handler.wfile=io.BytesIO();self.service.dispatch(handler);self.assertEqual(handler.status,403)
    @unittest.skipUnless(library_path(),'SketchUp SDK not installed')
    def test_real_native_skp_round_trip(self):
        source=self.root/'mesh.json';source.write_text(json.dumps({'meshes':[{'name':'Test wall','positions':[0,0,0,2,0,0,0,3,0],'material':{'name':'Test paint','color':[.8,.1,.2,1]}}]}))
        worker=Path(__file__).resolve().parent.parent/'server/sketchup_convert.py'
        for a,b in [(source,self.root/'model.skp'),(self.root/'model.skp',self.root/'model.glb')]:
            r=subprocess.run([sys.executable,str(worker),str(a),str(b)],capture_output=True,text=True,timeout=30);self.assertEqual(r.returncode,0,r.stderr)
        data=(self.root/'model.glb').read_bytes();n=struct.unpack_from('<I',data,12)[0];doc=json.loads(data[20:20+n]);self.assertEqual(doc['nodes'][0]['name'],'Test wall');self.assertEqual(doc['accessors'][0]['max'],[2,3,0])
    def test_hidden_geometry_warning_names_tags_and_counts_faces(self):
        none={'total':0,'groups':0,'component instances':0,'single faces':0}
        self.assertEqual(hidden_warnings({},none),[])
        self.assertEqual(hidden_warnings({'Survey':12000,'Furniture':345,'Tiles':0},dict(none,total=1,**{'single faces':1})),[
            '12,345 faces on 3 hidden tags (Survey, Furniture, Tiles) kept in the source SKP, not shown',
            '1 face hidden in SketchUp (1 single face) kept in the source SKP, not shown'])
        many=hidden_warnings({f'Tag {i:02}':1 for i in range(26)},dict(none,total=40,groups=2,**{'component instances':1}))
        self.assertEqual(many,['26 faces on 26 hidden tags ('+', '.join(f'Tag {i:02}' for i in range(24))+' and 2 more) kept in the source SKP, not shown',
                               '40 faces hidden in SketchUp (2 groups, 1 component instance) kept in the source SKP, not shown'])
    @unittest.skipUnless(library_path(),'SketchUp SDK not installed')
    def test_real_native_skp_leaves_out_hidden_geometry_with_warning(self):
        skp=self.root/'hidden.skp';write_skp_with_hidden_geometry(skp);source=skp.read_bytes()
        job,data,report=self.service.convert(source,'.skp')
        self.assertEqual((self.root/job/'source.skp').read_bytes(),source,'the SKP, hidden geometry included, stays the source')
        n=struct.unpack_from('<I',data,12)[0];doc=json.loads(data[20:20+n])
        positions=[doc['accessors'][p['attributes']['POSITION']] for m in doc['meshes'] for p in m['primitives']]
        triangles=sum(doc['accessors'][p['indices']]['count'] for m in doc['meshes'] for p in m['primitives'])//3
        # Shown faces lie within 40 in of the origin; every hidden one was drawn 100 in or more along x.
        self.assertEqual(triangles,4);self.assertLess(max(a['max'][0] for a in positions),41*.0254)
        self.assertEqual(sorted(node['name'] for node in doc['nodes']),['House','Porch','SketchUp model','Tub'])
        self.assertEqual(report['warnings'][:2],[
            '7 faces on 4 hidden tags (Furniture, Untagged, HOTTUB, Survey) kept in the source SKP, not shown',
            '5 faces hidden in SketchUp (1 group, 1 component instance, 1 single face) kept in the source SKP, not shown'])

def write_skp_with_hidden_geometry(path):
    """A model with Untagged switched off, hidden tags (one only through a hidden tag folder), and
    hidden groups, instances and faces. Shown faces are drawn within 40 in of the origin, hidden
    ones from 100 in along x. Per hidden tag: Furniture 3 faces, Untagged 2, HOTTUB 1, Survey 1;
    entities hidden themselves: 1 group (3 faces), 1 component instance (1 face), 1 face."""
    from server.sketchup_convert import API, Ref, Point, Transform
    api=API();model=Ref()
    def element(kind,ref):get=getattr(api.lib,'SU'+kind+'ToDrawingElement');get.restype=Ref;return get(ref)
    def tag(name,visible=True):
        layer=api.ref('SULayerCreate');api.call('SULayerSetName',layer,name.encode());api.call('SUModelAddLayers',model,C.c_size_t(1),(Ref*1)(layer))
        api.call('SULayerSetVisibility',layer,C.c_bool(visible));return layer
    def folder(name,visible=True):
        f=Ref();api.call('SULayerFolderCreate',C.byref(f),name.encode());api.call('SULayerFolderSetVisibility',f,C.c_bool(visible));return f
    def place(kind,ref,layer=None,hide=False):
        if layer:api.call('SUDrawingElementSetLayer',element(kind,ref),layer)
        if hide:api.call('SUDrawingElementSetHidden',element(kind,ref),C.c_bool(True))
        return ref
    def face(entities,x,y=0,**options):
        f=Ref();api.call('SUFaceCreateSimple',C.byref(f),(Point*3)(Point(x,y,0),Point(x+10,y,0),Point(x,y+10,0)),C.c_size_t(3))
        api.call('SUEntitiesAddFaces',entities,C.c_size_t(1),(Ref*1)(f));return place('Face',f,**options)
    def group(entities,name,**options):
        g=api.ref('SUGroupCreate');api.call('SUEntitiesAddGroup',entities,g);api.call('SUGroupSetName',g,name.encode());place('Group',g,**options)
        return api.ref('SUGroupGetEntities',g)
    try:
        api.call('SUModelCreate',C.byref(model));top=api.ref('SUModelGetEntities',model)
        walls,survey,furniture,hottub=tag('Walls'),tag('Survey',False),tag('Furniture',False),tag('HOTTUB');tag('Empty',False)
        # SketchUp keeps the active tag shown, so Untagged can be switched off only once another tag is active.
        api.call('SUModelSetActiveLayer',model,walls);api.call('SULayerSetVisibility',api.ref('SUModelGetDefaultLayer',model),C.c_bool(False))
        site,outdoor=folder('Site'),folder('Outdoor',False);api.call('SUModelAddLayerFolder',model,site)
        api.call('SULayerFolderAddLayerFolder',site,outdoor);api.call('SULayerFolderAddLayer',outdoor,hottub)
        face(top,0,layer=walls);face(top,100);face(top,105,layer=survey)
        house=group(top,'House',layer=walls);face(house,0,20);face(house,110,layer=furniture);face(house,115,hide=True)
        sofa=group(house,'Sofa',layer=furniture);face(sofa,120);face(sofa,125);face(group(house,'Porch'),0,40)
        shed=group(top,'Old shed',layer=walls,hide=True);face(shed,130);roof=group(shed,'Shed roof');face(roof,135);face(roof,140)
        face(group(top,'Loose'),145)
        tub=api.ref('SUComponentDefinitionCreate');api.call('SUComponentDefinitionSetName',tub,b'Tub')
        api.call('SUModelAddComponentDefinitions',model,C.c_size_t(1),(Ref*1)(tub));face(api.ref('SUComponentDefinitionGetEntities',tub),0)
        for x,options in [(30,{'layer':walls}),(150,{'layer':hottub}),(160,{'layer':walls,'hide':True})]:
            instance=api.ref('SUComponentDefinitionCreateInstance',tub);t=Transform();t.values[:]=[1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1]
            api.call('SUComponentInstanceSetTransform',instance,C.byref(t));api.call('SUEntitiesAddInstance',top,instance,None);place('ComponentInstance',instance,**options)
        api.call('SUModelSaveToFile',model,os.fsencode(path))
    finally:
        if model.ptr:api.call('SUModelRelease',C.byref(model))
        api.lib.SUTerminate()
