// Pieces of the model that belong to a project, and subproject groups (project-pieces.js):
// loading drops links to missing projects, a click on a grouped piece selects its group,
// and the client page's states show Existing and one project at a time. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalisePieceProjects, clickGroupIds, groupMembers, assignProject, projectChoices,
  stateShows, projectsWithPieces, groupOf, EXISTING,
} from '../js/project-pieces.js';

function sample() {
  const projects = [
    { id: 'pj-trim', propertyId: 'p1', name: 'Wall trim', parentId: '' },
    { id: 'pj-entry', propertyId: 'p1', name: 'Entry', parentId: 'pj-trim' },
    { id: 'pj-kids', propertyId: 'p1', name: 'Kids rooms', parentId: 'pj-trim' },
    { id: 'pj-kitchen', propertyId: 'p1', name: 'Kitchen', parentId: '' },
    { id: 'pj-other', propertyId: 'p2', name: 'Elsewhere', parentId: '' },
  ];
  const prop = {
    id: 'p1', walls: [{ id: 'w1' }, { id: 'w2', projectId: 'pj-kitchen' }], openings: [], rooms: [], fixtures: [],
    trims: [
      { id: 't1', wallId: 'w1', projectId: 'pj-entry', y: 0.8 },
      { id: 't2', wallId: 'w1', projectId: 'pj-entry', y: 0.9 },
      { id: 't3', wallId: 'w1', projectId: 'pj-kids' },
      { id: 't4', wallId: 'w1', projectId: 'pj-trim' },
      { id: 't5', wallId: 'w1' },
    ],
    scans: [{ id: 's-house' }, { id: 's-stair', projectId: 'pj-trim' }],
  };
  return { projects, prop };
}

test('loading keeps links to this property\'s projects and drops the rest', () => {
  const { projects, prop } = sample();
  prop.trims.push({ id: 't6', projectId: 'pj-other' }, { id: 't7', projectId: 'pj-gone' }, { id: 't8', projectId: 42 });
  prop.removedRecords = [{ kind: 'projects', records: [{ id: 'pj-deleted' }] }];
  prop.trims.push({ id: 't9', projectId: 'pj-deleted' });
  normalisePieceProjects({ projects, properties: [prop] });
  const byId = Object.fromEntries(prop.trims.map(t => [t.id, t]));
  assert.equal(byId.t1.projectId, 'pj-entry');
  assert.equal('projectId' in byId.t6, false, 'another property\'s project');
  assert.equal('projectId' in byId.t7, false, 'a missing project');
  assert.equal('projectId' in byId.t8, false, 'not an id');
  assert.equal(byId.t9.projectId, 'pj-deleted', 'a deleted project waiting to be restored keeps its pieces');
  assert.equal('projectId' in byId.t5, false, 'no field is added to unlinked pieces');
});

test('a click on a grouped trim section selects its whole group, and only trim', () => {
  const { projects, prop } = sample();
  prop.walls[0].projectId = 'pj-entry';
  assert.deepEqual(clickGroupIds(prop, projects, 'trim', 't1'), ['t1', 't2']);
  assert.deepEqual(clickGroupIds(prop, projects, 'trim', 't3'), ['t3']);
  // A top-level project is not a group: its pieces are picked one at a time.
  assert.deepEqual(clickGroupIds(prop, projects, 'trim', 't4'), ['t4']);
  assert.deepEqual(clickGroupIds(prop, projects, 'trim', 't5'), ['t5']);
  assert.deepEqual(groupMembers(prop, 'pj-entry').map(m => m.kind + ':' + m.id), ['wall:w1', 'trim:t1', 'trim:t2']);
  assert.equal(groupOf(projects, prop.trims[0]).name, 'Entry');
  assert.equal(groupOf(projects, prop.trims[3]), null);
});

test('assigning moves pieces into a project and back to Existing', () => {
  const { projects, prop } = sample();
  assert.equal(assignProject(prop, [{ kind: 'trim', id: 't5' }, { kind: 'trim', id: 't3' }], 'pj-entry'), 2);
  assert.deepEqual(clickGroupIds(prop, projects, 'trim', 't1'), ['t1', 't2', 't3', 't5']);
  assert.equal(assignProject(prop, [{ kind: 'trim', id: 't5' }, { kind: 'trim', id: 'missing' }], ''), 1);
  assert.equal('projectId' in prop.trims[4], false);
  assert.equal(assignProject(prop, [{ kind: 'trim', id: 't1' }], 'pj-entry'), 0, 'already there');
});

test('project choices list Existing, then each project with its subprojects under it', () => {
  const { projects } = sample();
  assert.deepEqual(projectChoices(projects, 'p1').map(c => c.label), [
    'Existing (no project)', 'Wall trim', 'Wall trim / Entry', 'Wall trim / Kids rooms', 'Kitchen',
  ]);
});

test('the client page shows Existing alone, or Existing plus one project and its groups', () => {
  const { projects, prop } = sample();
  const ids = state => prop.trims.filter(stateShows(projects, state)).map(t => t.id);
  assert.deepEqual(ids(EXISTING), ['t5']);
  assert.deepEqual(ids('pj-trim'), ['t1', 't2', 't3', 't4', 't5']);
  assert.deepEqual(ids('pj-kitchen'), ['t5']);
  assert.deepEqual(prop.walls.filter(stateShows(projects, 'pj-trim')).map(w => w.id), ['w1'], 'the kitchen wall is not in the trim project');
  assert.deepEqual(prop.scans.filter(stateShows(projects, EXISTING)).map(s => s.id), ['s-house']);
  assert.deepEqual(projectsWithPieces(prop, projects).map(p => p.id), ['pj-trim', 'pj-kitchen']);
});
