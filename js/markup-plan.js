// PLAN's side of markup mode: what markup-layer.js needs from the plan (plan metres to and
// from the screen, the level, a picture of the plan to put a markup's ink on). Fetched with
// the layer the first time MARK UP is wanted, so none of this is in the app's first load;
// plan2d.js hands over `v` (its markupParts()).
import { attachMarkup, ready } from './markup-layer.js';
import { markupBounds } from './markups.js';

export { ready };

export function attachPlanMarkup(v) {
  const { wrapEl, RULER } = v;
  const layer = attachMarkup({
    kind: 'plan', wrap: wrapEl, surface: v.canvas,
    prop: v.prop,
    levelId: () => v.lvl().id,
    toDoc: (x, y) => v.s2w(x, y),
    toPx: (x, y) => v.w2s([x, y]),
    unit: () => v.vs().zoom,
    viewKey: () => { const s = v.vs(); return v.lvl().id + ':' + s.zoom + ':' + s.panX + ':' + s.panY; },
    // Show a markup: its level, with everything in it on the screen.
    goTo(m) {
      if (v.prop().levels.some(l => l.id === m.levelId) && m.levelId !== v.lvl().id) v.switchLevel(m.levelId);
      const b = markupBounds(m), s = v.vs();
      if (!b) return;
      const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
      const bw = Math.max(b[2] - b[0], 0.5), bh = Math.max(b[3] - b[1], 0.5);
      const shown = (b[0] - s.panX) * s.zoom > RULER && (b[1] - s.panY) * s.zoom > RULER && (b[2] - s.panX) * s.zoom < w && (b[3] - s.panY) * s.zoom < h;
      if (shown) return;
      s.zoom = Math.max(4, Math.min(400, s.zoom, (w - RULER) / (bw * 1.4), (h - RULER) / (bh * 1.4)));
      s.panX = (b[0] + b[2]) / 2 - (w + RULER) / 2 / s.zoom;
      s.panY = (b[1] + b[3]) / 2 - (h + RULER) / 2 / s.zoom;
      v.invalidate();
    },
    // The markup's level as a picture (the level and everything the markup holds, fitted, twice
    // the screen's size at most), with the markup's ink and note numbers on top when `marks` is
    // on. With or without the marks the fit is the same, so the two pictures line up.
    async picture(m, marks) {
      if (!v.prop().levels.some(l => l.id === m.levelId)) throw new Error('The level this markup was drawn on is gone.');
      if (m.levelId !== v.lvl().id) v.switchLevel(m.levelId);
      const W = Math.max(640, wrapEl.clientWidth), H = Math.max(480, wrapEl.clientHeight), scale = Math.min(2, 2400 / W);
      // (`over` runs while the plan still has the fitted view it was just drawn with.)
      return v.planImage(W, H, scale, false, marks ? c => layer.paint(c, m, (x, y) => v.w2s([x, y]), v.vs().zoom, n => v.w2s(n.at), 13) : null, markupBounds(m));
    },
    hint: text => { if (text) v.setHint(text); else v.updateHint(); },
    toast: v.say,
    // Markup mode went on or off, or its tool changed: the page's own tools stand down.
    changed(on) {
      if (on) v.stand();
      v.renderToolCol(); v.renderInspector(); v.updateCursor(); v.invalidate();
      if (!on) v.updateHint();
    },
  });
  return layer;
}
