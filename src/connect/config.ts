import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { LocalSpeechConfig } from './speech.js';

export const RuntimeKind = z.enum([
  'codex',
  'claude-code',
  'deepseek',
  'cursor',
  'workbuddy',
  'openclaw',
  'hermes',
]);
const Identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
const SecretReference = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export const RuntimeConfig = z
  .object({
    id: Identifier,
    kind: RuntimeKind,
    label: z.string().min(1).max(64),
    command: z.string().min(1).max(4096).optional(),
    args: z.array(z.string().max(4096)).max(32).optional(),
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine(isAbsolute, 'Absolute workspace path required')
      .optional(),
    endpoint: z.string().url().max(2048).optional(),
    authTokenEnv: SecretReference.optional(),
    approvalsReviewer: z.enum(['user', 'auto_review']).optional(),
    profile: z.string().max(128).optional(),
    home: z.string().max(4096).refine(isAbsolute, 'Absolute Harness home required').optional(),
    nativeSpeech: z
      .object({
        appVersion: z.string().regex(/^[0-9.]+$/),
        language: z.string().max(32).optional(),
        proxyUrl: z.string().url().optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(1000).max(3600000).default(900000),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.approvalsReviewer && r.kind !== 'codex')
      ctx.addIssue({
        code: 'custom',
        message: 'Approval reviewer settings belong to Codex',
        path: ['approvalsReviewer'],
      });
    if (r.nativeSpeech && r.kind !== 'codex')
      ctx.addIssue({
        code: 'custom',
        message: 'Native speech settings belong to Codex',
        path: ['nativeSpeech'],
      });
    if ((r.home || r.profile) && r.kind !== 'deepseek')
      ctx.addIssue({
        code: 'custom',
        message: 'Home/profile settings belong to DeepSeek Harness',
        path: ['profile'],
      });
    if (r.endpoint && ['codex', 'claude-code', 'cursor', 'deepseek'].includes(r.kind))
      ctx.addIssue({
        code: 'custom',
        message: 'This adapter uses the installed CLI transport',
        path: ['endpoint'],
      });

    if (['workbuddy', 'openclaw', 'hermes'].includes(r.kind) && !r.endpoint)
      ctx.addIssue({
        code: 'custom',
        message: 'This runtime requires its user-owned service endpoint',
        path: ['endpoint'],
      });
    if (r.endpoint && !['http:', 'https:'].includes(new URL(r.endpoint).protocol))
      ctx.addIssue({
        code: 'custom',
        message: 'HTTP service endpoint required',
        path: ['endpoint'],
      });
  });
export type RuntimeConfig = z.infer<typeof RuntimeConfig>;
export const DeviceBinding = z
  .object({
    id: Identifier,
    label: z.string().min(1).max(64),
    token: z.string().min(24).max(96),
    runtimeId: Identifier.optional(),
    sessionId: z.string().min(1).max(256).optional(),
  })
  .strict();
export type DeviceBinding = z.infer<typeof DeviceBinding>;
export const ConnectorConfig = z
  .object({
    format: z.literal('wishos-connector/1'),
    id: Identifier,
    cloudRoomId: z.string().uuid(),
    pairingSeed: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    host: z.string().default('0.0.0.0'),
    port: z.number().int().min(0).max(65535).default(18762),
    localToken: z.string().min(24).max(96),
    mdns: z.boolean().default(true),
    speech: LocalSpeechConfig.default({}),
    resources: z
      .object({
        maxFileBytes: z
          .number()
          .int()
          .positive()
          .default(512 * 1024 * 1024),
        maxStoredBytes: z
          .number()
          .int()
          .positive()
          .default(2 * 1024 * 1024 * 1024),
        ttlMs: z.number().int().min(1000).default(86400000),
      })
      .strict()
      .refine((v) => v.maxFileBytes <= v.maxStoredBytes, 'File limit exceeds total storage')
      .default({}),
    cloud: z
      .object({
        endpoint: z.string().url(),
        relayEndpoint: z.string().url().optional(),
        roomId: z.string().uuid(),
        ownerToken: z.string().min(24).max(128),
        connectorToken: z.string().min(24).max(128),
      })
      .strict()
      .optional(),
    runtimes: z.array(RuntimeConfig).max(32).default([]),
    devices: z.array(DeviceBinding).max(32).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const key of ['runtimes', 'devices'] as const)
      if (new Set(c[key].map((x) => x.id)).size !== c[key].length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate identity', path: [key] });
    if (c.devices.some((d) => d.runtimeId && !c.runtimes.some((r) => r.id === d.runtimeId)))
      ctx.addIssue({ code: 'custom', message: 'Unknown runtime binding', path: ['devices'] });
    if (c.cloud) {
      const u = new URL(c.cloud.endpoint);
      if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
        ctx.addIssue({
          code: 'custom',
          message: 'Cloud service requires HTTPS',
          path: ['cloud', 'endpoint'],
        });
    }
  });
export type ConnectorConfig = z.infer<typeof ConnectorConfig>;
export const token = () => randomBytes(32).toString('base64url');
export function defaultDataRoot() {
  return resolve(process.env.WISHOS_HOME ?? join(homedir(), '.wishos-hub'));
}
export class ConfigStore {
  private current?: ConnectorConfig;
  constructor(readonly root = defaultDataRoot()) {}
  get path() {
    return join(this.root, 'connector.json');
  }
  async load() {
    if (this.current) return this.current;
    try {
      this.current = ConnectorConfig.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const cloudRoomId = randomUUID();
      this.current = ConnectorConfig.parse({
        format: 'wishos-connector/1',
        id: 'whc_' + cloudRoomId,
        cloudRoomId,
        pairingSeed: token(),
        localToken: token(),
      });
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        await writeFile(this.path, JSON.stringify(this.current, null, 2) + '\n', {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        this.current = ConnectorConfig.parse(JSON.parse(await readFile(this.path, 'utf8')));
      }
    }
    return this.current;
  }
  async save(value: unknown) {
    const next = ConnectorConfig.parse(value); // validate everything before touching the live file
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
    this.current = next;
    return next;
  }
  public(value: ConnectorConfig) {
    return {
      ...value,
      localToken: undefined,
      pairingSeed: undefined,
      cloud: value.cloud
        ? { endpoint: value.cloud.endpoint, roomId: value.cloud.roomId }
        : undefined,
      devices: value.devices.map(({ token: _, ...d }) => d),
    };
  }
}

export function devicePairingToken(config: ConnectorConfig, id: string) {
  return (
    config.cloudRoomId +
    '.device.' +
    createHmac('sha256', config.pairingSeed)
      .update(id + ':1')
      .digest('base64url')
  );
}
