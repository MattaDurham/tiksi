// Source revisions exclude labels and view preferences, and include source bytes and edits.
export function sourceRevision(scan) {
  if (!scan) return null;
  const fields = ['id','assetRevision','fileId','originalFileId','hash','sha256','bytes','size','convertedAt','pos','rot','rotY','position','rotation','scale','partOffsets','materialBindings','materialIdentities','componentProducts'];
  return JSON.stringify(fields.map(k => [k, scan[k] ?? null]));
}
export function takeoffState(project, prop) {
  const id = project.modelTakeoffId || project.modelComponentsId;
  if (!id) return null;
  const scan = prop?.scans?.find(s => s.id === id);
  if (!scan) return 'missing source';
  if (!project.sourceRevision) return 'unverified source version';
  return project.sourceRevision === sourceRevision(scan) ? 'current source version' : 'stale — source changed; review quantities';
}
