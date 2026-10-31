// NOAA's fractional-year solar equations (geometric sun, without atmospheric refraction).
// https://gml.noaa.gov/grad/solcalc/solareqns.PDF
const rad = Math.PI / 180;
const wrap = (n, m) => ((n % m) + m) % m;
export function daysInYear(year) { return new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1 ? 366 : 365; }
export function dayOfYear(date) {
  const d = new Date(date + 'T00:00:00Z');
  return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
}
export function dateForDay(year, day) { return new Date(Date.UTC(year, 0, day)).toISOString().slice(0, 10); }
export function validTimeZone(zone) {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true; } catch { return false; }
}
// Convert local wall-clock hours using the offset on the selected date, including DST.
// Iterate because the initial UTC guess can be on the other side of a DST boundary.
export function localInstant(date, time, timeZone) {
  const midnight = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(+midnight) || midnight.toISOString().slice(0, 10) !== date) throw new Error('Choose a valid date.');
  if (!Number.isFinite(time) || time < 0 || time > 24) throw new Error('Choose a time between 00:00 and 24:00.');
  const target = +midnight + time * 3600000;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const delta = target - shown;
    if (Math.abs(delta) < 1000) return new Date(instant);
    instant += delta;
  }
  throw new Error('This local time does not exist because the clocks change. Choose another time.');
}
export function solarPosition({ latitude, longitude, date, time, timeZone }) {
  const instant = localInstant(date, time, timeZone);
  const year = instant.getUTCFullYear();
  const hour = instant.getUTCHours() + instant.getUTCMinutes() / 60;
  const day = Math.floor((instant - Date.UTC(year, 0, 1)) / 86400000) + 1;
  const g = 2 * Math.PI / daysInYear(year) * (day - 1 + (hour - 12) / 24);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = (wrap(hour * 60 + eq + 4 * longitude, 1440) / 4 - 180) * rad;
  const lat = latitude * rad;
  const up = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const east = -Math.cos(decl) * Math.sin(ha);
  const north = Math.cos(lat) * Math.sin(decl) - Math.sin(lat) * Math.cos(decl) * Math.cos(ha);
  return { elevation: Math.asin(Math.max(-1, Math.min(1, up))) / rad, azimuth: wrap(Math.atan2(east, north) / rad, 360) };
}
export function environmentSun(env) {
  if (env.sunMode === 'location') {
    if (!Number.isFinite(env.latitude) || Math.abs(env.latitude) > 90 || !Number.isFinite(env.longitude) || Math.abs(env.longitude) > 180) throw new Error('Enter the site latitude and longitude.');
    return solarPosition(env);
  }
  const t = env.time;
  const elevation = t < 6 ? Math.max(-18, -(6 - t) * 6) : t > 20 ? Math.max(-18, -(t - 20) * 6) : t < 12 ? 65 * Math.sin(Math.PI / 2 * (t - 6) / 6) : 65 * Math.sin(Math.PI / 2 * (20 - t) / 8);
  return { elevation, azimuth: env.azimuth };
}
