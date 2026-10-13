import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { resolve, join } from 'node:path';
const noBrowser = process.argv.includes('--no-browser');
const args = process.argv.slice(2).filter((arg) => arg !== '--no-browser');
if (args.includes('--help')) {
  console.log(
    'Agentic Notes\nUsage: node dist/launch.js [--data-dir PATH] [--host ADDRESS] [--port NUMBER] [--no-browser]\nCreates configuration once, preserves it on later starts. Model services are not called by default.',
  );
  process.exit(0);
}
const allowed = new Set(['--data-dir', '--host', '--port']);
const options: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  if (!allowed.has(args[i]!) || !args[i + 1])
    throw Error('Unknown option or missing value; use --help');
  options[args[i]!.slice(2)] = args[i + 1]!;
}
const dataRoot = resolve(options['data-dir'] ?? join(homedir(), '.agentic-notes'));
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
const config = process.env.NOTES_CONFIG ?? join(dataRoot, 'config.json');
if (!existsSync(config)) {
  const port = Number(options.port ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid port');
  writeFileSync(
    config,
    JSON.stringify(
      {
        host: options.host ?? '0.0.0.0',
        port,
        database: join(dataRoot, 'notes.sqlite'),
        discoverDevices: true,
        allowPowerCommands: false,
        devices: [],
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
} else if (options.host || options.port)
  throw Error(
    'Existing configuration preserved; edit host/port in its config file, or use a new --data-dir',
  );
process.env.NOTES_CONFIG = config;
console.log(`Configuration: ${config}`);
for (const addresses of Object.values(networkInterfaces()))
  for (const a of addresses ?? [])
    if (a.family === 'IPv4' && !a.internal) console.log(`LAN address: ${a.address}`);
await import('./main.js');

const settings = JSON.parse(readFileSync(config, 'utf8'));
const url = `http://127.0.0.1:${settings.port}/`;
console.log(`Control page: ${url}`);
if (!noBrowser) {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer.exe'
        : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log('Open the control-page address in your browser.'));
  child.unref();
}
