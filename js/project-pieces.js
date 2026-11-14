// Which project a piece of the model belongs to, and groups of pieces.
//
// Any wall, opening, fixture, room, trim section or model record (prop.scans) can carry a
// `projectId`: the id of a project, or of one of its subprojects, on the same property. A
// piece with no projectId is part of the house as it stands (Existing). A piece whose project
// is a subproject is in that subproject's group: a click on one piece of a group selects
// every piece of the group of that kind, so a whole run of trim moves as one.
//
// The client page in the lab (client-view.js) shows Existing on its own, or Existing plus one
// project's pieces (the project's own and its subprojects'). Pure functions, shared by MODEL,
// the publish step and tests.

export const PIECE_KINDS = { wall: 'walls', opening: 'openings', fixture: 'fixtures', room: 'rooms', trim: 'trims', scan: 'scans' };
export const EXISTING = 'existing';
export const EXISTING_LABEL = 'Existing';

const COLLECTIONS = Object.values(PIECE_KINDS);

// Drop a projectId that names no project of this property; keep a valid one as it is. A
// project deleted from PROJECTS waits in the property's recovery list (recovery.js), so its
// pieces keep their link and come back with it when it is restored.
export function normalisePieceProjects(data) {
  const projects = Array.isArray(data && data.projects) ? data.projects : [];
  for (const prop of (data && data.properties) || []) {
    const own = new Set(projects.filter(pr => pr.propertyId === prop.id).map(pr => pr.id));
    for (const entry of prop.removedRecords || []) if (entry && entry.kind === 'projects') for (const r of entry.records || []) if (r && r.id) own.add(r.id);
    for (const key of COLLECTIONS) for (const rec of prop[key] || []) {
      if (!rec || typeof rec !== 'object' || !('projectId' in rec)) continue;
      if (typeof rec.projectId !== 'string' || !own.has(rec.projectId)) delete rec.projectId;
    }
  }
  return data;
}

export function pieceRecord(prop, kind, id) {
  const key = PIECE_KINDS[kind];
  return key ? (prop[key] || []).find(r => r && r.id === id) || null : null;
}
export function pieceProjectId(rec) { return rec && typeof rec.projectId === 'string' ? rec.projectId : ''; }

// The subproject a piece is grouped in, or null (no project, or a top-level project).
export function groupOf(projects, rec) {
  const id = pieceProjectId(rec);
  if (!id) return null;
  const pr = projects.find(p => p.id === id);
  return pr && pr.parentId ? pr : null;
}

// Every piece whose projectId is `projectId`, as [{ kind, id }]; `kind` limits it to one kind.
export function groupMembers(prop, projectId, kind) {
  const out = [];
  if (!projectId) return out;
  for (const [k, key] of Object.entries(PIECE_KINDS)) {
    if (kind && k !== kind) continue;
    for (const rec of prop[key] || []) if (rec && rec.id && rec.projectId === projectId) out.push({ kind: k, id: rec.id });
  }
  return out;
}

// What a click on this piece selects: the ids of its group's pieces of the same kind, or just
// its own id when it is in no group.
export function clickGroupIds(prop, projects, kind, id) {
  const rec = pieceRecord(prop, kind, id);
  const group = groupOf(projects, rec);
  if (!group) return [id];
  const ids = groupMembers(prop, group.id, kind).map(m => m.id);
  return ids.length ? ids : [id];
}

// Put these pieces in `projectId` ('' takes them out of any project). Returns how many changed.
export function assignProject(prop, refs, projectId) {
  let n = 0;
  for (const { kind, id } of refs) {
    const rec = pieceRecord(prop, kind, id);
    if (!rec) continue;
    if (projectId) { if (rec.projectId !== projectId) { rec.projectId = projectId; n++; } }
    else if ('projectId' in rec) { delete rec.projectId; n++; }
  }
  return n;
}

// The choices for a piece's project: Existing, then each top-level project and its subprojects.
export function projectChoices(projects, propId) {
  const own = projects.filter(p => p.propertyId === propId);
  const out = [{ id: '', label: EXISTING_LABEL + ' (no project)', depth: 0 }];
  for (const top of own.filter(p => !p.parentId)) {
    out.push({ id: top.id, label: top.name || 'Untitled project', depth: 0 });
    for (const sub of own.filter(p => p.parentId === top.id)) out.push({ id: sub.id, label: (top.name || 'Untitled project') + ' / ' + (sub.name || 'Untitled'), depth: 1, parentId: top.id });
  }
  return out;
}

// The top-level project a project id rolls up to (itself, or its parent).
export function topProjectId(projects, id) {
  const pr = projects.find(p => p.id === id);
  if (!pr) return '';
  return pr.parentId || pr.id;
}

// Which pieces a client sees in a state: EXISTING shows the pieces with no project; a project
// id shows those plus every piece of that project and of its subprojects. A piece of a project
// that was deleted shows in none of them.
export function stateShows(projects, stateId) {
  if (!stateId || stateId === EXISTING) return rec => !pieceProjectId(rec);
  const ids = new Set([stateId, ...projects.filter(p => p.parentId === stateId).map(p => p.id)]);
  return rec => { const id = pieceProjectId(rec); return !id || ids.has(id); };
}

// The top-level projects that own at least one piece of this property, in list order.
export function projectsWithPieces(prop, projects) {
  const used = new Set();
  for (const key of COLLECTIONS) for (const rec of prop[key] || []) { const id = pieceProjectId(rec); if (id) used.add(topProjectId(projects, id)); }
  return projects.filter(p => p.propertyId === prop.id && !p.parentId && used.has(p.id));
}
