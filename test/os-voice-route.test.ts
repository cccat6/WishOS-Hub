import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { voiceRoute, type AudioDeliveryProgress } from '../src/os-voice-route.js';
import { OsAudioIngress } from '../src/os-audio-ingress.js';
import type { DeviceRpc } from '../src/os-remote.js';

function fixture(
  options: { legacy?: boolean; latency?: number; failReadAck?: boolean; durable?: boolean } = {},
) {
  const db = new DatabaseSync(':memory:');
  const ingress = new OsAudioIngress(db, async () => ({ run_id: 'native-run' }));
  const received = new Set<number>(),
    events: AudioDeliveryProgress[] = [];
  let time = 0,
    produced = 0,
    dropped = 0,
    highest = 0,
    rejects = 0,
    emptyReads = 0;
  const queue: number[] = [],
    calls: { method: string; args: any; at: number }[] = [];
  const advance = () => {
    time += options.latency ?? 70;
    const end = Math.min(200, Math.floor(time / 10)); // 16 kHz / 160 samples = 100 blocks/s.
    while (produced < end) {
      if (queue.length === 32) {
        queue.shift();
        dropped++;
      }
      queue.push(produced++);
    }
  };
  const ack = (sequence: number) => {
    assert(sequence <= highest, 'device ACK preceded durable host receipt');
    while (queue.length && queue[0] < sequence) queue.shift();
  };
  const chunk = (sequence: number) => {
    const b = Buffer.alloc(91);
    b[0] = 0x42;
    b.writeUInt32LE(sequence, 1);
    b.writeUInt16LE(160, 9);
    return {
      sequence,
      samples: 160,
      sample_start: String(sequence * 160),
      adpcm_b64: b.toString('base64'),
    };
  };
  const rpc: DeviceRpc = async (_path, method, args) => {
    advance();
    calls.push({ method, args, at: time });
    let result: any = {};
    if (method === 'ack') ack(args.next_sequence as number);
    if (method === 'read' || method === 'read_chunk') {
      if (method === 'read_chunk' && 'after_sequence' in args) {
        if (options.failReadAck) throw Error('connection_lost');
        if (options.legacy) {
          rejects++;
          return { ok: false, boot_id: 'b', error: 'unknown_mic_argument', result: {} };
        }
        ack(args.after_sequence as number);
      }
      const chunks =
        method === 'read_chunk' ? queue.slice(0, Math.min(Number(args.limit), 11)).map(chunk) : [];
      if (method === 'read_chunk' && produced === 200 && queue.length === 0) {
        emptyReads++;
        return { ok: false, boot_id: 'b', error: 'recording_not_found', result: {} };
      }
      result = {
        sample_rate: 16000,
        recording_id: 'recording',
        recording: produced < 200,
        chunks,
        buffered_chunks: queue.length,
        produced_samples: String(produced * 160),
        dropped_samples: String(dropped * 160),
        storage_pending: false,
        capture_failed: false,
        storage_requested: 'off',
        offered_sequence: chunks.length ? chunks.at(-1)!.sequence + 1 : highest,
      };
    }
    return { ok: true, boot_id: 'b', result };
  };
  const route = voiceRoute(
    rpc,
    async (id, action, args) => {
      if (action === 'begin') return ingress.begin('device', id, args as any);
      if (action === 'chunks') {
        const result = ingress.append('device', id, args!.chunks as any);
        for (const c of args!.chunks as any[]) received.add(c.sequence);
        // The durable high-water mark is independent of gaps in the timeline.
        highest = Math.max(...received) + 1;
        return options.durable === false ? { ...result, durable: false } : result;
      }
      if (action === 'finish') return ingress.finish('device', id, args as any);
      if (action === 'abort') return ingress.abortUpload('device', id, args!.error as string);
      return ingress.status('device', id);
    },
    { onProgress: (p) => events.push(p) },
  );
  const run = () =>
    route(
      { id: 1, request_id: 'request', route: 'voice', payload: { recording_id: 'recording' } },
      new AbortController().signal,
    );
  return {
    run,
    calls,
    received,
    events,
    get dropped() {
      return dropped;
    },
    get rejects() {
      return rejects;
    },
    get emptyReads() {
      return emptyReads;
    },
    async close() {
      await ingress.close();
      db.close();
    },
  };
}

test('live capture piggybacks durable ACKs, respects truncated batches, and drains a short RAM ring before ASR', async () => {
  const f = fixture();
  try {
    const result: any = await f.run();
    assert.equal(result.run_id, 'native-run');
    assert.equal(f.received.size, 200);
    assert.equal(f.dropped, 0);
    assert.equal(f.emptyReads, 0); // Final queue snapshot does not need another empty read.
    assert.equal(f.calls.filter((c) => c.method === 'ack').length, 1);
    assert(
      f.calls.some((c) => c.method === 'read_chunk' && c.at < 2000 && 'after_sequence' in c.args),
    );
    assert(f.events.some((e) => e.phase === 'receiving' && e.blocks > 0));
    assert(f.events.some((e) => e.phase === 'drained' && e.acknowledged_sequence === 200));
    assert.equal(f.events.at(-1)!.phase, 'accepted');
    const completed = f.events.at(-1)!;
    assert.equal(completed.ack_mode, 'read_ack');
    assert.equal(completed.standalone_acks, 1);
    assert(completed.piggyback_acks > 0);
    assert(completed.first_batch_at_ms! >= completed.collector_started_at_ms);
    assert(completed.first_ack_at_ms! >= completed.first_batch_at_ms!);
  } finally {
    await f.close();
  }
});

test('an explicit unsupported read/ACK field selects legacy ACK once without losing capture data', async () => {
  const f = fixture({ legacy: true, latency: 20 });
  try {
    await f.run();
    assert.equal(f.received.size, 200);
    assert.equal(f.rejects, 1);
    assert(f.calls.filter((c) => c.method === 'ack').length > 1);
    assert.equal(f.events.at(-1)!.ack_mode, 'legacy');
    assert.equal(f.events.at(-1)!.piggyback_acks, 0);
  } finally {
    await f.close();
  }
});

test('lost read/ACK responses are not replayed as legacy reads, and non-durable uploads never ACK', async () => {
  for (const options of [{ failReadAck: true }, { durable: false }]) {
    const f = fixture(options);
    try {
      await assert.rejects(
        f.run,
        options.failReadAck ? /audio_device_transport/ : /audio_durable_receipt_required/,
      );
      assert.equal(f.calls.filter((c) => c.method === 'ack').length, 0);
      assert.equal(f.events.at(-1)!.phase, 'failed');
      assert.equal(f.events.at(-1)!.cleanup_error, undefined);
      assert.equal(
        f.calls.filter((c) => c.method === 'read_chunk').length,
        options.failReadAck ? 2 : 1,
      );
    } finally {
      await f.close();
    }
  }
});
