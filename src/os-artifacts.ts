import { deliverBundle } from './bundle-transfer.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { join, resolve, posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DeviceRpc } from './os-remote.js';

export type Artifact = { id: string; size: number; sha256: string; path: string };
/** Host-only source retrieval. Device traffic contains native resources and
 * bounded control metadata, never an arbitrary origin URL or a whole book. */
export class ArtifactStore {
  private staging = new Set<string>();
  private leases = new Map<string, number>();
  private maintenance?: Promise<void>;
  private preparing = new Map<string, Promise<any>>();
  constructor(
    private db: DatabaseSync,
    readonly root: string,
    readonly maxBytes = 512 * 1024 * 1024,
    readonly policy = { maxStoredBytes: 2 * 1024 * 1024 * 1024, ttlMs: 86400000 },
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS os_artifact_pending(id TEXT PRIMARY KEY,path TEXT,reserved INTEGER)',
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS os_managed_results(key TEXT PRIMARY KEY,result TEXT NOT NULL)',
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS os_artifacts(id TEXT PRIMARY KEY,path TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,created INTEGER NOT NULL)',
    );
  }
  private async cleanup() {
    if (this.maintenance) return this.maintenance;
    const work = (async () => {
      const rows = this.db.prepare('SELECT id,path FROM os_artifact_pending').all() as {
        id: string;
        path: string;
      }[];
      for (const row of rows)
        if (!this.staging.has(row.id)) {
          await unlink(row.path).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          });
          this.db.prepare('DELETE FROM os_artifact_pending WHERE id=?').run(row.id);
        }
      for (const row of this.db
        .prepare('SELECT id,path FROM os_artifacts WHERE created<?')
        .all(Date.now() - this.policy.ttlMs) as { id: string; path: string }[]) {
        if (this.leases.has(row.id)) continue;
        await unlink(row.path).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
        this.db.prepare('DELETE FROM os_artifacts WHERE id=?').run(row.id);
      }
    })();
    this.maintenance = work;
    try {
      await work;
    } finally {
      if (this.maintenance === work) this.maintenance = undefined;
    }
  }
  async managedResult(key: string, prepare: () => Promise<any>) {
    const saved = this.db.prepare('SELECT result FROM os_managed_results WHERE key=?').get(key) as
      | { result: string }
      | undefined;
    if (saved) return JSON.parse(saved.result);
    const prior = this.db
      .prepare("SELECT result FROM os_managed_results WHERE substr(key,instr(key,':')+1)=?")
      .all(key.slice(key.indexOf(':') + 1)) as { result: string }[];
    if (
      prior.some(
        (r) =>
          JSON.parse(r.result).actions?.length ||
          JSON.parse(r.result).sequence ||
          JSON.parse(r.result).effects?.length,
      )
    )
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
    if (input.text !== undefined && Buffer.byteLength(input.text) > limit)
      throw Error('artifact_too_large');
    if (input.text !== undefined)
      return this.stageStream(
        (async function* () {
          yield Buffer.from(input.text!);
        })(),
        Math.min(limit, Buffer.byteLength(input.text!)),
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
    await this.cleanup();
    const used = (
      this.db.prepare('SELECT COALESCE(sum(size),0) n FROM os_artifacts').get() as { n: number }
    ).n;
    const reserved = (
      this.db.prepare('SELECT COALESCE(sum(reserved),0) n FROM os_artifact_pending').get() as {
        n: number;
      }
    ).n;
    if (limit > this.policy.maxStoredBytes - used - reserved) throw Error('artifact_storage_quota');
    const id = randomUUID(),
      path = join(resolve(this.root), id);
    this.staging.add(id);
    this.db.prepare('INSERT INTO os_artifact_pending VALUES(?,?,?)').run(id, path, limit);
    let file;
    try {
      file = await open(path, 'wx');
    } catch (e) {
      this.staging.delete(id);
      this.db.prepare('DELETE FROM os_artifact_pending WHERE id=?').run(id);
      throw e;
    }

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
    } finally {
      this.staging.delete(id);
      this.db.prepare('DELETE FROM os_artifact_pending WHERE id=?').run(id);
    }
  }
  async deliver(
    transport: DeviceRpc,
    files: { path: string; artifact_id: string }[],
    signal: AbortSignal,
    expectedBoot?: string,
    remoteRequestId?: number,
  ) {
    return deliverBundle(transport, files, signal, expectedBoot, remoteRequestId, {
      get: (id) => this.get(id),
      open: async (item) => {
        this.leases.set(item.id, (this.leases.get(item.id) ?? 0) + 1);
        let file;
        try {
          file = await open(item.path, 'r');
        } catch (e) {
          this.leases.delete(item.id);
          throw e;
        }
        if ((await file.stat()).size !== item.size) {
          await file.close();
          this.leases.delete(item.id);
          throw Error('artifact_changed');
        }
        return {
          read: (buffer, offset, length, position) => file.read(buffer, offset, length, position),
          close: async () => {
            await file.close();
            const n = this.leases.get(item.id) ?? 1;
            if (n <= 1) this.leases.delete(item.id);
            else this.leases.set(item.id, n - 1);
          },
        };
      },
    });
  }
}
export { parseManagedResult } from './actions.js';
