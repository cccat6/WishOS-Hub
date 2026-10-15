import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { join, resolve, posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DeviceRpc } from './os-remote.js';

export type Artifact = { id: string; size: number; sha256: string; path: string };
/** Host-only source retrieval. Device traffic contains native resources and
 * bounded control metadata, never an arbitrary origin URL or a whole book. */
export class ArtifactStore {
  private preparing = new Map<string, Promise<any>>();
  constructor(
    private db: DatabaseSync,
    readonly root: string,
    readonly maxBytes = 512 * 1024 * 1024,
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS os_managed_results(key TEXT PRIMARY KEY,result TEXT NOT NULL)',
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS os_artifacts(id TEXT PRIMARY KEY,path TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,created INTEGER NOT NULL)',
    );
  }
  async managedResult(key: string, prepare: () => Promise<any>) {
    const saved = this.db.prepare('SELECT result FROM os_managed_results WHERE key=?').get(key) as
      | { result: string }
      | undefined;
    if (saved) return JSON.parse(saved.result);
    const prior = this.db
      .prepare("SELECT result FROM os_managed_results WHERE substr(key,instr(key,':')+1)=?")
      .all(key.slice(key.indexOf(':') + 1)) as { result: string }[];
    if (prior.some((r) => JSON.parse(r.result).effects?.length))
      throw Error('system_effect_reconciliation_required');
    const existing = this.preparing.get(key);
    if (existing) return existing;
    const work = prepare().then((result) => {
      this.db
        .prepare('INSERT OR REPLACE INTO os_managed_results VALUES(?,?)')
        .run(key, JSON.stringify(result));
      return result;
    });
    this.preparing.set(key, work);
    try {
      return await work;
    } finally {
      this.preparing.delete(key);
    }
  }
  get(id: string): Artifact {
    const row = this.db
      .prepare('SELECT id,path,size,sha256 FROM os_artifacts WHERE id=?')
      .get(id) as Artifact | undefined;
    if (!row) throw Error('artifact_not_found');
    return row;
  }
  async stage(input: { url?: string; text?: string; limit_bytes?: number }, signal?: AbortSignal) {
    if (Number(input.url !== undefined) + Number(input.text !== undefined) !== 1)
      throw Error('one_artifact_source_required');
    const limit = input.limit_bytes ?? this.maxBytes;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.maxBytes)
      throw Error('artifact_limit');
    if (input.text !== undefined)
      return this.stageStream(
        (async function* () {
          yield Buffer.from(input.text!);
        })(),
        limit,
        signal,
      );
    const url = new URL(input.url!);
    if (!['https:', 'http:'].includes(url.protocol)) throw Error('artifact_url_protocol');
    const response = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(120000),
      redirect: 'follow',
    });
    if (!response.ok || !response.body) throw Error('artifact_fetch_failed:' + response.status);
    return this.stageStream(response.body as any, limit, signal);
  }
  async stageStream(
    source: AsyncIterable<Uint8Array>,
    limit = this.maxBytes,
    signal?: AbortSignal,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.maxBytes)
      throw Error('artifact_limit');
    await mkdir(this.root, { recursive: true });
    const id = randomUUID(),
      path = join(resolve(this.root), id),
      file = await open(path, 'wx');
    let bytes = 0;
    const hash = createHash('sha256');
    try {
      const write = async (data: Uint8Array) => {
        signal?.throwIfAborted();
        if (data.length > limit - bytes) throw Error('artifact_too_large');
        let at = 0;
        while (at < data.length) {
          const n = await file.write(data, at, data.length - at);
          if (!n.bytesWritten) throw Error('artifact_short_write');
          at += n.bytesWritten;
        }
        bytes += data.length;
        hash.update(data);
      };
      for await (const chunk of source) await write(chunk);
      await file.sync();
      await file.close();
      const sha256 = hash.digest('hex');
      this.db
        .prepare('INSERT INTO os_artifacts VALUES(?,?,?,?,?)')
        .run(id, path, bytes, sha256, Date.now());
      return { id, size: bytes, sha256 };
    } catch (e) {
      await file.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw e;
    }
  }
  async deliver(
    transport: DeviceRpc,
    files: { path: string; artifact_id: string }[],
    signal: AbortSignal,
    expectedBoot?: string,
  ) {
    let boot = expectedBoot;
    const rpc: DeviceRpc = async (path, method, args) => {
      const reply = await transport(path, method, {
        ...args,
        ...(boot ? { expected_boot_id: boot } : {}),
      });
      if (boot && reply.boot_id !== boot) throw Error('device_boot_changed');
      boot = reply.boot_id;
      return reply;
    };
    if (!files.length || files.length > 512) throw Error('artifact_file_count');
    const names = new Set<string>();
    const resolved = files.map((f) => {
      if (
        !f.path ||
        f.path.startsWith('/') ||
        posix.normalize(f.path) !== f.path ||
        f.path.split('/').includes('..') ||
        f.path.includes('\\') ||
        names.has(f.path)
      )
        throw Error('artifact_path');
      names.add(f.path);
      return { ...f, ...this.get(f.artifact_id), destination: f.path };
    });
    const call = async (method: string, args: any) => {
      signal.throwIfAborted();
      for (;;) {
        signal.throwIfAborted();
        const r = await rpc('/sys/transfers', method, args);
        if (r.ok) return r.result;
        if (['spi_busy', 'resource_busy', 'operation_active'].includes(r.error ?? '')) {
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        throw Error(r.error ?? 'transfer_failed');
      }
    };
    const total = resolved.reduce((n, f) => n + f.size, 0),
      key = createHash('sha256')
        .update(JSON.stringify(resolved.map((f) => [f.destination, f.sha256, f.size])))
        .digest('hex');
    const prepare = async (p: any) => {
      const description = await rpc('/sys/capabilities', 'describe', { path: p.path });
      if (!description.ok) throw Error(description.error);
      const async = description.result?.async?.[p.method];
      let result = await rpc(
        async ? '/sys/operations' : p.path,
        async ? 'request' : p.method,
        async ? { path: p.path, method: p.method, args: p.args ?? {} } : (p.args ?? {}),
      );
      if (result.ok && result.result.completion_id) {
        const id = result.result.completion_id;
        try {
          for (;;) {
            signal.throwIfAborted();
            const r = await rpc('/sys/operations', 'read', { id });
            if (!r.ok) throw Error(r.error);
            if (r.result.ready) {
              result = { ...r, ok: async.success_events.includes(r.result.event) };
              break;
            }
            await new Promise((r) => setTimeout(r, 25));
          }
        } finally {
          await rpc('/sys/operations', 'release', { id });
        }
      }
      return result;
    };
    // Explicit delivery can prepare/refresh storage; discovery remains read-only.
    const policy = await call('read', {});
    let volumes = await rpc('/fs', 'mounts', {});
    if (volumes.ok)
      for (const target of policy.policy?.targets ?? []) {
        let volume = volumes.result.providers.find((p: any) => p.id === target.provider);
        if (!volume) continue;
        if (!volume.available) {
          if (!volume.prepare) continue;
          const result = await prepare(volume.prepare);
          if (!result.ok) {
            const error =
              result.error ?? result.result?.data?.error ?? 'storage_preparation_failed';
            if (/memory|budget|busy|active|timeout|cancel/.test(error)) throw Error(error);
            const state = await rpc(volume.prepare.path, 'read', {});
            if (state.ok && state.result.link_ready) throw Error('storage_volume_unavailable');
            continue;
          }
          volumes = await rpc('/fs', 'mounts', {});
          volume = volumes.result.providers.find((p: any) => p.id === target.provider);
        }
        if (volume.capacity_refresh && (volume.free_needs_refresh || volume.free_bytes == null)) {
          const r = await prepare(volume.capacity_refresh);
          if (!r.ok) throw Error('storage_capacity_unavailable');
        }
        break;
      }
    const start = await call('begin', {
      request_id: key,
      bytes: String(total),
      files: files.length,
    });
    let committed = start.state === 'committed';
    if (committed) return { transfer_id: start.id, root: start.root };
    try {
      for (const item of resolved.slice(start.files_complete ?? 0)) {
        const file = await open(item.path, 'r');
        try {
          const info = await file.stat();
          if (info.size !== item.size) throw Error('artifact_changed');
          const opened = await call('file', {
            id: start.id,
            path: item.destination,
            bytes: String(item.size),
            sha256: item.sha256,
          });
          const bytes = Buffer.alloc(start.chunk_bytes);
          let offset = Number(opened.file_offset ?? 0);
          while (offset < item.size) {
            const { bytesRead } = await file.read(
              bytes,
              0,
              Math.min(bytes.length, item.size - offset),
              offset,
            );
            if (!bytesRead) throw Error('artifact_short_read');
            await call('chunk', {
              id: start.id,
              offset: String(offset),
              hex: bytes.subarray(0, bytesRead).toString('hex'),
            });
            offset += bytesRead;
          }
          await call('close_file', { id: start.id });
        } finally {
          await file.close();
        }
      }
      const receipt = await call('commit', { id: start.id });
      committed = true;
      return { transfer_id: start.id, root: receipt.root };
    } catch (error) {
      if (
        error instanceof Error &&
        !/disconnected|transport|outcome_unknown|timeout/i.test(error.message)
      )
        await call('abort', { id: start.id }).catch(() => {});
      throw error;
    }
  }
}
export function parseManagedResult(raw: string, target: string) {
  let result: any;
  try {
    result = JSON.parse(raw);
  } catch {
    if (target !== 'application') throw Error('managed_result_required');
    result = { format: 'wishos-result/1', application: { text: raw }, effects: [] };
  }
  if (result?.format !== 'wishos-result/1' || !['application', 'system', 'both'].includes(target))
    throw Error('managed_result_format');
  if (
    result.application !== undefined &&
    (!result.application ||
      typeof result.application !== 'object' ||
      Array.isArray(result.application))
  )
    throw Error('managed_application_result');
  if (
    (target === 'system' && result.application !== undefined) ||
    (target === 'application' && result.effects?.length)
  )
    throw Error('managed_result_scope');
  if (result.effects !== undefined && (!Array.isArray(result.effects) || result.effects.length > 1))
    throw Error('managed_effect_limit');
  for (const e of result.effects ?? []) {
    if (
      !['application', 'presentation', 'resource_call'].includes(e.kind) ||
      typeof e.path !== 'string'
    )
      throw Error('managed_effect');
    const keys =
      e.kind === 'application'
        ? ['kind', 'path', 'activate', 'persist']
        : e.kind === 'presentation'
          ? ['kind', 'path', 'driver']
          : ['kind', 'path', 'method', 'args'];
    if (Object.keys(e).some((k) => !keys.includes(k))) throw Error('managed_effect_field');
    for (const key of ['activate', 'persist'])
      if (e[key] !== undefined && typeof e[key] !== 'boolean') throw Error('managed_effect_type');
    if (
      e.kind === 'resource_call' &&
      (typeof e.method !== 'string' ||
        !e.args ||
        Array.isArray(e.args) ||
        typeof e.args !== 'object')
    )
      throw Error('managed_effect_type');
  }

  return result;
}
