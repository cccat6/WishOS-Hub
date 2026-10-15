import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store } from './store.js';
import { Hub } from './hub.js';
import { MockAdapter } from './adapters/mock.js';
import { CodexAdapter } from './adapters/codex.js';
import { codexThreadOptions } from './adapters/codex-options.js';
import { desktopToolsBridge, useDesktopRuntime } from './adapters/desktop-tools.js';
import { DeepSeekAdapter } from './adapters/deepseek.js';
import { RpcProcess } from './adapters/rpc.js';
import { SpeechConfig } from './speech.js';
import { Id } from './protocol.js';

const secret = (name: string) => {
  const s = process.env[name];
  if (s && (s.length > 96 || /[\r\n]/.test(s))) throw new Error(`Invalid token in ${name}`);
  return s ?? '';
};
const Runtime = z
  .object({
    kind: z.enum(['mock', 'codex', 'deepseek']),
    sessionId: z.string().min(1).max(256).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    initialize: z.record(z.unknown()).optional(),
    threadOptions: z.record(z.unknown()).optional(),
    desktopTools: z
      .union([
        z.boolean(),
        z
          .object({
            enabled: z.boolean().optional(),
            resourcesPath: z.string().optional(),
            pipePath: z.string().optional(),
          })
          .strict(),
      ])
      .optional(),
    nativeSpeech: z
      .object({
        appVersion: z.string().regex(/^[0-9.]+$/),
        language: z.string().max(32).optional(),
        acceptLanguage: z.string().max(64).optional(),
        proxyUrl: z.string().url().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const Config = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(8787),
    database: z.string().default('./data/hub.sqlite'),
    artifacts: z
      .object({
        root: z.string().default('./data/wishos-assets'),
        maxFileBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(536870912),
      })
      .default({}),
    adminTokenEnv: z.string().default('NOTES_ADMIN_TOKEN'),
    discoverDevices: z.boolean().default(false),
    discoveryTokenEnv: z.string().default('NOTES_DEVICE_TOKEN'),
    allowPowerCommands: z.boolean().optional(),
    devices: z
      .array(
        z
          .object({
            id: Id,
            tokenEnv: z.string().default('NOTES_DEVICE_TOKEN'),
            connection: z.enum(['active', 'passive']).default('active'),
            protocol: z.enum(['wishos', 'notes']).default('wishos'),
            deviceUrl: z.string().url().optional(),
            harness: Runtime.default({ kind: 'mock' }),
            triggers: z
              .record(
                z.enum(['boot', 'timer', 'act.click', 'power.press', 'imu']),
                z.string().min(1).max(8000),
              )
              .optional(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    audioLimits: z
      .object({
        compressed_bytes: z.number().int().positive(),
        decoded_bytes: z.number().int().positive(),
        streams_per_device: z.number().int().positive(),
        idle_ms: z.number().int().positive(),
        total_bytes: z.number().int().positive(),
        failed_ttl_ms: z.number().int().positive(),
      })
      .partial()
      .strict()
      .optional(),
    speech: SpeechConfig.optional(),
    asr: z.object({ url: z.string().url(), tokenEnv: z.string().optional() }).strict().optional(),
  })
  .strict();
const c = Config.parse(
  JSON.parse(readFileSync(process.env.NOTES_CONFIG ?? 'config.local.json', 'utf8')),
);
const desktopBridges = c.devices.map((d) =>
  d.harness.kind === 'codex' ? desktopToolsBridge(d.harness.desktopTools) : null,
);
useDesktopRuntime(desktopBridges.find((v) => v !== null) ?? null);
const database = resolve(c.database);
mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
const store = new Store(database);
chmodSync(database, 0o600);
const devices = c.devices.map((d, index) => {
  const h = d.harness;
  let adapter;
  if (h.kind === 'mock') adapter = new MockAdapter();
  else {
    if (!h.command || !h.cwd)
      throw new Error('Real harnesses require explicit executable and workspace cwd');
    const rpc = new RpcProcess(
      h.command,
      h.args ?? (h.kind === 'codex' ? ['app-server'] : ['--profile', 'sdk']),
      resolve(h.cwd),
      h.kind === 'deepseek',
    );
    if (h.kind === 'deepseek' && (!h.initialize?.provider || !h.initialize?.model))
      throw new Error('DeepSeek requires explicit initialize.provider and initialize.model');
    adapter =
      h.kind === 'codex'
        ? new CodexAdapter(
            rpc,
            600000,
            codexThreadOptions(
              resolve(h.cwd),
              `http://127.0.0.1:${c.port}/mcp`,
              c.adminTokenEnv,
              readFileSync(
                fileURLToPath(new URL('../skills/agentic-notes/SKILL.md', import.meta.url)),
                'utf8',
              ),
              h.threadOptions,
              desktopBridges[index]?.server,
              desktopBridges[index]?.additionalServers,
            ),
            h.nativeSpeech,
          )
        : new DeepSeekAdapter(rpc, { ...h.initialize, cwd: resolve(h.cwd) });
  }
  if (d.connection === 'passive' && !d.deviceUrl) throw Error('Passive devices require deviceUrl');
  if (d.deviceUrl) {
    const url = new URL(d.deviceUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !['', '/'].includes(url.pathname) ||
      url.search ||
      url.hash
    )
      throw Error('deviceUrl must be an HTTP(S) origin');
  }
  return {
    ...(d.deviceUrl ? { deviceUrl: d.deviceUrl } : {}),
    id: d.id,
    protocol: d.protocol,
    sessionId: h.sessionId,
    token: process.env[d.tokenEnv] ?? '',
    adapter,
    triggers: d.triggers,
  };
});
const hub = new Hub({
  devices,
  store,
  audioLimits: c.audioLimits,
  artifactRoot: c.artifacts.root,
  artifactMaxBytes: c.artifacts.maxFileBytes,
  allowPowerCommands:
    process.env.NOTES_DISABLE_POWER_COMMANDS === '1' ? false : (c.allowPowerCommands ?? true),
  discoveryToken: c.discoverDevices ? secret(c.discoveryTokenEnv) : undefined,
  adminToken: secret(c.adminTokenEnv),
  speech:
    c.speech ??
    (c.asr
      ? {
          source: 'third-party',
          thirdParty: {
            protocol: 'wav-json',
            url: c.asr.url,
            token: c.asr.tokenEnv ? secret(c.asr.tokenEnv) : '',
          },
        }
      : undefined),
});
await hub.listen(c.port, c.host);
console.log(`Agentic Notes Hub listening on ${c.host}:${c.port}; ${devices.length} device(s)`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void hub.close().finally(() => {
      store.close();
      process.exit(0);
    });
  });
