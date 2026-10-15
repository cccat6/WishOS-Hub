import { createHash } from 'node:crypto';
import { CloudError } from './http';
import type { BundleArtifact, BundleSource } from '../src/bundle-transfer';
import type { ResourceJob, ResourceJobStore } from '../src/resource-jobs';
const blockBytes = 32768;
/** Explicit temporary resources, never an account transcript or an audio spool.
 * SQLite chunks avoid requiring an R2 billing activation for a small deployment. */
export class CloudArtifacts implements BundleSource {
  readonly maxFile = 16 * 1024 * 1024;
  readonly maxRoom = 64 * 1024 * 1024;
  private reservations = 0;
  private leased = new Map<string, number>();
  constructor(private sql: SqlStorage) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,size INTEGER,sha256 TEXT,created INTEGER,state TEXT);CREATE TABLE IF NOT EXISTS artifact_chunks(id TEXT,part INTEGER,start INTEGER,data BLOB,PRIMARY KEY(id,part));',
    );
    for (const row of sql.exec<{ id: string }>("SELECT id FROM artifacts WHERE state='staging'"))
      this.remove(row.id);
    sql.exec('CREATE INDEX IF NOT EXISTS chunk_positions ON artifact_chunks(id,start)');
    this.cleanup();
  }
  private remove(id: string) {
    this.sql.exec('DELETE FROM artifact_chunks WHERE id=?', id);
    this.sql.exec('DELETE FROM artifacts WHERE id=?', id);
  }
  cleanup() {
    for (const row of this.sql.exec<{ id: string }>(
      'SELECT id FROM artifacts WHERE created<?',
      Date.now() - 3600000,
    ))
      if (!this.leased.has(row.id)) this.remove(row.id);
  }
  get(id: string): BundleArtifact {
    const row = this.sql
      .exec<{
        id: string;
        size: number;
        sha256: string;
        created: number;
      }>("SELECT id,size,sha256,created FROM artifacts WHERE id=? AND state='ready'", id)
      .toArray()[0];
    if (!row || (row.created <= Date.now() - 3600000 && !this.leased.has(id)))
      throw Error('artifact_not_found_or_expired');
    return { ...row, path: row.id };
  }
  async stage(input: { text?: string; url?: string; limit_bytes?: number }, signal: AbortSignal) {
    if (Number(input.text !== undefined) + Number(input.url !== undefined) !== 1)
      throw Error('one_artifact_source_required');
    const limit = input.limit_bytes ?? this.maxFile;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.maxFile)
      throw Error('cloud_artifact_limit_16mib');
    this.cleanup();
    const used = this.sql
      .exec<{ n: number }>("SELECT COALESCE(sum(size),0) n FROM artifacts WHERE state='ready'")
      .one().n;
    if (used + this.reservations + limit > this.maxRoom) throw Error('cloud_artifact_quota');
    this.reservations += limit;
    const id = 'cloud_' + crypto.randomUUID();
    this.sql.exec('INSERT INTO artifacts VALUES(?,0,?, ?,?)', id, '', Date.now(), 'staging');
    let response: Response | undefined;
    try {
      let source: AsyncIterable<Uint8Array>;
      if (input.text !== undefined)
        source = (async function* () {
          yield new TextEncoder().encode(input.text!);
        })();
      else {
        let url = new URL(input.url!);
        for (let i = 0; ; i++) {
          if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            ['localhost', '127.0.0.1', '[::1]', '169.254.169.254'].includes(url.hostname)
          )
            throw Error('cloud_source_requires_public_https');
          response = await fetch(url, { signal, redirect: 'manual' });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            if (i >= 4) throw Error('source_redirect_limit');
            url = new URL(response.headers.get('location')!, url);
            continue;
          }
          break;
        }
        if (!response.ok || !response.body) throw Error('artifact_source_failed');
        if (Number(response.headers.get('content-length') ?? 0) > limit)
          throw Error('artifact_too_large');
        source = response.body;
      }
      let size = 0,
        part = 0;
      const hash = createHash('sha256');
      for await (const chunk of source) {
        signal.throwIfAborted();
        if (chunk.length > limit - size) throw Error('artifact_too_large');
        hash.update(chunk);
        size += chunk.length;
        for (let at = 0; at < chunk.length; at += blockBytes)
          this.sql.exec(
            'INSERT INTO artifact_chunks VALUES(?,?,?,?)',
            id,
            part++,
            size - chunk.length + at,
            chunk.slice(at, at + blockBytes).buffer,
          );
      }
      const sha256 = hash.digest('hex');
      this.sql.exec(
        "UPDATE artifacts SET size=?,sha256=?,state='ready' WHERE id=?",
        size,
        sha256,
        id,
      );
      return { id, size, sha256, expires_at: Date.now() + 3600000 };
    } catch (e) {
      await response?.body?.cancel().catch(() => {});
      this.remove(id);
      throw e;
    } finally {
      this.reservations -= limit;
    }
  }
  private unpin(id: string) {
    const n = this.leased.get(id) ?? 1;
    if (n <= 1) this.leased.delete(id);
    else this.leased.set(id, n - 1);
  }
  pin(artifacts: BundleArtifact[]) {
    const ids = [...new Set(artifacts.map((a) => a.id))];
    for (const id of ids) this.get(id);
    for (const id of ids) {
      this.leased.set(id, (this.leased.get(id) ?? 0) + 1);
    }
    return () => {
      for (const id of ids) this.unpin(id);
    };
  }
  async open(artifact: BundleArtifact) {
    this.get(artifact.id);
    this.leased.set(artifact.id, (this.leased.get(artifact.id) ?? 0) + 1);
    // Demand-driven pages: no whole-resource allocation, regardless of network chunk layout.
    return {
      read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        let written = 0;
        while (written < length) {
          const row = this.sql
            .exec<{
              data: ArrayBuffer;
              start: number;
            }>(
              'SELECT data,start FROM artifact_chunks WHERE id=? AND start<=? ORDER BY start DESC LIMIT 1',
              artifact.id,
              position,
            )
            .toArray()[0];
          if (!row) break;
          const bytes = new Uint8Array(row.data),
            start = position - row.start,
            n = Math.min(bytes.length - start, length - written);
          if (n <= 0) break;
          buffer.set(bytes.subarray(start, start + n), offset + written);
          written += n;
          position += n;
        }
        return { bytesRead: written };
      },
      close: async () => {
        this.unpin(artifact.id);
      },
    };
  }
  deleteAll() {
    this.sql.exec('DELETE FROM artifact_chunks;DELETE FROM artifacts');
  }
}
export class CloudJobStore implements ResourceJobStore {
  constructor(private sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS resource_jobs(id TEXT PRIMARY KEY,value TEXT,updated INTEGER);UPDATE resource_jobs SET value=json_set(value,'$.state','unknown','$.error','cloud_restarted') WHERE json_extract(value,'$.state') IN ('queued','running');",
    );
  }
  read(id: string) {
    const row = this.sql
      .exec<{ value: string }>('SELECT value FROM resource_jobs WHERE id=?', id)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as ResourceJob) : undefined;
  }
  save(job: ResourceJob) {
    this.sql.exec(
      "DELETE FROM resource_jobs WHERE updated<? AND json_extract(value,'$.state') IN ('completed','failed')",
      Date.now() - 3600000,
    );
    if (
      !this.read(job.id) &&
      this.sql.exec<{ n: number }>('SELECT count(*) n FROM resource_jobs').one().n >= 256
    )
      throw Error('cloud_job_capacity');
    this.sql.exec(
      'INSERT OR REPLACE INTO resource_jobs VALUES(?,?,?)',
      job.id,
      JSON.stringify(job),
      job.updated,
    );
  }
  list() {
    return this.sql
      .exec<{ value: string }>('SELECT value FROM resource_jobs ORDER BY updated DESC LIMIT 100')
      .toArray()
      .map((row) => JSON.parse(row.value) as ResourceJob);
  }
}
