// Demo workspace: a generic colonial with a realistic renovation program.
// Public-safe sample data; replace with your own property and projects.

import { isoToday, addDays } from './store.js';

export function demoWorkspace() {
  const ext = { thickness: 0.165, material: 'mat-fiber' };
  const int = { thickness: 0.114, material: 'mat-drywall' };
  const W = (id, ax, ay, bx, by, kind) => Object.assign({ id, ax, ay, bx, by, height: null }, kind);
  const O = (id, wallId, type, t, width, height, sill) => ({ id, wallId, type, t, width, height, sill });

  return {
    version: 1,
    settings: {
      units: 'imperial',
      budgetCap: 150000,
      programStart: addDays(isoToday(), 14),
      activePropertyId: 'prop-demo',
    },
    properties: [{
      id: 'prop-demo',
      name: 'Demo colonial (rename me)',
      notes: 'Sample first floor. Replace with your own home: upload a floorplan image, calibrate, trace.',
      wallHeight: 2.44,
      plan: null,
      walls: [
        // Exterior shell, 40 x 28 ft.
        W('w-ext-n', 0, 0, 12.2, 0, ext),
        W('w-ext-e', 12.2, 0, 12.2, 8.5, ext),
        W('w-ext-s', 12.2, 8.5, 0, 8.5, ext),
        W('w-ext-w', 0, 8.5, 0, 0, ext),
        // Interior partitions.
        W('w-int-1', 0, 4.6, 12.2, 4.6, int),
        W('w-int-2', 5.0, 0, 5.0, 4.6, int),
        W('w-int-3', 7.3, 4.6, 7.3, 8.5, int),
      ],
      openings: [
        O('o-front', 'w-ext-s', 'door', 0.20, 0.914, 2.032),
        O('o-win-s1', 'w-ext-s', 'window', 0.607, 0.914, 1.219, 0.762),
        O('o-win-s2', 'w-ext-s', 'window', 0.82, 0.914, 1.219, 0.762),
        O('o-win-n1', 'w-ext-n', 'window', 0.205, 0.914, 1.219, 0.762),
        O('o-win-n2', 'w-ext-n', 'window', 0.705, 1.219, 1.219, 0.914),
        O('o-win-w1', 'w-ext-w', 'window', 0.235, 0.914, 1.219, 0.762),
        O('o-win-w2', 'w-ext-w', 'window', 0.729, 0.914, 1.219, 0.762),
        O('o-win-e1', 'w-ext-e', 'window', 0.27, 0.914, 1.219, 0.762),
        O('o-arch-1', 'w-int-1', 'door', 0.213, 1.524, 2.032),
        O('o-door-kf', 'w-int-1', 'door', 0.77, 0.914, 2.032),
        O('o-door-kd', 'w-int-2', 'door', 0.78, 0.914, 2.032),
        O('o-arch-2', 'w-int-3', 'door', 0.41, 1.524, 2.032),
      ],
      rooms: [
        { id: 'r-dining', name: 'Dining', material: 'mat-oak', pts: [[0, 0], [5.0, 0], [5.0, 4.6], [0, 4.6]] },
        { id: 'r-kitchen', name: 'Kitchen', material: 'mat-tile-f', pts: [[5.0, 0], [12.2, 0], [12.2, 4.6], [5.0, 4.6]] },
        { id: 'r-living', name: 'Living', material: 'mat-oak', pts: [[0, 4.6], [7.3, 4.6], [7.3, 8.5], [0, 8.5]] },
        { id: 'r-foyer', name: 'Foyer', material: 'mat-oak', pts: [[7.3, 4.6], [12.2, 4.6], [12.2, 8.5], [7.3, 8.5]] },
      ],
      scans: [],
    }],
    materials: [],
    products: [
      {
        id: 'prod-dw', name: '800 Series dishwasher', brand: 'Bosch', model: 'SHX78B75UC',
        category: 'appliance', url: 'https://www.bosch-home.com/us/', price: 1149, unit: 'ea', imageUrl: '',
        specs: 'Width: 24 in\nSound: 42 dBA\nFinish: stainless\nThird rack: yes', notes: '', itemIds: ['it-k-appl'],
      },
      {
        id: 'prod-range', name: '36 in professional gas range', brand: 'ZLINE', model: 'RG36',
        category: 'appliance', url: 'https://www.zlinekitchen.com/', price: 2749, unit: 'ea', imageUrl: '',
        specs: 'Width: 36 in\nBurners: 6\nOven: 5.2 cu ft convection', notes: '', itemIds: ['it-k-appl'],
      },
      {
        id: 'prod-faucet', name: 'Bellera pull-down kitchen faucet', brand: 'Kohler', model: 'K-560-VS',
        category: 'plumbing', url: 'https://www.kohler.com/', price: 215, unit: 'ea', imageUrl: '',
        specs: 'Finish: vibrant stainless\nFlow: 1.5 gpm\nSpray: 3-function', notes: '', itemIds: ['it-k-finish'],
      },
      {
        id: 'prod-tile', name: 'Rittenhouse 3x6 subway tile', brand: 'Daltile', model: '0190',
        category: 'tile', url: 'https://www.daltile.com/', price: 2.30, unit: 'sf', imageUrl: '',
        specs: 'Size: 3 x 6 in\nFinish: glossy\nColor: arctic white', notes: 'Backsplash field tile.', itemIds: ['it-k-tile'],
      },
      {
        id: 'prod-oak', name: 'Select white oak plank, 5 in', brand: '', model: '',
        category: 'flooring', url: '', price: 6.85, unit: 'sf', imageUrl: '',
        specs: 'Species: white oak\nWidth: 5 in\nGrade: select\nFinish: site-finished', notes: '', itemIds: ['it-bs-floor'],
      },
      {
        id: 'prod-hp', name: 'Hyper-heat multi-zone heat pump', brand: 'Mitsubishi', model: 'MXZ-SM42NAMHZ',
        category: 'hvac', url: 'https://www.mitsubishicomfort.com/', price: 4850, unit: 'ea', imageUrl: '',
        specs: 'Capacity: 42k BTU\nZones: up to 5\nHeating at -13F: 100%', notes: 'Condenser only; line sets and heads by installer.', itemIds: ['it-h-equip'],
      },
      {
        id: 'prod-toilet', name: 'Highline comfort height toilet', brand: 'Kohler', model: 'K-78276',
        category: 'plumbing', url: 'https://www.kohler.com/', price: 329, unit: 'ea', imageUrl: '',
        specs: 'Flush: 1.28 gpf\nHeight: comfort\nBowl: elongated', notes: '', itemIds: ['it-b-fix'],
      },
    ],
    projects: [
      {
        id: 'proj-kitchen', name: 'Kitchen remodel', propertyId: 'prop-demo', category: 'kitchen',
        status: 'committed', selected: true, startDate: '',
        notes: 'Full gut to the studs. Layout keeps plumbing wall; range moves to the north wall.',
        items: [
          { id: 'it-k-demo', name: 'Demo and disposal', qty: 1, unit: 'ls', low: 2500, likely: 3500, high: 5000, durationDays: 3, deps: [], elementIds: [], notes: '' },
          { id: 'it-k-rough', name: 'Rough plumbing and electrical', qty: 1, unit: 'ls', low: 6000, likely: 8000, high: 11000, durationDays: 5, deps: ['it-k-demo'], elementIds: [], notes: '' },
          { id: 'it-k-drywall', name: 'Drywall and patching', qty: 1, unit: 'ls', low: 1800, likely: 2500, high: 3500, durationDays: 3, deps: ['it-k-rough'], elementIds: [], notes: '' },
          { id: 'it-k-cab', name: 'Cabinet install', qty: 1, unit: 'ls', low: 14000, likely: 18500, high: 24000, durationDays: 4, deps: ['it-k-drywall'], elementIds: ['w-ext-n'], notes: 'Perimeter plus 8 ft island.' },
          { id: 'it-k-counter', name: 'Countertops, template and install', qty: 1, unit: 'ls', low: 4500, likely: 6000, high: 8500, durationDays: 2, deps: ['it-k-cab'], elementIds: [], notes: '' },
          { id: 'it-k-tile', name: 'Backsplash tile', qty: 1, unit: 'ls', low: 1200, likely: 1800, high: 2600, durationDays: 2, deps: ['it-k-counter'], elementIds: [], notes: '' },
          { id: 'it-k-floor', name: 'Tile flooring', qty: 210, unit: 'sf', low: 12, likely: 16, high: 22, durationDays: 3, deps: ['it-k-drywall'], elementIds: ['r-kitchen'], notes: '' },
          { id: 'it-k-appl', name: 'Appliances', qty: 1, unit: 'ls', low: 6500, likely: 8200, high: 10500, durationDays: 1, deps: ['it-k-counter'], elementIds: [], notes: '' },
          { id: 'it-k-finish', name: 'Finish plumbing, electrical, paint', qty: 1, unit: 'ls', low: 3000, likely: 4200, high: 6000, durationDays: 3, deps: ['it-k-tile', 'it-k-appl', 'it-k-floor'], elementIds: [], notes: '' },
        ],
      },
      {
        id: 'proj-bath', name: 'Primary bath refresh', propertyId: 'prop-demo', category: 'bath',
        status: 'scoped', selected: true, startDate: '',
        notes: 'Keep footprint. New tile shower, vanity, fixtures, glass.',
        items: [
          { id: 'it-b-demo', name: 'Demo', qty: 1, unit: 'ls', low: 1200, likely: 1800, high: 2500, durationDays: 2, deps: [], elementIds: [], notes: '' },
          { id: 'it-b-shower', name: 'Tile shower rebuild', qty: 1, unit: 'ls', low: 6500, likely: 8500, high: 12000, durationDays: 5, deps: ['it-b-demo'], elementIds: [], notes: '' },
          { id: 'it-b-van', name: 'Vanity and tops', qty: 1, unit: 'ls', low: 2800, likely: 3600, high: 5000, durationDays: 1, deps: ['it-b-shower'], elementIds: [], notes: '' },
          { id: 'it-b-fix', name: 'Fixtures and glass', qty: 1, unit: 'ls', low: 2400, likely: 3200, high: 4500, durationDays: 2, deps: ['it-b-van'], elementIds: [], notes: '' },
        ],
      },
      {
        id: 'proj-hp', name: 'Whole-home heat pump', propertyId: 'prop-demo', category: 'systems',
        status: 'scoped', selected: true, startDate: '',
        notes: 'Replace oil boiler with cold-climate heat pump; verify panel capacity.',
        items: [
          { id: 'it-h-load', name: 'Load calc and system design', qty: 1, unit: 'ls', low: 500, likely: 800, high: 1200, durationDays: 2, deps: [], elementIds: [], notes: 'Manual J.' },
          { id: 'it-h-equip', name: 'Equipment and install', qty: 1, unit: 'ls', low: 16000, likely: 19500, high: 24000, durationDays: 5, deps: ['it-h-load'], elementIds: [], notes: '' },
          { id: 'it-h-elec', name: 'Panel and circuit upgrades', qty: 1, unit: 'ls', low: 2000, likely: 3000, high: 4500, durationDays: 2, deps: ['it-h-load'], elementIds: [], notes: '' },
        ],
      },
      {
        id: 'proj-roof', name: 'Roof replacement', propertyId: 'prop-demo', category: 'exterior',
        status: 'scoped', selected: true, startDate: '',
        notes: 'Tear-off, architectural shingles, new gutters.',
        items: [
          { id: 'it-r-roof', name: 'Tear-off and shingles', qty: 1, unit: 'ls', low: 12000, likely: 14500, high: 18000, durationDays: 3, deps: [], elementIds: [], notes: '' },
          { id: 'it-r-gutter', name: 'Gutters and downspouts', qty: 1, unit: 'ls', low: 1800, likely: 2400, high: 3200, durationDays: 1, deps: ['it-r-roof'], elementIds: [], notes: '' },
        ],
      },
      {
        id: 'proj-deck', name: 'Deck rebuild', propertyId: 'prop-demo', category: 'exterior',
        status: 'idea', selected: false, startDate: '',
        notes: 'Parked until the kitchen lands. Composite decking, cable rail.',
        items: [
          { id: 'it-d-frame', name: 'Framing and footings', qty: 1, unit: 'ls', low: 6000, likely: 8000, high: 11000, durationDays: 5, deps: [], elementIds: [], notes: '' },
          { id: 'it-d-deck', name: 'Composite decking', qty: 320, unit: 'sf', low: 18, likely: 24, high: 32, durationDays: 3, deps: ['it-d-frame'], elementIds: [], notes: '' },
          { id: 'it-d-rail', name: 'Railing and stairs', qty: 1, unit: 'ls', low: 3000, likely: 4200, high: 6000, durationDays: 2, deps: ['it-d-deck'], elementIds: [], notes: '' },
        ],
      },
      {
        id: 'proj-base', name: 'Basement finish', propertyId: 'prop-demo', category: 'interior',
        status: 'idea', selected: false, startDate: '',
        notes: 'Media room plus half bath. Idea stage; verify ceiling height and egress.',
        items: [
          { id: 'it-bs-frame', name: 'Framing and insulation', qty: 1, unit: 'ls', low: 8000, likely: 11000, high: 15000, durationDays: 8, deps: [], elementIds: [], notes: '' },
          { id: 'it-bs-elec', name: 'Electrical', qty: 1, unit: 'ls', low: 4000, likely: 5500, high: 8000, durationDays: 4, deps: ['it-bs-frame'], elementIds: [], notes: '' },
          { id: 'it-bs-bath', name: 'Half bath rough-in', qty: 1, unit: 'ls', low: 5000, likely: 7500, high: 10000, durationDays: 4, deps: ['it-bs-frame'], elementIds: [], notes: '' },
          { id: 'it-bs-dry', name: 'Drywall and paint', qty: 1, unit: 'ls', low: 6000, likely: 8000, high: 11000, durationDays: 6, deps: ['it-bs-elec', 'it-bs-bath'], elementIds: [], notes: '' },
          { id: 'it-bs-floor', name: 'Flooring', qty: 650, unit: 'sf', low: 5, likely: 7, high: 9, durationDays: 3, deps: ['it-bs-dry'], elementIds: [], notes: '' },
        ],
      },
    ],
  };
}
