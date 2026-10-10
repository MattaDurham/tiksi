// Every E2E gets unoccupied ports; live 8642 is never used or stopped.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import net from 'node:net';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function runTool(file, env = process.env) {
  const child = spawn(process.execPath, [file], { env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) process.exit(code || 1);
}
await runTool('tools/fixture-room.mjs');
for (const file of (await readdir('tools')).filter(name => /^e2e-.*\.mjs$/.test(name)).sort()) {
  const env = { ...process.env, E2E_APP_PORT: String(await freePort()), E2E_MOCK_PORT: String(await freePort()) };
  console.log(`Running tools/${file} on temporary ports ${env.E2E_APP_PORT}/${env.E2E_MOCK_PORT}`);
  await runTool(`tools/${file}`, env);
}
