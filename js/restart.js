// RESTART TIKSI, at the bottom of the Tiksi menu: what is waiting is saved to the Mac, the
// Mac's server starts again with the code now in its folder (server/restart.py), and this page
// reloads once the server answers again. A long job on the Mac (photo to 3D, ...) is named and
// stopped only after a second yes.

const WAIT_MS = 60000;

async function startedAt() {
  try {
    const r = await fetch('/api/instance', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    return r.ok ? (await r.json()).started ?? null : null;
  } catch { return null; }
}

function cover(text) {
  let el = document.getElementById('tk-restarting');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tk-restarting';
    el.className = 'tk-restarting';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  return el;
}
const uncover = () => document.getElementById('tk-restarting')?.remove();

export async function restartTiksi(workspace, { ask = q => window.confirm(q), tell = m => window.alert(m), reload = () => location.reload(), waitMs = WAIT_MS } = {}) {
  if (!ask('Restart Tiksi?\n\nWhat is waiting is saved to the Mac first. Then the Mac\'s Tiksi server stops and starts again with its newest code, and this page reloads when it is back, in a few seconds.')) return false;
  const before = await startedAt();
  cover('SAVING, THEN RESTARTING TIKSI');
  try {
    try { await workspace.restart(false); }
    catch (error) {
      if (error.code !== 'busy') throw error;
      if (!ask(error.message + '\n\nRestart anyway?')) { uncover(); return false; }
      await workspace.restart(true);
    }
  } catch (error) {
    uncover();
    tell('Tiksi did not restart: ' + error.message);
    return false;
  }
  cover('RESTARTING TIKSI');
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const now = await startedAt();
    if (now != null && now !== before) { cover('TIKSI IS BACK. RELOADING'); reload(); return true; }
  }
  cover('The Mac\'s Tiksi server has not answered yet. Reload this page in a moment.');
  return false;
}
