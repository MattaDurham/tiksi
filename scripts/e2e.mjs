// Every E2E gets unoccupied ports; live 8642 is never used or stopped.
//
//   node scripts/e2e.mjs              every browser suite, one after another
//   node scripts/e2e.mjs --group 2/4  only the second of four groups (CI runs the groups side by side)
//   node scripts/e2e.mjs --list 2/4   print which suites a group holds, run nothing
//   node scripts/e2e.mjs --webkit     the phone suites on Safari's engine (WebKit)
//
// A suite that fails gets one more try on fresh ports. A failure on the second try fails the
// run, but every other suite in the group still runs, and the end of the log names every
// suite that failed. A suite that passes on its second try is named in a warning, on the CI
// run page too, so a flaky suite stays visible. A suite that runs past SUITE_LIMIT_MS is
// stopped and counts as a failed try. Each run writes what happened to every suite to
// test-results/e2e-<group>.json, which CI keeps with the run.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { groupSuites, parseGroup, WEBKIT_SUITES } from './e2e-groups.mjs';

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

async function runSuite(file, extraEnv = {}) {
  const tries = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const env = { ...process.env, ...extraEnv, E2E_APP_PORT: String(await freePort()), E2E_MOCK_PORT: String(await freePort()) };
    const label = attempt === 1 ? '' : ' (second try)';
    console.log(`Running tools/${file}${label} on temporary ports ${env.E2E_APP_PORT}/${env.E2E_MOCK_PORT}`);
    const started = Date.now();
    const code = await runTool(`tools/${file}`, env, SUITE_LIMIT_MS);
    const seconds = Math.round((Date.now() - started) / 1000);
    tries.push({ code, seconds });
    if (code === 0) return { file, attempts: attempt, seconds, tries };
    console.log(`tools/${file} failed on try ${attempt} after ${seconds}s (exit ${code}).`);
  }
  return { file, attempts: 2, failed: true, tries };
}

const args = process.argv.slice(2);
const flag = args[0];
if (flag && !['--group', '--list', '--webkit'].includes(flag)) { console.error(`Unknown argument ${flag}`); process.exit(1); }
if (flag === '--webkit' && args.length > 1) { console.error(`Unknown argument ${args[1]}`); process.exit(1); }
const webkit = flag === '--webkit';
const { index, count } = flag && !webkit ? parseGroup(args[1]) : { index: 1, count: 1 };
const suites = (await readdir('tools')).filter(name => /^e2e-.*\.mjs$/.test(name));
const durations = JSON.parse(await readFile(new URL('./e2e-durations.json', import.meta.url), 'utf8'));
const group = webkit ? { files: WEBKIT_SUITES.filter(f => suites.includes(f)), seconds: 0 } : groupSuites(suites, durations, count)[index - 1];
if (flag === '--list') {
  console.log(`Group ${index} of ${count}, about ${Math.round(group.seconds / 60)} minutes:`);
  for (const file of group.files) console.log(`  ${file}`);
  process.exit(0);
}
if (count > 1) console.log(`Browser group ${index} of ${count}: ${group.files.length} of ${suites.length} suites.`);
if (webkit) console.log(`Safari's engine (WebKit): ${group.files.join(', ')}`);

const fixtureCode = await runTool('tools/fixture-room.mjs');
if (fixtureCode !== 0) process.exit(fixtureCode || 1);
const results = [];
for (const file of group.files) results.push(await runSuite(file, webkit ? { E2E_BROWSER: 'webkit' } : {}));
const flaky = results.filter(r => !r.failed && r.attempts > 1);
const failed = results.filter(r => r.failed);
const name = webkit ? 'webkit' : count > 1 ? `group-${index}-of-${count}` : 'all';
try {
  await mkdir('test-results', { recursive: true });
  await writeFile(`test-results/e2e-${name}.json`, JSON.stringify({ group: name, suites: results }, null, 2) + '\n');
} catch (error) { console.log(`Could not write test-results/e2e-${name}.json: ${error.message}`); }
for (const r of flaky) {
  const text = `tools/${r.file} failed once and passed on its second try`;
  console.log(onCI ? `::warning title=Flaky browser suite::${text}` : `Warning: ${text}`);
}
for (const r of failed) {
  const text = `tools/${r.file} failed twice`;
  console.log(onCI ? `::error title=Browser suite failed::${text}` : text);
}
if (failed.length) {
  console.log(`Browser suites failed: ${failed.length} of ${results.length} (${failed.map(r => r.file).join(', ')}).`);
  process.exit(1);
}
console.log(`Browser suites passed: ${results.length}${flaky.length ? `, ${flaky.length} on a second try` : ''}.`);
