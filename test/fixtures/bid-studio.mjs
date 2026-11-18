import { emptyWorkspace, propertyTemplate } from '../../js/store.js';
import { trimTemplate } from '../../js/trims.js';
import { trimDesign } from '../../js/trim-design.js';

export function sampleWorkspace() {
  const w = emptyWorkspace(),
    p = propertyTemplate('Juniper Workshop · sample');
  p.id = 'sample-workshop';
  const level = p.levels[0].id;
  const project = (id, name, parentId = null) => ({
    id,
    name,
    parentId,
    propertyId: p.id,
    items: [],
    selected: true,
    status: 'scoped',
    category: 'interior',
  });
  w.properties.push(p);
  w.settings.activePropertyId = p.id;
  w.projects = [
    project('finish', 'Interior finish'),
    project('gallery', 'Gallery trim', 'finish'),
    project('reading', 'Reading room trim', 'finish'),
  ];
  w.projects[0].items.push({
    id: 'protection',
    name: 'Protect finished floors',
    qty: 2,
    unit: 'rooms',
    low: 55,
    likely: 65,
    high: 80,
  });
  const wall = (id, ax, ay, bx, by) => ({ id, level, ax, ay, bx, by, thickness: 0.12, height: 2.6 });
  p.walls = [
    wall('west', 0, 0, 0, 4),
    wall('gallery-n', 0, 0, 5.5, 0),
    wall('gallery-s', 0, 4, 5.5, 4),
    wall('partition', 5.5, 0, 5.5, 4),
    wall('reading-n', 5.5, 0, 8.8, 0),
    wall('east', 8.8, 0, 8.8, 4),
    wall('reading-s', 8.8, 4, 5.5, 4),
  ];
  p.rooms = [
    {
      id: 'gallery',
      name: 'Gallery',
      pts: [
        [0, 0],
        [5.5, 0],
        [5.5, 4],
        [0, 4],
      ],
      level,
    },
    {
      id: 'reading',
      name: 'Reading room',
      pts: [
        [5.5, 0],
        [8.8, 0],
        [8.8, 4],
        [5.5, 4],
      ],
      level,
    },
  ];
  p.openings = [
    { id: 'opening', wallId: 'partition', type: 'door', width: 0.91, height: 2.03, t: 0.55, sill: 0 },
  ];
  const design = trimDesign({
    prop: p,
    projects: w.projects,
    levelOf: () => level,
    wallsOn: () => p.walls,
    roomsOn: () => p.rooms,
    openingsOn: () => p.openings,
    heightOf: (wall) => wall.height,
  });
  for (const wall of p.walls)
    for (const side of [-1, 1]) {
      const room = design.info({
        id: 'probe',
        wallId: wall.id,
        side,
        style: 'chair-rail',
        f0: 0,
        f1: 1,
      })?.roomId;
      if (!p.rooms.some((r) => r.id === room)) continue;
      for (const style of room === 'gallery' ? ['baseboard', 'picture-frame', 'chair-rail'] : ['baseboard']) {
        const t = trimTemplate(
          style,
          null,
          wall,
          side,
          style === 'picture-frame' ? { y: 0.19, h: 0.65 } : {},
        );
        t.id = [wall.id, side, style].join('-');
        t.name = wall.id + ' : ' + style;
        t.projectId = room;
        p.trims.push(t);
      }
    }
  p.bidStudio = {
    draft: {
      title: 'Juniper finish carpentry',
      included: ['protection'],
      rules: { crew: 2 },
      start: '2027-02-05',
    },
  };
  return w;
}
