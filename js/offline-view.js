import { ws, escapeHtml } from './store.js';

// Deliberately independent of editing mounts and sync. Never calls touch/save, so the
// last local workspace and any pending upload remain exactly as they were.
export function showOfflineWorkspace(error) {
  const properties = ws.data?.properties || [];
  if (!properties.length) return false;
  const host = document.createElement('main'); host.className = 'view-scroll';
  document.body.replaceChildren(host);
  const render = id => {
    const p = properties.find(p => p.id === id) || properties[0];
    const finite = v => Number.isFinite(Number(v)) ? Number(v) : 0;
    const walls = (p.walls || []).map(w => ({ ax:finite(w.ax), ay:finite(w.ay), bx:finite(w.bx), by:finite(w.by), thickness:finite(w.thickness) }));
    const rooms = (p.rooms || []).map(r => ({ pts:(r.pts || []).map(q => [finite(q[0]),finite(q[1])]) }));
    const points = [...walls.flatMap(w => [[w.ax,w.ay],[w.bx,w.by]]), ...rooms.flatMap(r => r.pts || [])];
    const xs = points.map(q => q[0]), ys = points.map(q => q[1]);
    const x = points.length ? Math.min(...xs)-1 : 0, y = points.length ? Math.min(...ys)-1 : 0;
    const w = points.length ? Math.max(...xs)-x+1 : 10, h = points.length ? Math.max(...ys)-y+1 : 10;
    host.innerHTML = `<h1>Offline · saved project view</h1><p>Read only. This is the last copy available in this browser; it may include unsent changes. Reconnect to load models and documents from the Mac.</p>
      <select aria-label="Saved project">${properties.map(q => `<option value="${escapeHtml(q.id)}" ${q.id === p.id ? 'selected' : ''}>${escapeHtml(q.name)}</option>`).join('')}</select>
      <button class="btn" data-reconnect>RECONNECT</button><h2>${escapeHtml(p.name)}</h2>
      <svg role="img" aria-label="Saved plan, all levels superimposed" viewBox="${x} ${y} ${w} ${h}" style="width:100%;height:60vh;background:#eee">
      ${rooms.map(r => `<polygon points="${(r.pts || []).map(q => q.join(',')).join(' ')}" fill="#cec6b5" stroke="#aaa" stroke-width=".02"/>`).join('')}
      ${walls.map(q => `<line x1="${q.ax}" y1="${q.ay}" x2="${q.bx}" y2="${q.by}" stroke="#333" stroke-width="${q.thickness || .114}"/>`).join('')}</svg>
      <p>Saved plan; levels are superimposed. ${walls.length} walls, ${rooms.length} floor regions, ${(p.scans || []).length} source models. Evidence and geometry may be incomplete.</p>
      <p>${escapeHtml(error?.message || 'Server unavailable')}</p>`;
    host.querySelector('select').onchange = e => render(e.target.value);
    host.querySelector('[data-reconnect]').onclick = () => location.reload();
  };
  render(ws.data.settings?.activePropertyId); return true;
}
