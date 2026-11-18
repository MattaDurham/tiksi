// Translate the private trim package's purchasing and production inputs for Bid Studio.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const [build, template, destination, ...extra] = process.argv.slice(2);
if (!build || !template || !destination || extra.length)
  throw new Error('Usage: node tools/bid-profile.mjs <package build> <template> <new private output.json>');
const read = async (base, path) => JSON.parse(await readFile(resolve(base, path), 'utf8'));
const [config, stock, labor, supplies, pieces] = await Promise.all([
  read(build, 'config.json'),
  read(template, 'data/stock.json'),
  read(template, 'data/labor.json'),
  read(template, 'data/supplies.json'),
  read(build, 'work/pieces.json'),
]);
const rooms = config.rooms.map(({ name, subproject }) => ({ name, subproject }));
// Only external stair geometry travels. Ordinary wall sections are always read from the current design.
const supplement = pieces
  .filter((p) => p.style === 'stair')
  .map((p) => ({
    ...p,
    roomKey: rooms.find((r) => r.name === p.room)?.subproject || p.room,
    wallName: p.sectionName,
    source: 'External stair layout',
  }));
const profile = {
  format: 'tiksi-bid-profile/1',
  propertyId: config.property,
  name: config.title + ' · ' + config.date,
  rooms,
  supplement,
  stock: { ...stock.products, ...config.stock },
  prices: Object.fromEntries(Object.entries(config.price_overrides || {}).map(([id, r]) => [id, r.price])),
  tasks: labor.tasks,
  supplies: supplies.items,
  nailing: supplies.nailing,
  settings: {
    rate: config.labor_rate,
    contingency: config.contingency * 100,
    spare: config.spare_per_moulding,
  },
};
await writeFile(resolve(destination), JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Created a private Bid Studio profile.');
