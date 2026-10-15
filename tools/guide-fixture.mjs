// Public-safe fixtures for the feature walkthrough. Call only in a new Playwright
// browser context on a branch/temporary server; this never reads an owner's store.
// Every image is drawn here and every price is fictional demonstration data.
export async function seedGuide(page) {
  const ids = await page.evaluate(async () => {
    if (location.port === '8642') throw new Error('Guide fixtures must use an isolated preview, never live port 8642.');
    const store = await import('/js/store.js');
    const { ensureBuiltinMaterials, normalizeMaterial } = await import('/js/materials.js');
    const { addPhotoFromFile } = await import('/js/photos-store.js');
    const { exportModel } = await import('/js/model-exchange.js');
    const { importScanBytes, loadMesh, disposeScanObject } = await import('/js/scans.js');
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const { setTextureQuality } = await import('/js/textures.js');
    store.replaceWorkspace(store.emptyWorkspace());
    ensureBuiltinMaterials();
    setTextureQuality('low');
    const d = store.ws.data;
    Object.assign(d.settings, { units: 'imperial', budgetCap: 30000, programStart: '2026-11-02', activePropertyId: 'prop-guide' });
    const p = store.propertyTemplate('Sample renovation');
    Object.assign(p, {
      id: 'prop-guide', wallHeight: 2.7,
      notes: 'SYNTHETIC WALKTHROUGH — Two-room renovation. Drawn reference images, fictional products and demonstration prices; no real property or quotation.',
      env: { ...store.defaultEnv(), time: 14, azimuth: 225, exposure: 1.1, quality: 'low', showGrid: false },
    });
    p.levels[0].name = 'Main floor'; p.levels[0].height = 2.7;
    const level = p.levels[0].id;
    const wall = (id, ax, ay, bx, by, material = 'mat-paint-greige', thickness = .16) => ({ id, ax, ay, bx, by, material, thickness, height: null, level });
    p.walls = [
      wall('guide-wall-north', 0, 0, 8.4, 0),
      wall('guide-wall-east', 8.4, 0, 8.4, 5.4),
      wall('guide-wall-south', 8.4, 5.4, 0, 5.4),
      wall('guide-wall-west', 0, 5.4, 0, 0),
      wall('guide-wall-partition', 4.8, 0, 4.8, 5.4, 'mat-paint-greige', .114),
    ];
    p.openings = [
      { id: 'guide-door-entry', wallId: 'guide-wall-south', type: 'door', t: .22, width: .96, height: 2.1 },
      { id: 'guide-door-rooms', wallId: 'guide-wall-partition', type: 'door', t: .7, width: .91, height: 2.1 },
      { id: 'guide-window-living', wallId: 'guide-wall-north', type: 'window', t: .27, width: 2.1, height: 1.4, sill: .7 },
      { id: 'guide-window-kitchen', wallId: 'guide-wall-north', type: 'window', t: .78, width: 1.5, height: 1.2, sill: 1.0 },
      { id: 'guide-window-west', wallId: 'guide-wall-west', type: 'window', t: .53, width: 1.8, height: 1.4, sill: .7 },
    ];
    p.rooms = [
      { id: 'guide-room-living', name: 'Living room', material: 'mat-lvp', ceilingMaterial: 'mat-ceiling', pts: [[0, 0], [4.8, 0], [4.8, 5.4], [0, 5.4]], level },
      { id: 'guide-room-kitchen', name: 'Kitchen', material: 'mat-tile-f', ceilingMaterial: 'mat-ceiling', pts: [[4.8, 0], [8.4, 0], [8.4, 5.4], [4.8, 5.4]], level },
    ];
    d.properties.push(p);
    const addMaterial = (record) => { normalizeMaterial(record); d.materials.push(record); };
    addMaterial({ id: 'mat-guide-sage', name: 'Soft sage paint · sample', kind: 'wall', color: '#a0af9c', pattern: 'drywall', custom: true });
    addMaterial({ id: 'mat-guide-tile', name: 'Warm ivory porcelain · sample', kind: 'floor', color: '#d9d4c7', pattern: 'tile', tile: [.6, .6], accent: '#b4ad9e', roughness: .5, custom: true });

    // Store a genuine self-contained GLB, so Before and Original download are real
    // application operations rather than screenshot-only mock controls.
    const before = await exportModel(p, { format: 'glb', source: 'design' });
    const beforeMesh = await loadMesh(await before.blob.arrayBuffer(), 'glb');
    // Use an open-top reference, matching the native viewer's dollhouse view.
    // The editable snapshot below still carries the full room/ceiling definition.
    const ceilings = [];
    beforeMesh.traverse(node => { if (node.userData.tiksiElementKind === 'ceiling') ceilings.push(node); });
    ceilings.forEach(node => node.removeFromParent());
    const beforeBytes = await new GLTFExporter().parseAsync(beforeMesh, { binary: true });
    ceilings.forEach(node => beforeMesh.add(node));
    disposeScanObject(beforeMesh);
    const beforeScan = await importScanBytes(beforeBytes, 'Sample existing conditions.glb', p, null, { visible: false, designSnapshot: true });
    beforeScan.name = 'Before · existing conditions';
    beforeScan.parametricSnapshot = JSON.parse(JSON.stringify({ levels: p.levels, walls: p.walls, rooms: p.rooms, openings: p.openings }));
    for (const w of p.walls) w.material = 'mat-guide-sage';
    p.rooms[0].material = 'mat-oak'; p.rooms[1].material = 'mat-guide-tile';
    p.openings.find(o => o.id === 'guide-door-rooms').width = 1.7;
    p.designComparison = { beforeId: beforeScan.id, afterId: 'design', view: 'after' };

    const item = (id, name, qty, unit, low, likely, high, durationDays, deps = [], elementIds = []) => ({
      id, name, qty, unit, low, likely, high, durationDays, deps, elementIds,
      notes: 'FICTIONAL DEMO estimate. Replace quantities, rates, lead times and scope with verified project information.',
    });
    d.projects = [
      {
        id: 'guide-project-kitchen', name: 'Kitchen refresh', propertyId: p.id, category: 'kitchen', status: 'committed', selected: true, startDate: '2026-11-02',
        notes: 'Synthetic scope: protect, remove finishes, open the doorway, install new floor and paint. All costs are fictional.',
        items: [
          item('guide-item-protect', 'Protect floors & remove old finishes', 1, 'ls', 650, 850, 1100, 2, [], ['guide-room-kitchen']),
          item('guide-item-opening', 'Widen opening between rooms', 1, 'ls', 1100, 1500, 2100, 2, ['guide-item-protect'], ['guide-door-rooms', 'guide-wall-partition']),
          item('guide-item-tile', 'Install ivory porcelain flooring', 230, 'sf', 8, 11, 15, 3, ['guide-item-opening'], ['guide-room-kitchen']),
          item('guide-item-cabinets', 'Refinish cabinet fronts', 1, 'ls', 2200, 2900, 3800, 4, ['guide-item-protect'], []),
          item('guide-item-paint', 'Prepare & paint sage walls', 920, 'sf', 1.3, 1.8, 2.5, 3, ['guide-item-tile', 'guide-item-cabinets'], ['guide-wall-north', 'guide-wall-east', 'guide-wall-partition']),
          item('guide-item-light', 'Install pendant & finish hardware', 1, 'ls', 450, 650, 900, 1, ['guide-item-paint'], ['guide-room-kitchen']),
        ],
      },
      {
        id: 'guide-project-living', name: 'Living room finishes', propertyId: p.id, category: 'interior', status: 'scoped', selected: true, startDate: '2026-11-05',
        notes: 'Synthetic scope for the adjacent room. Material selection is linked to saved products.',
        items: [
          item('guide-item-oak', 'Lay white oak flooring', 310, 'sf', 9, 12, 16, 3, [], ['guide-room-living']),
          item('guide-item-trim', 'Refit trim & touch up', 85, 'lf', 5, 7, 10, 2, ['guide-item-oak'], ['guide-room-living']),
        ],
      },
      {
        id: 'guide-project-future', name: 'Future built-in shelving', propertyId: p.id, category: 'interior', status: 'idea', selected: false, startDate: '',
        notes: 'Optional idea. Toggle selection to see how it changes the program budget and schedule.',
        items: [item('guide-item-shelves', 'Design & install shelving', 1, 'ls', 1800, 2600, 3800, 4, [], ['guide-wall-west'])],
      },
    ];

    // Canvas illustrations deliberately carry their synthetic status in the pixels,
    // which remains visible when a screenshot is detached from the guide caption.
    const reference = (title, kind, after = false) => {
      const c = document.createElement('canvas'); c.width = 1280; c.height = 960;
      const ctx = c.getContext('2d');
      const poly = (points, color) => { ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); };
      const rect = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
      const gradient = ctx.createLinearGradient(0, 0, 0, 960); gradient.addColorStop(0, '#edeae2'); gradient.addColorStop(1, '#d4cbbd');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1280, 960);
      if (kind === 'oak') {
        rect(90, 130, 1100, 650, '#ba9366');
        for (let row = 0; row < 11; row++) {
          const y = 130 + row * 61;
          rect(90, y, 1100, 2, '#866a4a');
          for (let col = 0; col < 4; col++) {
            const x = 90 + col * 350 - (row % 2) * 175;
            rect(Math.max(90, x), y, 2, 61, '#987451');
            ctx.strokeStyle = 'rgba(112,75,43,.12)'; ctx.lineWidth = 1;
            for (let grain = 0; grain < 8; grain++) { ctx.beginPath(); ctx.moveTo(x, y + 6 + grain * 6); ctx.bezierCurveTo(x + 90, y + grain * 7, x + 220, y + 12 + grain * 6, x + 350, y + 4 + grain * 6); ctx.stroke(); }
          }
        }
      } else {
        poly([[0, 0], [1280, 0], [1010, 160], [245, 160]], '#f5f2e9');
        poly([[0, 0], [245, 160], [245, 680], [0, 900]], '#d6d0c4');
        rect(245, 160, 765, 520, after ? '#a3b19d' : '#d4c2af');
        poly([[1010, 160], [1280, 0], [1280, 900], [1010, 680]], after ? '#8e9f89' : '#c5b6a4');
        poly([[245, 680], [1010, 680], [1280, 960], [0, 960]], kind === 'living' ? '#c4a174' : after ? '#d2cbbb' : '#9d9d95');
        for (let i = 0; i < 9; i++) { ctx.strokeStyle = 'rgba(81,62,43,.14)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(245 + i * 96, 680); ctx.lineTo(-110 + i * 185, 960); ctx.stroke(); }
        // Window frame and sky.
        rect(620, 219, 245, 267, '#f5f2e9'); rect(635, 234, 215, 237, '#c5d9de');
        rect(738, 234, 8, 237, '#f5f2e9'); rect(635, 347, 215, 8, '#f5f2e9');
        poly([[245, 680], [630, 680], [1090, 900], [650, 900]], 'rgba(255,247,213,.26)');
        if (kind === 'living') {
          rect(333, 542, 385, 147, '#bab4a7'); rect(312, 574, 38, 138, '#a8a394'); rect(700, 574, 38, 138, '#a8a394');
          rect(359, 568, 145, 98, '#d3cebf'); rect(522, 568, 145, 98, after ? '#788d7c' : '#b3a99a');
          poly([[680, 790], [925, 790], [1010, 858], [721, 858]], '#a8865c'); rect(743, 857, 12, 55, '#705d45'); rect(955, 852, 12, 58, '#705d45');
          rect(921, 531, 17, 166, '#4c5350'); poly([[881, 503], [974, 503], [997, 553], [860, 553]], '#eee4ce');
        } else {
          rect(293, 452, 289, 225, after ? '#e5e0d4' : '#a58566'); rect(281, 441, 313, 22, '#f0eadd');
          for (let i = 0; i < 3; i++) { rect(307 + i * 90, 476, 73, 180, after ? '#d8d3c5' : '#927253'); rect(359 + i * 90, 504, 8, 30, '#585a50'); }
          rect(883, 443, 100, 235, after ? '#cdd2c5' : '#ae967e'); rect(872, 434, 122, 21, '#ece8df');
          // Island.
          poly([[549, 687], [881, 687], [971, 765], [574, 765]], '#f0eadd');
          poly([[574, 765], [971, 765], [971, 904], [574, 904]], after ? '#81917a' : '#967c60');
          rect(733, 774, 3, 120, 'rgba(49,61,45,.2)');
          ctx.strokeStyle = '#4d5147'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(521, 0); ctx.lineTo(521, 172); ctx.stroke();
          poly([[469, 172], [573, 172], [601, 220], [441, 220]], '#d2b680');
          rect(322, 384, 49, 56, '#b1ad9d'); poly([[346, 383], [317, 327], [352, 349], [378, 318], [366, 379]], '#6f856a');
        }
      }
      rect(0, 0, 1280, 75, 'rgba(32,44,42,.84)');
      ctx.fillStyle = '#ffffff'; ctx.font = '600 27px system-ui'; ctx.fillText(title, 42, 48);
      rect(0, 880, 1280, 80, 'rgba(245,243,236,.94)');
      ctx.fillStyle = '#4b594e'; ctx.font = '600 20px system-ui'; ctx.fillText('SYNTHETIC WALKTHROUGH / DRAWN REFERENCE', 42, 928);
      return c;
    };
    const imageFile = async (canvas, name) => new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], name, { type: 'image/png' });
    const photoDefinitions = [
      ['Kitchen — existing conditions', 'kitchen', false, 'guide-room-kitchen', ['guide-wall-north', 'guide-room-kitchen'], ['guide-item-protect'], { x: 6.3, y: 1.35, z: .12, nx: 0, ny: 0, nz: 1, size: .7 }],
      ['Kitchen — sage finish study', 'kitchen', true, 'guide-room-kitchen', ['guide-wall-east'], ['guide-item-paint'], { x: 8.28, y: 1.15, z: 2.2, nx: -1, ny: 0, nz: 0, size: .7 }],
      ['Living room — finish study', 'living', true, 'guide-room-living', ['guide-room-living'], ['guide-item-oak'], { x: .12, y: 1.3, z: 2.6, nx: 1, ny: 0, nz: 0, size: .7 }],
      ['White oak — material sample', 'oak', true, 'guide-room-living', ['guide-room-living'], ['guide-item-oak'], null],
    ];
    const photoIds = [];
    for (const [title, kind, after, roomId, elementIds, itemIds, pin] of photoDefinitions) {
      const photo = await addPhotoFromFile(p, await imageFile(reference(title, kind, after), title + '.png'), { kind: 'photo' });
      Object.assign(photo, { name: title, roomId, elementIds, itemIds, pin, createdAt: '2026-10-15T12:00:00.000Z', notes: 'SYNTHETIC illustration drawn by the walkthrough fixture. This is not a photograph or an actual renovation outcome.' });
      photoIds.push(photo.id);
    }
    const thumbnail = (kind, color) => {
      const c = document.createElement('canvas'); c.width = 600; c.height = 360;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#e5e2d7'; ctx.fillRect(0, 0, 600, 360);
      if (kind === 'paint') {
        ctx.fillStyle = color; ctx.fillRect(180, 70, 240, 214); ctx.fillStyle = '#f6f3e9'; ctx.fillRect(178, 60, 244, 25); ctx.fillStyle = '#ece9df'; ctx.fillRect(202, 127, 196, 95);
        ctx.fillStyle = '#425448'; ctx.font = '600 28px system-ui'; ctx.fillText('SOFT SAGE', 220, 170);
      } else if (kind === 'light') {
        ctx.strokeStyle = '#655e4f'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(300, 0); ctx.lineTo(300, 145); ctx.stroke();
        ctx.fillStyle = '#b99b60'; ctx.beginPath(); ctx.moveTo(230, 145); ctx.lineTo(370, 145); ctx.lineTo(410, 212); ctx.lineTo(190, 212); ctx.closePath(); ctx.fill();
      } else {
        ctx.fillStyle = color; ctx.fillRect(105, 45, 390, 250); ctx.strokeStyle = 'rgba(68,54,39,.25)'; ctx.lineWidth = 3;
        for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(105, 45 + i * 50); ctx.lineTo(495, 45 + i * 50); ctx.stroke(); }
        for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(105 + i * 97, 45); ctx.lineTo(105 + i * 97, 295); ctx.stroke(); }
      }
      ctx.fillStyle = '#f6f3e9'; ctx.fillRect(0, 318, 600, 42); ctx.fillStyle = '#596351'; ctx.font = '600 16px system-ui'; ctx.fillText('FICTIONAL SAMPLE PRODUCT', 170, 346);
      return c.toDataURL('image/png');
    };
    const product = (id, name, category, price, unit, itemIds, materialIds, kind, color, specs) => ({
      id, name, category, brand: 'Sample Studio', model: 'DEMO', price, unit, itemIds, materialIds,
      url: '', imageUrl: thumbnail(kind, color), specs,
      notes: 'FICTIONAL DEMO PRODUCT AND PRICE. Demonstrates product links only; this is not an available vendor item or quotation.',
    });
    d.products = [
      product('guide-product-paint', 'Soft sage interior paint · sample', 'paint', .42, 'sf', ['guide-item-paint'], ['mat-guide-sage'], 'paint', '#a0af9c', 'Finish: matte\nColor: soft sage\nPrice basis: fictional coverage allowance'),
      product('guide-product-oak', 'White oak plank · sample', 'flooring', 6.5, 'sf', ['guide-item-oak'], ['mat-oak'], 'oak', '#c7a172', 'Width: 5 in\nFinish: natural matte\nQuantity allowance: 310 sf\nFictional demo price'),
      product('guide-product-tile', 'Ivory porcelain tile · sample', 'tile', 4.25, 'sf', ['guide-item-tile'], ['mat-guide-tile'], 'tile', '#d9d4c7', 'Size: 24 × 24 in\nFinish: honed\nQuantity allowance: 230 sf\nFictional demo price'),
      product('guide-product-pendant', 'Brass pendant · sample', 'lighting', 195, 'ea', ['guide-item-light'], [], 'light', '#b99b60', 'Diameter: 14 in\nFinish: brushed brass\nFictional demo price'),
    ];
    store.touch(); store.save();
    return {
      propertyId: p.id, levelId: level, roomIds: p.rooms.map(r => r.id), wallIds: p.walls.map(w => w.id), openingIds: p.openings.map(o => o.id),
      photoIds, projectIds: d.projects.map(pr => pr.id), itemIds: d.projects.flatMap(pr => pr.items.map(it => it.id)), productIds: d.products.map(pr => pr.id),
      materialIds: ['mat-guide-sage', 'mat-guide-tile', 'mat-oak'], beforeId: beforeScan.id, afterId: 'design',
    };
  });
  // Route remount after seeding also proves the saved fixture is the source of the UI.
  await page.reload();
  await page.locator('[data-prop-name]').waitFor();
  return ids;
}
