import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openingProfileValue, setOpeningProfileValue, openingGridFields, setExplicitSlabWidth } from '../js/opening-profile-edit.js';
import { doorDetail, windowDetail } from '../js/wall-solids.js';
import { setEvidence, evidenceState } from '../js/evidence.js';

test('profile inspector reads and edits the explicit construction used by rendering', () => {
  const o={type:'door',width:.8,height:2,profile:{hardware:'lever',jambWidth:.04,panels:'six'},detail:{door:{hardware:'knob',jambWidth:.019,style:'slab',hinge:'end'}}};
  assert.equal(openingProfileValue(o,'hardware'),'knob');assert.equal(openingProfileValue(o,'panels'),'flat');assert.equal(openingProfileValue(o,'jambWidth'),.019);
  setOpeningProfileValue(o,'hardware','none');setOpeningProfileValue(o,'panels','six');setOpeningProfileValue(o,'jambWidth',.022);
  const d=doorDetail(o,o.width,o.height,false);
  assert.equal(d.hardware,'none');assert.equal(d.style,'six-panel');assert.equal(d.jambWidth,.022);assert.equal(d.hinge,'end');
  assert.equal(o.profile.jambWidth,.022,'the compatibility profile does not retain a contradictory previous value');
  setOpeningProfileValue(o,'jambWidth','');
  assert.equal(openingProfileValue(o,'jambWidth'),undefined);assert.equal(o.detail.door.jambWidth,undefined);assert.equal(o.profile.jambWidth,undefined);
});

test('profile-only records remain editable and do not acquire an invented detailed record', () => {
  const o={type:'door'};setOpeningProfileValue(o,'panels','six');setOpeningProfileValue(o,'hardware','knob');
  assert.equal(o.detail,undefined);assert.equal(openingProfileValue(o,'panels'),'six');
  const d=doorDetail(o,.8,2,false);assert.equal(d.style,'six-panel');assert.equal(d.hardware,'knob');
});

test('double-hung inspector edits the upper and lower grids independently', () => {
  const o={type:'window',profile:{columns:4,rows:3},detail:{window:{type:'double-hung',upperColumns:3,upperRows:2,lowerColumns:1,lowerRows:1}}};
  assert.deepEqual(openingGridFields(o),['upperColumns','upperRows','lowerColumns','lowerRows']);
  setOpeningProfileValue(o,'upperColumns',2);
  const d=windowDetail(o,1,1.4);assert.equal(d.upper.columns,2);assert.equal(d.lower.columns,1);assert.equal(d.lower.rows,1);
  assert.deepEqual(openingGridFields({type:'window',profile:{columns:2}}),['columns','rows']);
});

test('slab width edits update explicit records without creating one on a legacy opening', () => {
  const o={detail:{door:{leafWidth:.65,hinge:'end'}},profile:{leafWidth:.6}};
  setExplicitSlabWidth(o,.7);assert.equal(o.detail.door.leafWidth,.7);assert.equal(o.profile.leafWidth,.7);assert.equal(o.detail.door.hinge,'end');
  const legacy={width:.8};setExplicitSlabWidth(legacy,.7);assert.deepEqual(legacy,{width:.8});
});

test('reviewed construction evidence becomes stale after any supported detail changes', () => {
  const changes={detail:{door:{hinge:'end'}},ceilingHeight:2.07,baseboardPos:{height:.09},baseboardNeg:{height:.1},floorContinuity:false,doorState:'closed'};
  for(const [key,value] of Object.entries(changes)) {
    const record={width:1};setEvidence(record,'geometry','observed','Synthetic detail photo');assert.equal(evidenceState(record),'observed');
    record[key]=value;assert.equal(evidenceState(record),'stale',key+' invalidates the prior review');
  }
  const record={detail:{door:{hinge:'start'}}};setEvidence(record,'geometry','observed','Synthetic door photo');
  record.detail.door.hinge='end';assert.equal(evidenceState(record),'stale','nested edits invalidate evidence');
});
