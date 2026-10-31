import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkspace, propertyTemplate } from '../js/store.js';
import { prepareDiskProjects } from '../js/disk-workspace.js';

test('shared disk records and portable bundles retain cross-project material evidence', () => {
  const data = emptyWorkspace(), source = propertyTemplate('Source'), target = propertyTemplate('Target');
  source.id = 'prop-source'; target.id = 'prop-target';
  source.photos.push({ id: 'photo-source', name: 'Synthetic material evidence', thumb: 'data:image/png;base64,synthetic' });
  data.properties.push(source, target);
  data.materials.push({ id: 'mat-source', name: 'Sampled finish', custom: true, photoId: 'photo-source', propertyIds: [target.id] });
  const result = prepareDiskProjects(data);
  const saved = result.data.properties.find(p => p.id === target.id);
  assert.deepEqual(saved.photos, source.photos);
  assert.deepEqual(result.projectData[target.id].properties, [saved]);
  assert.equal(target.photos.length, 0, 'preparation does not mutate an in-progress edit');
  assert.deepEqual(prepareDiskProjects(result.data), result, 'later saves do not duplicate evidence');
});
