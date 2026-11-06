// Every E2E gets unoccupied ports; live 8642 is never used or stopped.
//
//   node scripts/e2e.mjs              every browser suite, one after another
//   node scripts/e2e.mjs --group 2/4  only the second of four groups (CI runs the groups side by side)
//   node scripts/e2e.mjs --list 2/4   print which suites a group holds, run nothing
//
// A suite that fails gets one more try on fresh ports. A failure on the second try fails the
// run. A suite that passes on its second try is named in a warning, on the CI run page too,
// so a flaky suite stays visible. A suite that runs past SUITE_LIMIT_MS is stopped
// and counts as a failed try.
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import { groupSuites, parseGroup } from './e2e-groups.mjs';

const SUITE_LIMIT_MS = Number(process.env.E2E_SUITE_LIMIT_MS) || 12 * 60 * 1000;
const onCI = process.env.GITHUB_ACTIONS === 'true';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const running = new Set();
function stopAll(signal) {
  for (const child of running) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));

// Runs one tool in its own process group, so a stopped suite takes its browser and servers with it.
async function runTool(file, env = process.env, limitMs = 0) {
  const child = spawn(process.execPath, [file], { env, stdio: 'inherit', detached: process.platform !== 'win32' });
  running.add(child);
  let timedOut = false;
  const timer = limitMs ? setTimeout(() => {
    timedOut = true;
    const limit = limitMs >= 60000 ? `${Math.round(limitMs / 60000)} minutes` : `${Math.round(limitMs / 1000)} seconds`;
    console.log(`${file} ran past ${limit}; stopping it.`);
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {}
  }, limitMs) : null;
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (c, s) => resolve(c ?? (s ? 1 : 0))); });
  if (timer) clearTimeout(timer);
  running.delete(child);
  return timedOut ? 1 : code;
}

async function runSuite(file) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const env = { ...process.env, E2E_APP_PORT: String(await freePort()), E2E_MOCK_PORT: String(await freePort()) };
    const label = attempt === 1 ? '' : ' (second try)';
    console.log(`Running tools/${file}${label} on temporary ports ${env.E2E_APP_PORT}/${env.E2E_MOCK_PORT}`);
    const started = Date.now();
    const code = await runTool(`tools/${file}`, env, SUITE_LIMIT_MS);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (code === 0) return { file, attempts: attempt, seconds };
    console.log(`tools/${file} failed on try ${attempt} after ${seconds}s (exit ${code}).`);
  }
  return { file, attempts: 2, failed: true };
}

const args = process.argv.slice(2);
const flag = args[0];
if (flag && !['--group', '--list'].includes(flag)) { console.error(`Unknown argument ${flag}`); process.exit(1); }
const { index, count } = flag ? parseGroup(args[1]) : { index: 1, count: 1 };
const suites = (await readdir('tools')).filter(name => /^e2e-.*\.mjs$/.test(name));
const durations = JSON.parse(await readFile(new URL('./e2e-durations.json', import.meta.url), 'utf8'));
const group = groupSuites(suites, durations, count)[index - 1];
if (flag === '--list') {
  console.log(`Group ${index} of ${count}, about ${Math.round(group.seconds / 60)} minutes:`);
  for (const file of group.files) console.log(`  ${file}`);
  process.exit(0);
}
if (count > 1) console.log(`Browser group ${index} of ${count}: ${group.files.length} of ${suites.length} suites.`);

const fixtureCode = await runTool('tools/fixture-room.mjs');
if (fixtureCode !== 0) process.exit(fixtureCode || 1);
const results = [];
for (const file of group.files) {
  const result = await runSuite(file);
  results.push(result);
  if (result.failed) break;
}
const flaky = results.filter(r => !r.failed && r.attempts > 1);
for (const r of flaky) {
  const text = `tools/${r.file} failed once and passed on its second try`;
  console.log(onCI ? `::warning title=Flaky browser suite::${text}` : `Warning: ${text}`);
}
const failed = results.find(r => r.failed);
if (failed) {
  const text = `tools/${failed.file} failed twice`;
  console.log(onCI ? `::error title=Browser suite failed::${text}` : text);
  process.exit(1);
}
console.log(`Browser suites passed: ${results.length}${flaky.length ? `, ${flaky.length} on a second try` : ''}.`);
