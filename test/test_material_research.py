import copy
import io
import json
from email.message import Message
from pathlib import Path
import tempfile
import threading
import time
import sys
import unittest

from server.material_research import (CodexResearchRunner, MaterialResearchManager, MaterialResearchService,
    ResearchError, aggregate_results, exclude_unobserved_claims, public_url, validate_request, validate_result)


def product(price=None, value='1.8 GPM'):
    return {'name':'Synthetic faucet', 'brand':'Fixture Co', 'model':'FC-101',
        'url':'https://fixtures.example.com/fc-101', 'category':'faucet',
        'price':price, 'currency':'USD' if price is not None else None,
        'unit':'ea', 'priceStatus':'verified' if price is not None else 'unverified',
        'availability':'Unverified', 'specifications':[{'name':'Flow', 'value':value, 'sourceUrl':'https://fixtures.example.com/fc-101'}],
        'sourceEvidence':[{'url':'https://fixtures.example.com/fc-101','title':'Manufacturer', 'relevance':'Official specification', 'checkedAt':''}],
        'unknowns':[], 'fitNotes':[], 'sustainability':[], 'reviews':[], 'offers':[] if price is None else [{'vendor':'Fixture Co','url':'https://fixtures.example.com/fc-101','price':price,'currency':'USD','unit':'ea','priceStatus':'verified','availability':'Unknown','checkedAt':''}]}


REQUEST={'query':'Find a compatible faucet', 'context':{'name':'Fixture'}, 'constraints':{}, 'mode':'team'}


class Runner:
    timeout_seconds = 5
    def availability(self):
        return True, None
    def run(self, request, role, cancelled, on_search):
        on_search(2)
        if role == 'vendors':
            raise ResearchError('Vendor source unavailable')
        return validate_result({'products':[product()], 'unknowns':[]}, '2026-01-01T00:00:00Z')


class SlowRunner(Runner):
    def run(self, request, role, cancelled, on_search):
        cancelled.wait(5)
        raise ResearchError('Cancelled')


class ResearchTests(unittest.TestCase):
    def test_request_rejects_whole_project_and_private_payloads(self):
        for request in ({**REQUEST, 'project': {'rooms':[]}}, {**REQUEST, 'context':{'photos':['private.jpg']}},
                        {**REQUEST, 'constraints':{'budget':999}}, {**REQUEST, 'query':'x'}, {**REQUEST,'mode':'unlimited'}):
            with self.assertRaises(ResearchError):
                validate_request(request)
        self.assertEqual(validate_request(REQUEST)['query'], REQUEST['query'])

    def test_public_urls_reject_local_and_credentials(self):
        for url in ['file:///tmp/secret', 'https://user:secret@example.com/', 'http://localhost/',
                    'http://100.64.0.1/', 'http://10.0.0.1/', 'http://example.local/', 'http://[::1]/',
                    'https://example.com:8642/', 'javascript:alert(1)']:
            with self.assertRaises(ResearchError, msg=url):
                public_url(url)
        self.assertEqual(public_url('https://manufacturer.example.com/spec.pdf'), 'https://manufacturer.example.com/spec.pdf')

    def test_price_requires_currency_url_and_unit(self):
        for field, value in [('currency','dollars'), ('url','https://other.example.com/'), ('priceStatus','unverified')]:
            p=product(120)
            if field=='url':
                p['offers'][0][field]=value
            else:
                p[field]=value
            with self.assertRaises(ResearchError):
                validate_result({'products':[p], 'unknowns':[]}, 'checked')
        p=product(120)
        p['unit']=''
        result=validate_result({'products':[p], 'unknowns':[]}, 'checked')
        self.assertIsNone(result['products'][0]['price'])
        self.assertEqual(result['products'][0]['priceStatus'],'unverified')

    def test_all_technical_and_review_claims_must_have_evidence(self):
        p=product()
        p['reviews']=[{'summary':'Excellent', 'sourceUrl':'https://reviews.example.com/'}]
        with self.assertRaises(ResearchError):
            validate_result({'products':[p], 'unknowns':[]}, 'checked')

    def test_live_tool_provenance_rejects_hallucinated_citations_and_stale_price(self):
        url=product()['url']
        observed={url:{'status':'search-result','checkedAt':'live-check'}}
        result=validate_result({'products':[product(120)],'unknowns':[]},'checked',observed)
        self.assertIsNone(result['products'][0]['price'])
        self.assertEqual(result['products'][0]['sourceEvidence'][0]['sourceStatus'],'search-result')
        observed[url]['status']='opened'
        result=validate_result({'products':[product(120)],'unknowns':[]},'checked',observed)
        self.assertEqual(result['products'][0]['price'],120)
        self.assertEqual(result['products'][0]['sourceEvidence'][0]['checkedAt'],'live-check')
        with self.assertRaises(ResearchError):
            validate_result({'products':[product()],'unknowns':[]},'checked',{})

    def test_price_provenance_uses_exact_vendor_instead_of_manufacturer_link(self):
        p=product(120)
        vendor_url='https://vendor.example.com/fc-101'
        p['offers'][0]['url']=vendor_url
        p['sourceEvidence'].append({'url':vendor_url,'title':'Vendor','relevance':'Exact model price each','checkedAt':''})
        observed={url:{'status':'opened','checkedAt':'live-check'} for url in (p['url'],vendor_url)}
        actual=validate_result({'products':[p],'unknowns':[]},'checked',observed)['products'][0]
        self.assertEqual(actual['price'],120)
        self.assertEqual(actual['priceSourceUrl'],vendor_url)
        self.assertNotEqual(actual['priceSourceUrl'],actual['url'])

    def test_unopened_policy_does_not_destroy_verified_vendor_research(self):
        p=product(120)
        policy='https://vendor.example.com/shipping-policy'
        p['sourceEvidence'].append({'url':policy,'title':'Shipping policy','relevance':'Shipping','checkedAt':''})
        p['specifications'].append({'name':'Shipping','value':'Free everywhere','sourceUrl':policy})
        p['reviews'].append({'summary':'Good','sourceUrl':policy})
        observed={p['url']:{'status':'opened','checkedAt':'live-check'}}
        result=exclude_unobserved_claims({'products':[p],'unknowns':[]},observed)
        actual=validate_result(result,'checked',observed)['products'][0]
        self.assertEqual(actual['price'],120)
        self.assertEqual(len(actual['sourceEvidence']),1)
        self.assertEqual(len(actual['specifications']),1)
        self.assertEqual(actual['reviews'],[])
        self.assertEqual(len(actual['unknowns']),3)
        self.assertIn('Unconfirmed source excluded',actual['unknowns'][0])

    def test_invalid_or_missing_links_become_explicit_unknowns(self):
        p=product(120)
        p['sourceEvidence'].append({'url':'','title':'Unavailable document','relevance':'Unknown','checkedAt':''})
        p['specifications'].append({'name':'Unknown dimension','value':'10 inches','sourceUrl':''})
        p['offers'].append({'vendor':'Unverified vendor','url':'http://localhost/private','price':None,'currency':None,'unit':'','priceStatus':'unverified','availability':'Unknown','checkedAt':''})
        observed={p['url']:{'status':'opened','checkedAt':'live-check'}}
        actual=validate_result(exclude_unobserved_claims({'products':[p],'unknowns':[]},observed),'checked',observed)['products'][0]
        self.assertEqual(actual['price'],120)
        self.assertEqual(len(actual['sourceEvidence']),1)
        self.assertEqual(len(actual['specifications']),1)
        self.assertEqual(len(actual['offers']),1)
        self.assertEqual(len(actual['unknowns']),3)

    def test_subprocess_pipeline_requires_web_events_and_rejects_non_web_tools(self):
        with tempfile.TemporaryDirectory() as folder:
            script=Path(folder)/'synthetic_provider.py'
            class FixtureRunner(CodexResearchRunner):
                def command(self,directory,schema_path):
                    return [sys.executable,str(script)]
            runner=FixtureRunner(executable=sys.executable,timeout_seconds=10)
            def write_provider(events):
                script.write_text('import sys\nimport json\nsys.stdin.read()\n'+
                                  '\n'.join('print('+repr(json.dumps(event))+',flush=True)' for event in events),encoding='utf-8')
            result={'products':[product()], 'unknowns':[]}
            final={'type':'item.completed','item':{'type':'agent_message','text':json.dumps(result)}}
            source={'type':'item.completed','item':{'type':'web_search','action':{'type':'open_page'},'results':[{'url':product()['url']}]}}
            write_provider([source,final])
            searches=[]
            actual=runner.run(REQUEST,'focused',threading.Event(),searches.append)
            self.assertEqual(searches,[1])
            self.assertEqual(actual['products'][0]['sourceEvidence'][0]['sourceStatus'],'opened')
            write_provider([final])
            with self.assertRaisesRegex(ResearchError,'no verified live web'):
                runner.run(REQUEST,'focused',threading.Event(),searches.append)
            write_provider([{'type':'item.completed','item':{'type':'command_execution'}},source,final])
            with self.assertRaisesRegex(ResearchError,'prohibited non-web'):
                runner.run(REQUEST,'focused',threading.Event(),searches.append)

    def test_merge_preserves_conflicts_sources_and_offers(self):
        a=validate_result({'products':[product(100)], 'unknowns':['Stock unknown']}, 'checked')
        b=validate_result({'products':[product(120,'2.0 GPM')], 'unknowns':['Stock unknown']}, 'checked')
        products, unknowns, conflicts=aggregate_results([('a',a),('b',b)])
        self.assertEqual(len(products),1)
        self.assertEqual(len(products[0]['specifications']),2)
        self.assertEqual({offer['price'] for offer in products[0]['offers']},{100,120})
        self.assertEqual(len(conflicts),2)
        self.assertEqual(unknowns,['Stock unknown'])

    def wait_job(self, manager, job_id):
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            job=manager.get(job_id)
            if job['status'] not in ('queued','running'):
                return job
            time.sleep(.01)
        self.fail('Research did not finish')

    def test_team_runs_real_runner_seam_partial_status_persists(self):
        with tempfile.TemporaryDirectory() as state:
            manager=MaterialResearchManager(state, runner=Runner())
            try:
                job=self.wait_job(manager,manager.create(REQUEST)['id'])
                self.assertEqual(job['status'],'partial')
                self.assertEqual(len(job['products']),1)
                self.assertEqual([a['webSearches'] for a in job['agents']],[2,2,2])
                self.assertIn('Vendor source unavailable',[a['error'] for a in job['agents']])
                manager.get(job['id'])['products'].clear()
                self.assertEqual(len(manager.get(job['id'])['products']),1)
                self.assertEqual(json.loads((Path(state)/(job['id']+'.json')).read_text(encoding='utf-8'))['status'],'partial')
            finally:
                manager.close()

    def test_cancel_terminates_work_and_bounds_admission(self):
        with tempfile.TemporaryDirectory() as state:
            manager=MaterialResearchManager(state, runner=SlowRunner(), max_concurrent_jobs=1)
            try:
                job=manager.create(REQUEST)
                with self.assertRaises(ResearchError) as error:
                    manager.create(REQUEST)
                self.assertEqual(error.exception.status,429)
                self.assertEqual(manager.cancel(job['id'])['status'],'cancelled')
            finally:
                manager.close()
            self.assertTrue(all(a['status']=='cancelled' for a in manager.get(job['id'])['agents']))

    def test_restart_marks_interrupted_job_failed(self):
        with tempfile.TemporaryDirectory() as state:
            p=Path(state)/'record.json'
            p.write_text(json.dumps({'id':'00000000-0000-4000-8000-000000000000','status':'running'}),encoding='utf-8')
            manager=MaterialResearchManager(state,runner=Runner())
            try:
                self.assertEqual(manager.get('00000000-0000-4000-8000-000000000000')['status'],'failed')
                self.assertIn('Server restarted', manager.get('00000000-0000-4000-8000-000000000000')['error'])
            finally:
                manager.close()

    def test_http_requires_capability_token_and_same_origin(self):
        class Handler:
            def __init__(self, command, path, headers=None, payload=b''):
                self.command,self.path=command,path
                self.headers=Message()
                for key,value in (headers or {}).items():
                    self.headers[key]=value
                self.rfile=io.BytesIO(payload)
                self.wfile=io.BytesIO()
            def send_response(self,status): self.status=status
            def send_header(self,key,value): pass
            def end_headers(self): pass
        with tempfile.TemporaryDirectory() as state:
            service=MaterialResearchService(state,runner=Runner())
            try:
                capability=Handler('GET','/api/material-research/capabilities')
                self.assertTrue(service.dispatch(capability))
                token=json.loads(capability.wfile.getvalue())['token']
                body=json.dumps(REQUEST).encode()
                headers={'Host':'localhost:8642','Origin':'http://localhost:8642','Content-Type':'application/json','Content-Length':str(len(body))}
                rejected=Handler('POST','/api/material-research',headers,body)
                service.dispatch(rejected)
                self.assertEqual(rejected.status,403)
                headers['X-Tiksi-Token']=token
                headers['Origin']='https://attacker.example.com'
                rejected=Handler('POST','/api/material-research',headers,body)
                service.dispatch(rejected)
                self.assertEqual(rejected.status,403)
                headers['Origin']='http://localhost:8642'
                accepted=Handler('POST','/api/material-research',headers,body)
                service.dispatch(accepted)
                self.assertEqual(accepted.status,202)
                self.assertIn('job',json.loads(accepted.wfile.getvalue()))
            finally:
                service.close()


if __name__=='__main__':
    unittest.main()
