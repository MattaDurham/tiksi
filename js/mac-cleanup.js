// CLEAN UNUSED STORAGE on the Mac (FILE → Settings → Workspace backup & maintenance). The Mac
// removes nothing on its own: this lists what a clean-up would remove, shows it, and removes
// exactly that list when asked. A changed list is shown again to be confirmed.
// Loaded only when that section is opened.
const HEADERS = { 'X-Tiksi-Workspace': '1' };

async function call(token, method, body) {
  const r = await fetch('/api/workspace/cleanup', {
    method, cache: 'no-store', signal: AbortSignal.timeout(120000),
    headers: { ...HEADERS, 'X-Tiksi-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let answer = null;
  try { answer = await r.json(); } catch (ignored) {}
  if (!r.ok) {
    const error = new Error(answer?.error || 'The Mac did not answer the clean-up (' + r.status + ')');
    error.status = r.status; error.code = answer?.code; error.plan = answer?.plan;
    throw error;
  }
  return answer;
}

// The clean-up, or null when this Mac's server does not offer it or does not serve this caller.
export async function macCleanup() {
  let cap;
  try {
    const r = await fetch('/api/workspace/capabilities', { headers: HEADERS, cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    cap = await r.json();
  } catch (ignored) { return null; }
  if (!Array.isArray(cap.features) || !cap.features.includes('storage-cleanup') || !cap.token) return null;
  return {
    list: () => call(cap.token, 'GET'),
    remove: plan => call(cap.token, 'POST', { copies: plan.copies.map(c => c.name), originals: plan.originals.map(o => o.hash) }),
  };
}

const count = (n, one, many) => n + ' ' + (n === 1 ? one : many);

// What the plan would remove, in one sentence, and what always stays.
export function describePlan(plan, fmtBytes) {
  if (!plan.count) return 'Nothing on the Mac can be removed: every saved copy and stored original is still in use or recent.';
  return 'A clean-up would remove ' + count(plan.copies.length, 'saved copy', 'saved copies') + ' and ' +
    count(plan.originals.length, 'stored original', 'stored originals') + ', ' + fmtBytes(plan.bytes) + ' in all. ' +
    'Removing cannot be undone. Always kept: the newest saved copy holding each property, every original a project file or a kept copy refers to, and anything sent or asked for in the last 30 days.';
}

export function describeResult(result, fmtBytes) {
  return 'Removed ' + count(result.copies, 'saved copy', 'saved copies') + ' and ' +
    count(result.originals, 'stored original', 'stored originals') + ' from the Mac; ' + fmtBytes(result.bytes) + ' freed.';
}
