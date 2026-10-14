import { createHash } from 'node:crypto';
import { HttpError } from './protocol.js';
class AudioError extends HttpError {
  constructor(code: string) {
    super(
      code.endsWith('limit')
        ? 413
        : code.endsWith('not_found')
          ? 404
          : code.endsWith('full')
            ? 503
            : code.endsWith('conflict')
              ? 409
              : 400,
      code,
    );
  }
}
import type { DatabaseSync } from 'node:sqlite';
import { osAudioPacket, type OsAudioChunk } from './os-audio.js';
import { decodeVoicePacket } from './voice-codec.js';
export type AudioConfig = {
  sample_rate: number;
  session_id?: string | null;
  binding_group?: string;
  resolved_session_id?: string;
  max_gap_ms?: number;
  max_missing_ms?: number;
  max_loss_ratio?: number;
};
export type AudioFinal = { produced_samples: string; capture_failed: boolean };
export type AudioReceipt = Record<string, unknown>;
export type AudioExecutor = (
  device: string,
  id: string,
  wav: Buffer,
  config: AudioConfig,
  signal: AbortSignal,
) => Promise<AudioReceipt>;
type Row = {
  device: string;
  id: string;
  config: string;
  state: string;
  final: string | null;
  receipt: string | null;
  updated: number;
  ordinal: number;
  bytes: number;
  blocks: number;
  next_sequence: number;
};
/** Server-side durable ingress, separate from embedded recording policy and from
 * Harness execution. A completed upload can be acknowledged before ASR finishes. */
export const AudioLimits = {
  compressed_bytes: 8 * 1024 * 1024,
  decoded_bytes: 32 * 1024 * 1024,
  streams_per_device: 4,
  idle_ms: 90000,
  total_bytes: 64 * 1024 * 1024,
  failed_ttl_ms: 86400000,
};
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
      void work.catch(() => {});
      return;
    }
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
export class OsAudioIngress {
  private running = new Set<string>();
  private tasks = new Set<Promise<void>>();
  private closed = false;
  private abort = new AbortController();
  readonly limits: typeof AudioLimits;
  constructor(
    private db: DatabaseSync,
    private execute: AudioExecutor,
    limits: Partial<typeof AudioLimits> = {},
  ) {
    this.limits = { ...AudioLimits, ...limits };
    for (const [key, n] of Object.entries(this.limits))
      if (!Object.hasOwn(AudioLimits, key) || !Number.isSafeInteger(n) || n < 1)
        throw Error('audio_ingress_limits');
    db.exec(`CREATE TABLE IF NOT EXISTS os_audio_streams(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,device TEXT NOT NULL,id TEXT NOT NULL,config TEXT NOT NULL,state TEXT NOT NULL,final TEXT,receipt TEXT,updated INTEGER NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,blocks INTEGER NOT NULL DEFAULT 0,next_sequence INTEGER NOT NULL DEFAULT 0,UNIQUE(device,id));
   CREATE TABLE IF NOT EXISTS os_audio_blocks(device TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL,sample_start TEXT NOT NULL,samples INTEGER NOT NULL,packet BLOB NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(device,id,sequence));`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS os_audio_pending ON os_audio_streams(device,state,ordinal)',
    );
    // ASR itself is repeatable. The executor must reconcile a previously recorded
    // Harness admission before sending another turn/steer after process restart.
    db.prepare("UPDATE os_audio_streams SET state='queued' WHERE state='processing'").run();
  }
  private row(device: string, id: string) {
    return this.db
      .prepare('SELECT * FROM os_audio_streams WHERE device=? AND id=?')
      .get(device, id) as Row | undefined;
  }
  private validId(id: string) {
    if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(id)) throw new AudioError('audio_id');
  }
  private config(value: AudioConfig) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AudioError('audio_configuration');
    for (const key of Object.keys(value))
      if (
        ![
          'sample_rate',
          'session_id',
          'binding_group',
          'resolved_session_id',
          'max_gap_ms',
          'max_missing_ms',
          'max_loss_ratio',
        ].includes(key)
      )
        throw new AudioError('audio_configuration_field');
    if (
      !Number.isInteger(value.sample_rate) ||
      value.sample_rate < 8000 ||
      value.sample_rate > 192000
    )
      throw new AudioError('audio_sample_rate');
    if (
      value.session_id !== undefined &&
      value.session_id !== null &&
      (typeof value.session_id !== 'string' || value.session_id.length > 256)
    )
      throw new AudioError('audio_session');
    for (const [key, min, max] of [
      ['max_gap_ms', 0, 60000],
      ['max_missing_ms', 0, 3600000],
      ['max_loss_ratio', 0, 1],
    ] as const) {
      const n = value[key];
      if (n !== undefined && (!Number.isFinite(n) || n < min || n > max))
        throw new AudioError('audio_loss_policy');
    }
    for (const key of ['binding_group', 'resolved_session_id'] as const)
      if (
        value[key] !== undefined &&
        (typeof value[key] !== 'string' || !value[key].length || value[key].length > 256)
      )
        throw new AudioError('audio_session');
    return JSON.stringify(
      Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
    );
  }
  begin(device: string, id: string, config: AudioConfig) {
    this.validId(id);
    const encoded = this.config(config),
      old = this.row(device, id);
    if (old) {
      const saved = JSON.parse(old.config);
      delete saved.resolved_session_id;
      delete saved.binding_group;
      const expected = { ...config };
      delete expected.resolved_session_id;
      delete expected.binding_group;
      if (this.config(saved) !== this.config(expected)) throw new AudioError('audio_id_conflict');
      return this.status(device, id);
    }
    const pending = this.db
      .prepare(
        "SELECT count(*) AS n FROM os_audio_streams WHERE device=? AND state IN ('receiving','queued','processing')",
      )
      .get(device) as { n: number };
    if (pending.n >= this.limits.streams_per_device) throw new AudioError('audio_ingress_full');
    this.db
      .prepare(
        "INSERT INTO os_audio_streams(device,id,config,state,updated) VALUES(?,?,?,'receiving',?)",
      )
      .run(device, id, encoded, Date.now());
    return this.status(device, id);
  }
  append(device: string, id: string, chunks: OsAudioChunk[]) {
    const row = this.row(device, id);
    if (!row || row.state !== 'receiving') throw new AudioError('audio_not_receiving');
    if (!Array.isArray(chunks) || chunks.length > 32) throw new AudioError('audio_batch_limit');
    const records = chunks.map((chunk) => {
      let packet: Buffer;
      try {
        packet = osAudioPacket(chunk);
      } catch {
        throw new AudioError('invalid_audio_packet');
      }
      const at = BigInt(chunk.sample_start);
      if (at + BigInt(chunk.samples) > BigInt(this.limits.decoded_bytes / 2))
        throw new AudioError('audio_resource_limit');
      return {
        chunk,
        packet,
        digest: createHash('sha256').update(packet).update(chunk.sample_start).digest('hex'),
      };
    });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let bytes = row.bytes,
        blocks = row.blocks,
        next = row.next_sequence,
        total = (
          this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM os_audio_streams').get() as {
            n: number;
          }
        ).n;
      for (const { chunk, packet, digest } of records) {
        const old = this.db
          .prepare('SELECT digest FROM os_audio_blocks WHERE device=? AND id=? AND sequence=?')
          .get(device, id, chunk.sequence) as { digest: string } | undefined;
        if (old) {
          if (old.digest !== digest) throw new AudioError('audio_sequence_conflict');
          continue;
        }
        bytes += packet.length;
        total += packet.length;
        ++blocks;
        next = Math.max(next, chunk.sequence + 1);
        if (bytes > this.limits.compressed_bytes || total > this.limits.total_bytes)
          throw new AudioError('audio_resource_limit');
        this.db
          .prepare('INSERT INTO os_audio_blocks VALUES(?,?,?,?,?,?,?)')
          .run(device, id, chunk.sequence, chunk.sample_start, chunk.samples, packet, digest);
      }
      this.db
        .prepare(
          'UPDATE os_audio_streams SET updated=?,bytes=?,blocks=?,next_sequence=? WHERE device=? AND id=?',
        )
        .run(Date.now(), bytes, blocks, next, device, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { stored: true, durable: true, ...this.status(device, id) };
  }
  finish(device: string, id: string, final: AudioFinal) {
    const row = this.row(device, id);
    if (!row) throw new AudioError('audio_not_found');
    if (
      typeof final.produced_samples !== 'string' ||
      !/^\d+$/.test(final.produced_samples) ||
      typeof final.capture_failed !== 'boolean'
    )
      throw new AudioError('audio_final');
    if (BigInt(final.produced_samples) * 2n > BigInt(this.limits.decoded_bytes))
      throw new AudioError('audio_resource_limit');
    const encoded = JSON.stringify({
      produced_samples: final.produced_samples,
      capture_failed: final.capture_failed,
    });
    if (row.final && row.final !== encoded) throw new AudioError('audio_final_conflict');
    if (row.state === 'receiving')
      this.db
        .prepare(
          "UPDATE os_audio_streams SET state='queued',final=?,updated=? WHERE device=? AND id=?",
        )
        .run(encoded, Date.now(), device, id);
    this.kick(device);
    return { durable: true, ...this.status(device, id) };
  }
  status(device: string, id: string) {
    const row = this.row(device, id);
    if (!row) throw new AudioError('audio_not_found');
    return {
      audio_id: id,
      state: row.state,
      blocks: row.blocks,
      bytes: row.bytes,
      next_sequence: row.next_sequence,
      ...(row.receipt ? { result: JSON.parse(row.receipt) } : {}),
    };
  }
  binding(device: string, id: string) {
    const row = this.row(device, id);
    return row ? (JSON.parse(row.config) as AudioConfig) : undefined;
  }
  pendingGroup(device: string) {
    const row = this.db
      .prepare(
        "SELECT config FROM os_audio_streams WHERE device=? AND state IN ('receiving','queued','processing') ORDER BY ordinal LIMIT 1",
      )
      .get(device) as { config: string } | undefined;
    return row ? (JSON.parse(row.config) as AudioConfig) : undefined;
  }

  pending(device: string) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM os_audio_streams WHERE device=? AND state IN ('receiving','queued','processing') LIMIT 1",
        )
        .get(device),
    );
  }
  activeGroups() {
    return new Set(
      (
        this.db
          .prepare(
            "SELECT DISTINCT json_extract(config,'$.binding_group') AS id FROM os_audio_streams WHERE state IN ('receiving','queued','processing')",
          )
          .all() as { id: string }[]
      ).map((x) => x.id),
    );
  }
  private async wav(row: Row) {
    const config = JSON.parse(row.config) as AudioConfig,
      final = JSON.parse(row.final!) as AudioFinal;
    if (final.capture_failed) throw new AudioError('capture_failed');
    const samples = Number(BigInt(final.produced_samples));
    if (!samples) throw new AudioError('empty_recording');
    const pcm = Buffer.alloc(samples * 2);
    let previous = 0,
      missing = 0,
      maxGap = 0,
      received = 0;
    const rows = this.db
      .prepare(
        'SELECT sequence,sample_start,samples,packet FROM os_audio_blocks WHERE device=? AND id=? ORDER BY sequence',
      )
      .iterate(row.device, row.id);
    let blocks = 0;
    for (const value of rows) {
      const block = value as { sample_start: string; samples: number; packet: Uint8Array };
      const at = Number(BigInt(block.sample_start));
      if (at < previous || at + block.samples > samples) throw new AudioError('audio_sample_order');
      const gap = at - previous;
      missing += gap;
      maxGap = Math.max(maxGap, gap);
      const decoded = decodeVoicePacket(Buffer.from(block.packet));
      decoded.copy(pcm, at * 2);
      received += block.samples;
      previous = at + block.samples;
      if (++blocks % 128 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    missing += samples - previous;
    maxGap = Math.max(maxGap, samples - previous);
    if (
      !received ||
      (maxGap * 1000) / config.sample_rate > (config.max_gap_ms ?? 200) ||
      (missing * 1000) / config.sample_rate > (config.max_missing_ms ?? 1000) ||
      missing / samples > (config.max_loss_ratio ?? 0.05)
    )
      throw new AudioError('audio_loss_exceeded');
    const header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(config.sample_rate, 24);
    header.writeUInt32LE(config.sample_rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return {
      wav: Buffer.concat([header, pcm]),
      missing_samples: missing,
      received_samples: received,
    };
  }
  retry(device: string, id: string) {
    const row = this.row(device, id);
    if (!row) throw new AudioError('audio_not_found');
    if (row.state !== 'failed' || !row.final || !row.bytes)
      throw new AudioError('audio_retry_unavailable');
    this.db
      .prepare(
        "UPDATE os_audio_streams SET state='queued',receipt=NULL,updated=? WHERE device=? AND id=?",
      )
      .run(Date.now(), device, id);
    this.kick(device);
    return this.status(device, id);
  }
  private kick(device: string) {
    if (this.closed || this.running.has(device)) return;
    this.running.add(device);
    const task = (async () => {
      try {
        for (;;) {
          const row = this.db
            .prepare(
              "SELECT * FROM os_audio_streams WHERE device=? AND state IN ('receiving','queued','processing') ORDER BY ordinal LIMIT 1",
            )
            .get(device) as Row | undefined;
          if (!row || row.state === 'receiving' || this.closed) return;
          this.db
            .prepare("UPDATE os_audio_streams SET state='processing' WHERE device=? AND id=?")
            .run(device, row.id);
          let result: AudioReceipt,
            state = 'accepted';
          try {
            const audio = await this.wav(row);
            if (this.closed) return;
            result = {
              ...(await abortable(
                this.execute(device, row.id, audio.wav, JSON.parse(row.config), this.abort.signal),
                this.abort.signal,
              )),
              missing_samples: audio.missing_samples,
              received_samples: audio.received_samples,
            };
          } catch (error) {
            if (this.closed) return;
            state = 'failed';
            result = { error: error instanceof Error ? error.message : String(error) };
          }
          this.db
            .prepare(
              'UPDATE os_audio_streams SET state=?,receipt=?,updated=? WHERE device=? AND id=?',
            )
            .run(state, JSON.stringify(result), Date.now(), device, row.id);
          if (state === 'accepted') {
            const config = JSON.parse(row.config) as AudioConfig;
            if (config.binding_group && typeof result.session_id === 'string')
              this.db
                .prepare(
                  "UPDATE os_audio_streams SET config=json_set(config,'$.resolved_session_id',?) WHERE device=? AND json_extract(config,'$.binding_group')=? AND state IN ('receiving','queued')",
                )
                .run(result.session_id, device, config.binding_group);
            this.db
              .prepare('DELETE FROM os_audio_blocks WHERE device=? AND id=?')
              .run(device, row.id);
            this.db
              .prepare('UPDATE os_audio_streams SET bytes=0 WHERE device=? AND id=?')
              .run(device, row.id);
          }
        }
      } finally {
        this.running.delete(device);
      }
    })();
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
  }
  tick(now = Date.now()) {
    const expired = this.db
      .prepare("SELECT device,id FROM os_audio_streams WHERE state='receiving' AND updated<?")
      .all(now - this.limits.idle_ms) as { device: string; id: string }[];
    for (const row of expired) {
      this.db
        .prepare("UPDATE os_audio_streams SET state='failed',receipt=? WHERE device=? AND id=?")
        .run(JSON.stringify({ error: 'audio_upload_expired' }), row.device, row.id);
      this.db
        .prepare('DELETE FROM os_audio_blocks WHERE device=? AND id=?')
        .run(row.device, row.id);
      this.db
        .prepare('UPDATE os_audio_streams SET bytes=0 WHERE device=? AND id=?')
        .run(row.device, row.id);
    }
    for (const row of this.db
      .prepare(
        "SELECT device,id FROM os_audio_streams WHERE state='failed' AND bytes>0 AND updated<?",
      )
      .all(now - this.limits.failed_ttl_ms) as { device: string; id: string }[]) {
      this.db
        .prepare('DELETE FROM os_audio_blocks WHERE device=? AND id=?')
        .run(row.device, row.id);
      this.db
        .prepare('UPDATE os_audio_streams SET bytes=0 WHERE device=? AND id=?')
        .run(row.device, row.id);
    }
    for (const row of this.db
      .prepare("SELECT DISTINCT device FROM os_audio_streams WHERE state IN ('receiving','queued')")
      .all() as { device: string }[])
      this.kick(row.device);
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    await Promise.allSettled(this.tasks);
  }
}
