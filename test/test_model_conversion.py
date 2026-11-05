"""Synthetic local conversion lifecycle and native SDK tests; no owner stores."""
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from server.mesh_exchange import write_glb
from server.model_conversion import ModelConversionService, ConversionError
from server.sketchup_convert import library_path

# Removes the faces' own material in a synthetic SKP and paints its two instances red and blue.
REPAINT = r"""
import ctypes as C, sys
sys.path.insert(0, sys.argv[1])
from server.sketchup_convert import API, Ref, Color
api = API(); model = Ref()
api.call('SUModelCreateFromFile', C.byref(model), sys.argv[2].encode())
entities = api.ref('SUModelGetEntities', model)
instances = api.collection(entities, 'Instances')
definition = api.ref('SUComponentInstanceGetDefinition', instances[0])
for face in api.collection(api.ref('SUComponentDefinitionGetEntities', definition), 'Faces'):
    api.call('SUFaceSetFrontMaterial', face, Ref()); api.call('SUFaceSetBackMaterial', face, Ref())
element = api.lib.SUComponentInstanceToDrawingElement; element.restype = Ref
for instance, (name, rgb) in zip(instances, [('Red paint', (200, 30, 30)), ('Blue paint', (30, 30, 200))]):
    mat = Ref(); api.call('SUMaterialCreate', C.byref(mat)); api.call('SUMaterialSetName', mat, name.encode())
    color = Color(*rgb, 255); api.call('SUMaterialSetColor', mat, C.byref(color))
    api.call('SUModelAddMaterials', model, C.c_size_t(1), (Ref * 1)(mat))
    api.call('SUDrawingElementSetMaterial', element(instance), mat)
api.call('SUModelSaveToFile', model, sys.argv[2].encode())
api.call('SUModelRelease', C.byref(model)); api.lib.SUTerminate()
"""

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
        # One glTF material per source material: both Brick batches use one; the copy keeps its own name.
        self.assertEqual(len(doc['materials']),3);self.assertEqual(len(doc['images']),2);self.assertEqual(len(doc['textures']),2)
        by_mesh=[doc['meshes'][node['mesh']]['primitives'][0]['material'] for node in doc['nodes']]
        self.assertEqual(by_mesh[0],by_mesh[1]);self.assertNotEqual(by_mesh[2],by_mesh[0])
        used=[m['pbrMetallicRoughness']['baseColorTexture']['index'] for m in doc['materials']]
        self.assertEqual(used[:2],[used[0]]*2);self.assertNotEqual(used[2],used[0])
        binary=b[20+n+8:];self.assertEqual(binary.count(png(b'b')),1);self.assertEqual(binary.count(png(b's')),1)
        self.assertEqual({im['mimeType'] for im in doc['images']},{'image/png'})
    def test_glb_writer_shares_one_mesh_between_nodes(self):
        # A node tree naming one batch from several nodes writes its geometry once.
        tri={'name':'Bottle','positions':[0,0,0,1,0,0,0,1,0],'indices':[0,1,2],'material':{'name':'Glass','color':[.2,.5,.3,.6]}}
        nodes=[{'name':f'Bottle {i}','matrix':[1,0,0,0,0,1,0,0,0,0,1,0,i,0,0,1],'extras':{'sketchupComponent':'Bottle'},'children':[{'name':'Bottle','mesh':0}]} for i in range(5)]
        out=self.root/'shared.glb';stats=write_glb([tri],out,nodes)
        b=out.read_bytes();n=struct.unpack_from('<I',b,12)[0];doc=json.loads(b[20:20+n])
        self.assertEqual((len(doc['meshes']),len(doc['materials']),len(doc['scenes'][0]['nodes'])),(1,1,5))
        self.assertEqual(stats,{'meshes':1,'nodes':10,'materials':1})
        placed=[doc['nodes'][i] for i in doc['scenes'][0]['nodes']]
        self.assertNotIn('matrix',placed[0],'an identity transform is left out');self.assertEqual([p.get('matrix',[0]*16)[12] for p in placed],[0,1,2,3,4])
        self.assertEqual({doc['nodes'][p['children'][0]]['mesh'] for p in placed},{0})
        with self.assertRaises(ValueError):write_glb([tri],self.root/'bad.glb',[{'name':'x','mesh':3}])
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
    def test_real_native_skp_carries_tags_into_glb_nodes(self):
        tri=[0,0,0,2,0,0,0,3,0]
        source=self.root/'tagged.json';source.write_text(json.dumps({'meshes':[
            {'name':'Shed roof','tag':'Roof','positions':tri,'material':{'name':'Shingle','color':[.3,.3,.3,1]}},
            {'name':'Back wall','tag':'Walls','positions':[v+5 for v in tri],'material':{'name':'Paint','color':[.9,.9,.9,1]}},
            {'name':'Loose part','positions':[v+9 for v in tri],'material':{'name':'Paint','color':[.9,.9,.9,1]}}]}))
        worker=Path(__file__).resolve().parent.parent/'server/sketchup_convert.py'
        for a,b in [(source,self.root/'tagged.skp'),(self.root/'tagged.skp',self.root/'tagged.glb')]:
            r=subprocess.run([sys.executable,str(worker),str(a),str(b)],capture_output=True,text=True,timeout=30);self.assertEqual(r.returncode,0,r.stderr)
        data=(self.root/'tagged.glb').read_bytes();n=struct.unpack_from('<I',data,12)[0];doc=json.loads(data[20:20+n])
        tags={node['name']:(node.get('extras') or {}).get('sketchupTag') for node in doc['nodes']}
        self.assertEqual(tags,{'Shed roof':'Roof','Back wall':'Walls','Loose part':None})
    @unittest.skipUnless(library_path(),'SketchUp SDK not installed')
    def test_real_native_skp_components_share_one_mesh(self):
        # A wine rack: 300 instances of one bottle component (glass body on the default material
        # of the instance, a cork on its own tag), plus one plain group. The GLB draws the bottle's
        # geometry once and places it 300 times; every instance names its definition.
        body=[0,0,0,.08,0,0,0,.3,0, .08,0,0,.08,.3,0,0,.3,0];cork=[0,.3,0,.02,.3,0,0,.33,0]
        glass={'name':'Bottle glass','color':[.1,.35,.2,1]};oak={'name':'Rack oak','color':[.7,.5,.3,1]}
        instances=[{'component':'bottle','name':'' if i else 'First bottle','matrix':[1,0,0,0,0,1,0,0,0,0,1,0,(i%30)*.1,0,(i//30)*.1,1],'tag':'Wine' if i<150 else None} for i in range(300)]
        # One mirrored instance keeps its geometry and winding.
        instances[299]['matrix']=[-1,0,0,0,0,1,0,0,0,0,1,0,5,0,5,1]
        source=self.root/'rack.json';source.write_text(json.dumps({
            'meshes':[{'name':'Rack shelf','tag':'Furniture','positions':[0,0,0,3,0,0,0,0,1],'material':oak}],
            'components':[{'id':'bottle','name':'Wine bottle','description':'750 ml Bordeaux bottle','meshes':[
                {'name':'Wine bottle','positions':body,'material':glass},{'name':'Cork','tag':'Corks','positions':cork,'material':oak}]}],
            'instances':instances}))
        worker=Path(__file__).resolve().parent.parent/'server/sketchup_convert.py'
        for a,b in [(source,self.root/'rack.skp'),(self.root/'rack.skp',self.root/'rack.glb')]:
            r=subprocess.run([sys.executable,str(worker),str(a),str(b)],capture_output=True,text=True,timeout=120);self.assertEqual(r.returncode,0,r.stderr)
        data=(self.root/'rack.glb').read_bytes();n=struct.unpack_from('<I',data,12)[0];doc=json.loads(data[20:20+n])
        nodes=doc['nodes'];top=[nodes[i] for i in doc['scenes'][0]['nodes']]
        placed=[node for node in top if (node.get('extras') or {}).get('sketchupComponent')=='Wine bottle']
        self.assertEqual(len(placed),300)
        self.assertEqual(len({p['extras'].get('sketchupDefinitionId') for p in placed}),1)
        self.assertTrue(placed[0]['extras'].get('sketchupDefinitionId'))
        self.assertEqual(placed[0]['extras'].get('sketchupDescription'),'750 ml Bordeaux bottle')
        self.assertEqual(sum(1 for p in placed if p['extras'].get('sketchupInstanceName')=='First bottle'),1)
        # Each instance's children draw the same two glTF meshes: glass body and cork.
        child_meshes={tuple(sorted(nodes[c]['mesh'] for c in p['children'])) for p in placed}
        self.assertEqual(len(child_meshes),1);self.assertEqual(len(next(iter(child_meshes))),2)
        self.assertEqual(len(doc['meshes']),3,'bottle body, cork and the rack shelf')
        # One glTF material per SketchUp material.
        self.assertEqual(sorted(m['name'] for m in doc['materials']),['Bottle glass','Rack oak'])
        # Transforms survive the trip through SketchUp's inches and Z up: 30 columns 0.1 m apart.
        xs=sorted({round(p.get('matrix',[0]*16)[12],4) for p in placed[:299]});self.assertEqual(len(xs),30)
        self.assertLess(placed[299]['matrix'][0],0,'the mirrored instance keeps its mirror')
        # Tags per part: the cork keeps its own tag; the body takes its instance's tag, or none.
        tags=lambda p:sorted((nodes[c].get('extras') or {}).get('sketchupTag') or '' for c in p['children'])
        self.assertEqual(tags(placed[0]),['Corks','Wine']);self.assertEqual(tags(placed[200]),['','Corks'])
        shelf=[node for node in top if node['name']=='Rack shelf'];self.assertEqual(len(shelf),1)
        self.assertEqual(shelf[0]['extras']['sketchupTag'],'Furniture');self.assertNotIn('matrix',shelf[0])
        # A bottle's geometry is stored in definition coordinates (inches -> metres, Y up).
        body_mesh=[m for m in doc['meshes'] if m['name']=='Wine bottle'][0]
        bounds=doc['accessors'][body_mesh['primitives'][0]['attributes']['POSITION']]
        self.assertEqual([round(v,4) for v in bounds['max']],[.08,.3,0])
    @unittest.skipUnless(library_path(),'SketchUp SDK not installed')
    def test_real_native_skp_keeps_nested_components_and_separate_definitions(self):
        # 8 cabinets, each with 4 hinges, each hinge with 6 screws: the GLB keeps the nesting
        # (nodes under nodes), so the drawn counts are 8, 32 and 192. Two faucets that look the
        # same but are separate definitions stay two definitions.
        tri=lambda s:[0,0,0,s,0,0,0,s,0]
        at=lambda x,y=0,z=0:[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1]
        steel={'name':'Steel','color':[.6,.6,.6,1]};maple={'name':'Maple','color':[.8,.7,.5,1]};chrome={'name':'Chrome','color':[.9,.9,.9,1]}
        source=self.root/'kitchen.json';source.write_text(json.dumps({'components':[
            {'id':'screw','name':'Screw #8 x 5/8','meshes':[{'name':'Screw','positions':tri(.005),'material':steel}]},
            {'id':'hinge','name':'Hinge','meshes':[{'name':'Hinge','positions':tri(.05),'material':steel}],'instances':[{'component':'screw','matrix':at(.01*i)} for i in range(6)]},
            {'id':'cabinet','name':'Base cabinet 24','meshes':[{'name':'Cabinet','positions':tri(.6),'material':maple}],'instances':[{'component':'hinge','matrix':at(0,.1*i)} for i in range(4)]},
            {'id':'faucet-a','name':'Faucet','meshes':[{'name':'Faucet','positions':tri(.2),'material':chrome}]},
            {'id':'faucet-b','name':'Faucet','meshes':[{'name':'Faucet','positions':tri(.2),'material':chrome}]}],
            'instances':[{'component':'cabinet','matrix':at(.7*i)} for i in range(8)]+[{'component':'faucet-a','matrix':at(0,1)},{'component':'faucet-b','matrix':at(1,1)}]}))
        worker=Path(__file__).resolve().parent.parent/'server/sketchup_convert.py'
        for a,b in [(source,self.root/'kitchen.skp'),(self.root/'kitchen.skp',self.root/'kitchen.glb')]:
            r=subprocess.run([sys.executable,str(worker),str(a),str(b)],capture_output=True,text=True,timeout=120);self.assertEqual(r.returncode,0,r.stderr)
        def read():
            data=(self.root/'kitchen.glb').read_bytes();n=struct.unpack_from('<I',data,12)[0];return json.loads(data[20:20+n])
        doc=read();nodes=doc['nodes']
        self.assertEqual(doc['scenes'][0].get('extras'),{'sketchupComponents':1})
        counts={};ids={}
        def walk(i,depth):
            e=nodes[i].get('extras') or {}
            if e.get('sketchupComponent'):counts[e['sketchupComponent']]=counts.get(e['sketchupComponent'],0)+1;ids.setdefault(e['sketchupComponent'],set()).add(e['sketchupDefinitionId'])
            for c in nodes[i].get('children',[]):walk(c,depth+1)
        for i in doc['scenes'][0]['nodes']:walk(i,0)
        self.assertEqual((counts['Base cabinet 24'],counts['Hinge'],counts['Screw #8 x 5/8']),(8,32,192))
        faucets={name:v for name,v in ids.items() if name.startswith('Faucet')}
        self.assertEqual(sum(len(v) for v in faucets.values()),2,'two separately defined faucets stay two definitions')
        # A screw node sits under a hinge node, which sits under a cabinet node.
        cabinet=next(nodes[i] for i in doc['scenes'][0]['nodes'] if (nodes[i].get('extras') or {}).get('sketchupComponent')=='Base cabinet 24')
        hinge=next(nodes[c] for c in cabinet['children'] if (nodes[c].get('extras') or {}).get('sketchupComponent')=='Hinge')
        self.assertEqual(sum(1 for c in hinge['children'] if (nodes[c].get('extras') or {}).get('sketchupComponent')=='Screw #8 x 5/8'),6)
        # Shared geometry: one screw mesh drawn 192 times.
        self.assertEqual(len(doc['meshes']),5)
        # The same SKP converted again names every definition the same way.
        first={k:sorted(v) for k,v in ids.items()}
        r=subprocess.run([sys.executable,str(worker),str(self.root/'kitchen.skp'),str(self.root/'kitchen.glb')],capture_output=True,text=True,timeout=120);self.assertEqual(r.returncode,0,r.stderr)
        counts.clear();ids.clear();doc=read();nodes=doc['nodes']
        for i in doc['scenes'][0]['nodes']:walk(i,0)
        self.assertEqual({k:sorted(v) for k,v in ids.items()},first)
    @unittest.skipUnless(library_path(),'SketchUp SDK not installed')
    def test_real_native_skp_default_material_faces_take_the_instance_material(self):
        # One definition whose face has no material, placed twice, painted red and blue: two
        # meshes, each with its painter's material, and both instances still name one definition.
        tri=[0,0,0,1,0,0,0,1,0]
        source=self.root/'painted.json';source.write_text(json.dumps({'components':[{'id':'tile','name':'Tile','meshes':[{'name':'Tile','positions':tri,'material':{'name':'Plain','color':[.9,.9,.9,1]}}]}],
            'instances':[{'component':'tile','matrix':[1,0,0,0,0,1,0,0,0,0,1,0,i,0,0,1]} for i in range(2)]}))
        worker=Path(__file__).resolve().parent.parent/'server/sketchup_convert.py'
        r=subprocess.run([sys.executable,str(worker),str(source),str(self.root/'painted.skp')],capture_output=True,text=True,timeout=30);self.assertEqual(r.returncode,0,r.stderr)
        # The writer paints faces explicitly; strip the face material and paint the instances
        # through the SDK so the fixture has SketchUp's default-material case.
        script=self.root/'repaint.py';script.write_text(REPAINT)
        r=subprocess.run([sys.executable,str(script),str(Path(__file__).resolve().parent.parent),str(self.root/'painted.skp')],capture_output=True,text=True,timeout=30);self.assertEqual(r.returncode,0,r.stderr)
        r=subprocess.run([sys.executable,str(worker),str(self.root/'painted.skp'),str(self.root/'painted.glb')],capture_output=True,text=True,timeout=30);self.assertEqual(r.returncode,0,r.stderr)
        data=(self.root/'painted.glb').read_bytes();n=struct.unpack_from('<I',data,12)[0];doc=json.loads(data[20:20+n])
        placed=[doc['nodes'][i] for i in doc['scenes'][0]['nodes']]
        self.assertEqual([p['extras']['sketchupComponent'] for p in placed],['Tile','Tile'])
        self.assertEqual(len({p['extras']['sketchupDefinitionId'] for p in placed}),1)
        mats=[doc['materials'][doc['meshes'][doc['nodes'][p['children'][0]]['mesh']]['primitives'][0]['material']]['name'] for p in placed]
        self.assertEqual(sorted(mats),['Blue paint','Red paint'])
        self.assertEqual(len(doc['meshes']),2)
    @unittest.skipUnless(library_path(),'SketchUp SDK not installed')
    def test_real_native_skp_round_trip(self):
        source=self.root/'mesh.json';source.write_text(json.dumps({'meshes':[{'name':'Test wall','positions':[0,0,0,2,0,0,0,3,0],'material':{'name':'Test paint','color':[.8,.1,.2,1]}}]}))
        worker=Path(__file__).resolve().parent.parent/'server/sketchup_convert.py'
        for a,b in [(source,self.root/'model.skp'),(self.root/'model.skp',self.root/'model.glb')]:
            r=subprocess.run([sys.executable,str(worker),str(a),str(b)],capture_output=True,text=True,timeout=30);self.assertEqual(r.returncode,0,r.stderr)
        data=(self.root/'model.glb').read_bytes();n=struct.unpack_from('<I',data,12)[0];doc=json.loads(data[20:20+n]);self.assertEqual(doc['nodes'][0]['name'],'Test wall');self.assertEqual(doc['accessors'][0]['max'],[2,3,0])
