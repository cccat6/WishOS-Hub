import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { voiceRoute, type AudioDeliveryProgress } from '../src/os-voice-route.js';
import { OsAudioIngress } from '../src/os-audio-ingress.js';
import type { DeviceRpc } from '../src/os-remote.js';
import { packBatch } from './fixtures/audio-batch.js';

function fixture(
  options: {
    legacy?: boolean;
    latency?: number;
    failReadAck?: boolean;
    durable?: boolean;
    ignoredAck?: boolean;
    offeredAhead?: boolean;
    omitRate?: boolean;
    totalBlocks?: number;
    cancelDuringRead?: boolean;
    batch?: boolean;
    batchUnsupported?: boolean;
    malformedBatch?: boolean;
    ingressBatch?: number;
  } = {},
) {
  const db = new DatabaseSync(':memory:');
  const controller = new AbortController(),
    apiActions: string[] = [];
  const ingress = new OsAudioIngress(
    db,
    async () => ({ run_id: 'native-run' }),
    options.ingressBatch ? { batch_blocks: options.ingressBatch } : {},
  );
  const received = new Set<number>(),
    events: AudioDeliveryProgress[] = [];
  let time = 0,
    produced = 0,
    dropped = 0,
    highest = 0,
    rejects = 0,
    emptyReads = 0;
  const total = options.totalBlocks ?? 200;
  let acknowledged = 0;
  const queue: number[] = [],
    calls: { method: string; args: any; at: number }[] = [];
  const advance = () => {
    time += options.latency ?? 70;
    const end = Math.min(total, Math.floor(time / 10)); // 16 kHz / 160 samples = 100 blocks/s.
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
    acknowledged = Math.max(acknowledged, sequence);
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
    if (_path === '/sys/capabilities') {
      calls.push({ method, args, at: time });
      return {
        ok: true,
        boot_id: 'b',
        result: options.batch
          ? {
              batch_read: {
                method: 'read_batch',
                maximum_chunks: 30,
                acknowledgement_cursor: 'after_sequence',
                format: 'wishos-audio-batch/1',
              },
            }
          : {},
      };
    }
    advance();
    calls.push({ method, args, at: time });
    let result: any = {};
    if (method === 'read_batch' && options.batchUnsupported)
      return { ok: false, boot_id: 'b', error: 'unsupported_method', result: {} };
    if (method === 'ack') ack(args.next_sequence as number);
    if (method === 'read' || method === 'read_chunk' || method === 'read_batch') {
      if (['read_chunk', 'read_batch'].includes(method) && 'after_sequence' in args) {
        if (options.cancelDuringRead) controller.abort(Error('request_retired'));
        if (options.failReadAck) throw Error('connection_lost');
        if (options.legacy) {
          rejects++;
          return { ok: false, boot_id: 'b', error: 'unknown_mic_argument', result: {} };
        }
        if (!options.ignoredAck) ack(args.after_sequence as number);
      }
      const chunks = ['read_chunk', 'read_batch'].includes(method)
        ? queue.slice(0, Math.min(Number(args.limit), method === 'read_batch' ? 24 : 11)).map(chunk)
        : [];
      if (method === 'read_chunk' && produced === total && queue.length === 0) {
        emptyReads++;
        return { ok: false, boot_id: 'b', error: 'recording_not_found', result: {} };
      }
      result = {
        sample_rate: 16000,
        recording_id: 'recording',
        recording: produced < total,
        chunks,
        buffered_chunks: queue.length,
        produced_samples: String(produced * 160),
        dropped_samples: String(dropped * 160),
        storage_pending: false,
        capture_failed: false,
        storage_requested: 'off',
        offered_sequence: chunks.length
          ? chunks.at(-1)!.sequence + 1 + (options.offeredAhead ? 50 : 0)
          : highest,
        acknowledged_sequence: acknowledged,
      };
      if (method === 'read_batch') {
        result.encoding = 'ima-adpcm';
        result.batch_encoding = 'wishos-audio-batch/1';
        result.batch_b64 = options.malformedBatch ? 'broken' : packBatch(chunks);
        delete result.chunks;
      }
      if (options.omitRate && method === 'read_chunk') delete result.sample_rate;
    }
    return { ok: true, boot_id: 'b', result };
  };
  const route = voiceRoute(
    rpc,
    async (id, action, args) => {
      apiActions.push(action);
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
      {
        id: 1,
        request_id: 'request',
        boot_id: 'b',
        route: 'voice',
        payload: { recording_id: 'recording' },
      },
      controller.signal,
    );
  return {
    run,
    discover: () => route.discover('b', controller.signal),
    batchMaximum: options.batch ? 30 : 0,
    calls,
    received,
    events,
    apiActions,
    pending: () => ingress.pending('device'),
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
    assert.equal(f.calls[0].method, 'read_chunk');
    assert.equal(f.calls.filter((c) => ['read', 'describe'].includes(c.method)).length, 0);
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
test('retirement during a batch reply cannot finish the upload or admit ASR after cancellation', async () => {
  const f = fixture({ cancelDuringRead: true });
  try {
    await assert.rejects(f.run, /request_retired/);
    assert(!f.apiActions.includes('finish'));
    assert(f.apiActions.includes('abort'));
    assert.equal(f.pending(), false);
    assert.equal(f.calls.filter((c) => c.method === 'ack').length, 0);
    assert.equal(f.events.at(-1)!.phase, 'failed');
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
test('ACK cursor follows durable received packets, never a higher previously-offered watermark', async () => {
  const f = fixture({ offeredAhead: true });
  try {
    await f.run();
    assert.equal(f.received.size, 200);
    assert.equal(f.events.at(-1)!.acknowledged_sequence, 200);
    assert(f.calls.every((c) => (c.args.after_sequence ?? c.args.next_sequence ?? 0) <= 200));
    assert.equal(f.events.at(-1)!.ack_mode, 'read_ack');
  } finally {
    await f.close();
  }
});
test('a legacy driver silently ignoring the cursor is detected before unbounded duplicate reads', async () => {
  const f = fixture({ ignoredAck: true, latency: 20 });
  try {
    await f.run();
    assert.equal(f.received.size, 200);
    assert.equal(f.events.at(-1)!.blocks, 200);
    assert.equal(f.events.at(-1)!.ack_mode, 'legacy');
    assert.equal(f.calls.filter((c) => 'after_sequence' in c.args).length, 1);
  } finally {
    await f.close();
  }
});
test('the prefetched first batch survives legacy metadata fallback and can finish a stopped capture directly', async () => {
  for (const omitRate of [false, true]) {
    const f = fixture({ totalBlocks: 5, omitRate });
    try {
      await f.run();
      assert.equal(f.received.size, 5);
      assert.equal(f.calls.filter((c) => c.method === 'read_chunk').length, 1);
      assert.equal(f.calls.filter((c) => c.method === 'read').length, omitRate ? 1 : 0);
      assert.equal(f.calls.filter((c) => c.method === 'ack').length, 1);
      assert.equal(f.events.at(-1)!.acknowledged_sequence, 5);
    } finally {
      await f.close();
    }
  }
});

test('advertised compact batches preserve durable ACKs and improve delivery without changing ring capacity or loss policy', async () => {
  const f = fixture({
    batch: true,
    latency: 150,
    totalBlocks: 200,
    offeredAhead: true,
    ingressBatch: 5,
  });
  try {
    await f.discover();
    await f.discover();
    const result: any = await f.run();
    assert.equal(result.run_id, 'native-run');
    assert.equal(f.calls.filter((c) => c.method === 'describe').length, 1);
    assert.equal(f.calls.filter((c) => c.method === 'read_chunk').length, 0);
    const descriptor = f.calls.find((c) => c.method === 'describe');
    const maximum = descriptor?.args?.path === '/dev/mic' ? f.batchMaximum : 0;
    assert(maximum > 0);
    assert(f.calls.some((c) => c.method === 'read_batch' && c.args.limit === maximum));
    assert.equal(f.received.size, 200);
    assert.equal(f.dropped, 0);
    assert.equal(f.events.at(-1)?.read_method, 'read_batch');
    assert.equal(f.events.at(-1)?.acknowledged_sequence, 200);
    assert.equal(f.calls.filter((c) => c.method === 'ack').length, 1);
  } finally {
    await f.close();
  }
});

test('unknown capability remains legacy and an explicit unsupported compact method falls back once', async () => {
  for (const batch of [false, true]) {
    const f = fixture({ batch, batchUnsupported: true });
    try {
      await f.discover();
      assert(((await f.run()) as any).run_id);
      assert.equal(f.calls.filter((c) => c.method === 'read_batch').length, batch ? 1 : 0);
      assert(f.calls.some((c) => c.method === 'read_chunk'));
      assert.equal(f.events.at(-1)?.read_method, 'read_chunk');
    } finally {
      await f.close();
    }
  }
});

test('compact corruption and unknown transport outcomes do not become legacy reads or acknowledgements', async () => {
  for (const mode of ['corrupt', 'transport', 'non-durable']) {
    const f = fixture({
      batch: true,
      malformedBatch: mode === 'corrupt',
      failReadAck: mode === 'transport',
      durable: mode !== 'non-durable',
    });
    try {
      await f.discover();
      await assert.rejects(
        f.run(),
        mode === 'corrupt'
          ? /invalid_audio_batch/
          : mode === 'transport'
            ? /audio_device_transport/
            : /audio_durable_receipt_required/,
      );
      assert.equal(f.calls.filter((c) => c.method === 'read_chunk').length, 0);
      assert.equal(f.calls.filter((c) => c.method === 'ack').length, 0);
      if (mode === 'corrupt') assert.equal(f.received.size, 0);
    } finally {
      await f.close();
    }
  }
});

test('a new boot invalidates batch negotiation and a late old-boot reply cannot authorize it', async () => {
  const replies = new Map<string, (r: any) => void>(),
    methods: string[] = [];
  const route = voiceRoute(
    async (path, method, args) => {
      methods.push(method);
      if (path === '/sys/capabilities')
        return new Promise((resolve) => replies.set(args.expected_boot_id as string, resolve));
      assert.equal(method, 'read_chunk');
      return {
        ok: true,
        boot_id: 'new',
        result: {
          recording_id: 'r',
          sample_rate: 16000,
          recording: false,
          chunks: [],
          produced_samples: '0',
          capture_failed: false,
          storage_pending: false,
        },
      };
    },
    async (_id, action) => {
      if (action === '') throw Error('audio_not_found');
      return {};
    },
  );
  const controller = new AbortController();
  const older = route.discover('old', controller.signal),
    newer = route.discover('new', controller.signal);
  replies.get('new')!({ ok: true, boot_id: 'new', result: {} });
  await newer;
  replies.get('old')!({
    ok: true,
    boot_id: 'old',
    result: {
      batch_read: {
        method: 'read_batch',
        maximum_chunks: 30,
        format: 'wishos-audio-batch/1',
        acknowledgement_cursor: 'after_sequence',
      },
    },
  });
  await older;
  await route.admit!(
    { id: 1, boot_id: 'new', request_id: 'new:1', route: 'voice', payload: { recording_id: 'r' } },
    controller.signal,
  );
  assert.deepEqual(methods, ['describe', 'describe', 'read_chunk']);
});

test('unrecognized batch declarations and transient capability failures do not authorize the compact method', async () => {
  let attempts = 0,
    mode = 'failed';
  const methods: string[] = [];
  const route = voiceRoute(
    async (path, method) => {
      methods.push(method);
      if (path === '/sys/capabilities') {
        attempts++;
        return mode === 'failed'
          ? { ok: false, boot_id: 'b', error: 'resource_busy', result: {} }
          : {
              ok: true,
              boot_id: 'b',
              result: {
                batch_read: {
                  method: 'read_batch',
                  maximum_chunks: 30,
                  format: 'future-audio-batch/2',
                  acknowledgement_cursor: 'after_sequence',
                },
              },
            };
      }
      return {
        ok: true,
        boot_id: 'b',
        result: { sample_rate: 16000, chunks: [], recording: false },
      };
    },
    async (_id, action) => {
      if (action === '') throw Error('audio_not_found');
      return {};
    },
  );
  const signal = new AbortController().signal;
  await route.discover('b', signal);
  mode = 'unknown';
  await route.discover('b', signal);
  await route.discover('b', signal);
  assert.equal(attempts, 2);
  await route.admit!(
    { id: 1, request_id: 'b:1', boot_id: 'b', route: 'voice', payload: { recording_id: 'r' } },
    signal,
  );
  assert.equal(methods.at(-1), 'read_chunk');
});
