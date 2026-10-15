#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, open, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, ConnectorConfig, defaultDataRoot } from './config.js';
import { ConnectorServer } from './server.js';
import { createWishosMcp } from '../wishos-mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { hubApi } from '../hub-api.js';
import { clientConfigurations } from './mcp-config.js';
const entry = fileURLToPath(import.meta.url);
const help = `WishOS Hub\nUsage: wishos-hub [setup|serve|status|export] [--data-dir PATH] [--host ADDRESS] [--port NUMBER] [--no-browser]\n       wishos-hub --stdio [--data-dir PATH]\n\nsetup opens a local browser wizard. stdio starts/reuses the local connector for an MCP client.\nSessions and model credentials remain in your chosen runtime. Docker is not required.`;
function parse(args: string[]) {
  let command = 'setup';
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i]!;
    if (['setup', 'serve', 'status', 'export'].includes(arg)) {
      command = arg;
      continue;
    }
    if (['--help', '--no-browser', '--stdio'].includes(arg)) {
      options[arg.slice(2)] = true;
      continue;
    }
    if (!['--data-dir', '--host', '--port', '--client'].includes(arg) || !args[i + 1])
      throw Error('Invalid option. Use --help.');
    options[arg.slice(2)] = args[++i]!;
  }
  return { command, options };
}
async function running(root: string) {
  try {
    const info = JSON.parse(await readFile(join(root, 'running.json'), 'utf8'));
    const r = await fetch('http://127.0.0.1:' + info.port + '/healthz', {
      signal: AbortSignal.timeout(1500),
    });
    const state = await r.json();
    return state.ok && state.id === info.id ? info : undefined;
  } catch {
    return undefined;
  }
}
async function startBackground(root: string) {
  const existing = await running(root);
  if (existing) return existing;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const log = await open(join(root, 'connector.log'), 'a', 0o600);
  const child = spawn(process.execPath, [entry, 'serve', '--data-dir', root, '--no-browser'], {
    stdio: ['ignore', log.fd, log.fd],
    detached: true,
    shell: false,
  });
  child.unref();
  await log.close();
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const info = await running(root);
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Connector did not become available. Run wishos-hub serve for startup details.');
}
async function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (options.help) {
    console.log(help);
    return;
  }
  const root = resolve(
      typeof options['data-dir'] === 'string' ? options['data-dir'] : defaultDataRoot(),
    ),
    settings = new ConfigStore(root);
  if (command === 'status') {
    const info = await running(root);
    console.log(
      JSON.stringify(
        info
          ? { running: true, id: info.id, url: 'http://127.0.0.1:' + info.port }
          : { running: false },
      ),
    );
    return;
  }
  if (command === 'export') {
    const config = ConnectorConfig.parse(JSON.parse(await readFile(settings.path, 'utf8')));
    const configs = clientConfigurations(config, entry, root),
      client = String(options.client ?? 'cursor');
    console.log(
      JSON.stringify(
        client === 'remote' ? configs.remote : (configs.local as Record<string, unknown>)[client],
        null,
        2,
      ),
    );
    return;
  }
  if (options.stdio) {
    const info = await startBackground(root),
      config = await settings.load();
    await createWishosMcp(hubApi('http://127.0.0.1:' + info.port, config.localToken)).connect(
      new StdioServerTransport(),
    );
    return;
  }
  const existing = await running(root);
  if (existing) {
    if (options.host || options.port)
      throw Error('Connector is running; stop it before changing host or port.');
    const url = 'http://127.0.0.1:' + existing.port;
    console.log('WishOS: ' + url);
    if (command === 'setup' && !options['no-browser']) openBrowser(url);
    return;
  }
  const config = await settings.load();
  if (typeof options.host === 'string' || typeof options.port === 'string')
    await settings.save({
      ...config,
      ...(options.host ? { host: options.host } : {}),
      ...(options.port ? { port: Number(options.port) } : {}),
    });
  const server = new ConnectorServer(settings, { entry });
  let started;
  try {
    started = await server.start();
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
  console.log('WishOS: ' + started.url);
  if (command === 'setup' && !options['no-browser']) openBrowser(started.url);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
function openBrowser(url: string) {
  const child = spawn(
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer.exe'
        : 'xdg-open',
    [url],
    { stdio: 'ignore', detached: true, shell: false },
  );
  child.on('error', () => {});
  child.unref();
}
if (process.argv[1] && resolve(process.argv[1]) === entry)
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'WishOS startup failed');
    process.exitCode = 1;
  });
