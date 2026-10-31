import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solarPosition, localInstant, environmentSun, daysInYear, dayOfYear, dateForDay, validTimeZone } from '../js/solar.js';

test('solar angles match the NREL SPA reference example within the NOAA approximation', () => {
  const p = solarPosition({ latitude: 39.742476, longitude: -105.1786, date: '2003-10-17', time: 12.508333, timeZone: 'Etc/GMT+7' });
  assert.ok(Math.abs(p.elevation - 39.8884) < 0.6, JSON.stringify(p));
  assert.ok(Math.abs(p.azimuth - 194.3402) < 0.6, JSON.stringify(p));
});
test('location, season and time move the sun, including polar night', () => {
  const env = { latitude: 40, longitude: -75, date: '2024-06-21', time: 12, timeZone: 'Etc/GMT+5', sunMode: 'location' };
  const summer = environmentSun(env);
  const winter = environmentSun({ ...env, date: '2024-12-21' });
  assert.ok(summer.elevation > 70 && winter.elevation < 28);
  assert.ok(environmentSun({ ...env, time: 8 }).azimuth < 180);
  assert.ok(environmentSun({ ...env, time: 16 }).azimuth > 180);
  assert.ok(environmentSun({ ...env, latitude: 80, date: '2024-12-21' }).elevation < 0);
  assert.ok(environmentSun({ ...env, latitude: -40, date: '2024-12-21' }).elevation > 70);
  assert.throws(() => environmentSun({ ...env, latitude: null }), /latitude/);
});
test('the selected date supplies DST and zones with fractional offsets work', () => {
  assert.equal(localInstant('2024-07-01', 12, 'America/New_York').toISOString(), '2024-07-01T16:00:00.000Z');
  assert.equal(localInstant('2024-01-01', 12, 'America/New_York').toISOString(), '2024-01-01T17:00:00.000Z');
  assert.equal(localInstant('2024-07-01', 12, 'Asia/Kathmandu').toISOString(), '2024-07-01T06:15:00.000Z');
  assert.throws(() => localInstant('2024-03-10', 2.5, 'America/New_York'), /clocks change/);
  assert.equal(validTimeZone('Made/Up'), false);
  assert.throws(() => localInstant('2024-02-30', 12, 'UTC'), /valid date/);
  assert.throws(() => localInstant('2024-01-01', NaN, 'UTC'), /Choose a time/);
});
test('calendar slider includes leap day and rolls through the entire year', () => {
  assert.equal(daysInYear(2024), 366); assert.equal(daysInYear(2026), 365);
  assert.equal(dayOfYear('2024-02-29'), 60); assert.equal(dateForDay(2024, 60), '2024-02-29');
  assert.equal(dateForDay(2024, 366), '2024-12-31');
  assert.deepEqual(environmentSun({ time: 12, azimuth: 200 }), { elevation: 65, azimuth: 200 });
});
