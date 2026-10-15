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

class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.service=ModelConversionService(self.root)
    def tearDown(self):self.service.close();self.temp.cleanup()
    def test_glb_writer_retains_units_metadata_and_alpha(self):
        out=self.root/'mesh.glb'
        write_glb([{'name':'Synthetic IFC wall','positions':[0,0,0,4,0,0,0,3,0],'indices':[0,1,2], 'material':{'name':'Paint','color':[1,0,0,.5]},'extras':{'ifcGlobalId':'synthetic','ifcClass':'IfcWall'}}],out)
        b=out.read_bytes();magic,version,length=struct.unpack_from('<III',b);self.assertEqual((magic,version,length),(0x46546c67,2,len(b)))
        n=struct.unpack_from('<I',b,12)[0];doc=json.loads(b[20:20+n]);self.assertEqual(doc['nodes'][0]['extras']['ifcClass'],'IfcWall');self.assertEqual(doc['accessors'][0]['max'],[4,3,0]);self.assertEqual(doc['materials'][0]['alphaMode'],'BLEND')
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
