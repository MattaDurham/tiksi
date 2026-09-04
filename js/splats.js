// Gaussian splats through @sparkjsdev/spark, loaded lazily: the 5 MB module is only
// fetched the first time a splat is imported or found on a property. One SparkRenderer
// lives in the scene while the viewer is mounted; every splat file becomes a SplatMesh.

let sparkMod = null;
let spark = null;

const FILE_TYPES = { ply: 'ply', spz: 'spz', splat: 'splat', ksplat: 'ksplat', sog: 'pcsogszip' };

export function splatFileType(ext) { return FILE_TYPES[ext] || undefined; }

async function loadModule() {
  if (!sparkMod) sparkMod = await import('@sparkjsdev/spark');
  return sparkMod;
}

// Make sure the single SparkRenderer exists for this renderer and sits in the scene.
export async function ensureSpark(renderer, scene, onDirty) {
  const mod = await loadModule();
  if (!spark || spark.renderer !== renderer) {
    if (spark) { if (spark.parent) spark.parent.remove(spark); spark.dispose(); }
    spark = new mod.SparkRenderer({ renderer, onDirty });
    spark.userData = { splatDraw: true, kind: 'sparkRenderer' };
    spark.name = 'spark';
  }
  spark.onDirty = onDirty;
  if (spark.parent !== scene) { if (spark.parent) spark.parent.remove(spark); scene.add(spark); }
  return mod;
}

// Objects that Spark draws with its own material; post passes that render the scene with
// override materials (AO normals, outline depth) must skip them.
export function splatDrawables() { return spark ? [spark] : []; }

// True while Spark still has sorting or upload work pending, so the viewer keeps rendering
// instead of idling on a half-sorted frame.
export function splatBusy() {
  if (!spark || !spark.parent) return false;
  return !!(spark.dirty || spark.sortDirty || spark.sorting || (spark.updateTimeoutId != null && spark.updateTimeoutId !== 0));
}

// Build a SplatMesh from stored bytes. Resolves once the splats are unpacked.
export async function loadSplat(buffer, ext, fileName, hooks) {
  const mod = await loadModule();
  const bytes = new Uint8Array(buffer);
  let fileType = splatFileType(ext);
  try { const sniffed = mod.getSplatFileType(bytes); if (sniffed) fileType = sniffed; } catch (e) { /* fall back to the extension */ }
  const mesh = new mod.SplatMesh({
    fileBytes: bytes, fileType, fileName,
    onProgress: ev => { if (hooks && hooks.progress && ev && ev.total) hooks.progress('Unpacking ' + fileName, ev.loaded / ev.total); },
  });
  await mesh.initialized;
  mesh.userData = { splat: true };
  return { mesh, count: mesh.numSplats || (mesh.packedSplats && mesh.packedSplats.numSplats) || 0 };
}

export function splatBounds(mesh, Box3) {
  try { const b = mesh.getBoundingBox(true); if (b && isFinite(b.min.x)) return b; } catch (e) { /* not ready */ }
  return new Box3(); // empty
}

export function disposeSplat(mesh) {
  try { mesh.dispose(); } catch (e) { /* already gone */ }
}

// Take the SparkRenderer out of the scene on unmount; the instance is kept because the
// WebGL context it belongs to persists for the life of the page.
export function releaseSplatRenderer() {
  if (spark && spark.parent) spark.parent.remove(spark);
  if (spark) spark.onDirty = undefined;
}
