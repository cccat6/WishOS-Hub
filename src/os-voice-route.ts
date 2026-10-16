/** An application route, not part of the embedded kernel. It pulls independently
 * decodable blocks over any DeviceRpc transport and acknowledges only host-durable
 * receipt. ASR and Harness admission remain separate from that receipt. */
import {
  RetryableRemoteError,
  type DeviceRpc,
  type RemoteHandler,
  type RemoteRequest,
} from './os-remote.js';
export type AudioApi = (
  id: string,
  action: string,
  args?: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<any>;
export type AudioDeliveryProgress = {
  recording_id: string;
  phase: 'receiving' | 'drained' | 'accepted' | 'failed';
  elapsed_ms: number;
  reads: number;
  blocks: number;
  acknowledged_sequence: number;
  read_ms: number;
  max_read_ms: number;
  max_ack_gap_ms: number;
  device_dropped_samples: string;
  error?: string;
  cleanup_error?: string;
  request_observed_at_ms?: number;
  collector_started_at_ms: number;
  first_batch_at_ms?: number;
  first_ack_at_ms?: number;
  ack_mode: 'read_ack' | 'legacy';
  piggyback_acks: number;
  standalone_acks: number;
};
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
export function voiceRoute(
  rpc: DeviceRpc,
  api: AudioApi,
  options: {
    pollMs?: number;
    batchBlocks?: number;
    onProgress?: (progress: AudioDeliveryProgress) => void;
  } = {},
): RemoteHandler {
  const state = new Map<
    string,
    {
      id: string;
      rate: number;
      first?: any;
      started: number;
      startedAt: number;
      readMs: number;
      readAt: number;
    }
  >();
  const device = async (method: string, args: Record<string, unknown>) => {
    let r;
    try {
      r = await rpc('/dev/mic', method, args);
    } catch {
      throw new RetryableRemoteError('audio_device_transport');
    }
    if (!r.ok) throw Error(r.error ?? 'audio_device_error');
    return r.result;
  };
  const identity = (r: RemoteRequest) => {
    const id = r.payload.recording_id;
    if (typeof id !== 'string' || !id) throw Error('recording_id_required');
    return id;
  };
  const admit = async (r: RemoteRequest, signal: AbortSignal) => {
    const id = identity(r);
    try {
      await api(id, '', undefined, signal);
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'audio_not_found') throw error;
    }
    let capture;
    const started = performance.now(),
      startedAt = Date.now();
    let readMs = 0,
      readAt = 0;
    try {
      capture = await device('read_chunk', { recording_id: id, limit: options.batchBlocks ?? 16 });
      readMs = Math.round(performance.now() - started);
      readAt = Date.now();
      // Older read_chunk replies may omit metadata while still returning data.
      // Keep that first batch; only those adapters need the separate status read.
      if (capture.sample_rate === undefined) {
        const metadata = await device('read', { recording_id: id });
        capture = { ...metadata, ...capture, sample_rate: metadata.sample_rate };
      }
    } catch (error) {
      if (typeof r.payload.file !== 'string') throw error;
      const saved = await rpc('/services/recordings', 'read', { file: r.payload.file });
      if (!saved.ok) throw Error(saved.error);
      capture = { sample_rate: saved.result.metadata.sample_rate_hz };
    }
    await api(
      id,
      'begin',
      {
        sample_rate: capture.sample_rate,
        ...(r.payload.managed_request ? { managed_request: r.payload.managed_request } : {}),
        ...(Object.hasOwn(r.payload, 'session_id') ? { session_id: r.payload.session_id } : {}),
      },
      signal,
    );
    state.set(r.request_id, {
      id,
      rate: capture.sample_rate,
      first: Array.isArray(capture.chunks) ? capture : undefined,
      started,
      startedAt,
      readMs,
      readAt,
    });
  };
  const handler: RemoteHandler = async (r, signal) => {
    const id = identity(r);
    if (!state.has(r.request_id)) await admit(r, signal);
    const admission = state.get(r.request_id);
    const started = admission?.started ?? performance.now();
    let lastAck = started;
    const progress: AudioDeliveryProgress = {
      recording_id: id,
      phase: 'receiving',
      elapsed_ms: 0,
      reads: 0,
      blocks: 0,
      acknowledged_sequence: 0,
      read_ms: 0,
      max_read_ms: 0,
      max_ack_gap_ms: 0,
      device_dropped_samples: '0',
      request_observed_at_ms: r.observed_at_ms,
      collector_started_at_ms: admission?.startedAt ?? Date.now(),
      ack_mode: 'read_ack',
      piggyback_acks: 0,
      standalone_acks: 0,
    };
    const publish = () => {
      progress.elapsed_ms = Math.round(performance.now() - started);
      options.onProgress?.({ ...progress });
    };
    const acknowledged = (sequence: number) => {
      if (sequence > progress.acknowledged_sequence) {
        const now = performance.now();
        progress.max_ack_gap_ms = Math.max(progress.max_ack_gap_ms, Math.round(now - lastAck));
        lastAck = now;
        progress.acknowledged_sequence = sequence;
        progress.first_ack_at_ms ??= Date.now();
      }
    };
    publish();
    let archive = typeof r.payload.file === 'string' ? r.payload.file : '',
      retention = 'off';
    const saved = async (method: string, args: Record<string, unknown>) => {
      const response = await rpc('/services/recordings', method, args);
      if (!response.ok) throw Error(response.error ?? 'recording_archive');
      return response.result;
    };
    try {
      let status = await api(id, '', undefined, signal);
      if (status.state === 'receiving') {
        let capture: any;
        let first = admission?.first;
        if (admission) admission.first = undefined;
        let pendingAck: number | undefined,
          piggyback = true;
        for (;;) {
          signal.throwIfAborted();
          try {
            const began = performance.now();
            if (first) {
              capture = first;
              first = undefined;
              progress.read_ms = admission!.readMs;
              if (capture.chunks.length) progress.first_batch_at_ms = admission!.readAt;
            } else {
              const args: Record<string, unknown> = {
                recording_id: id,
                limit: options.batchBlocks ?? 16,
                ...(piggyback && pendingAck !== undefined ? { after_sequence: pendingAck } : {}),
              };
              let rejected = false;
              try {
                capture = await device('read_chunk', args);
              } catch (error) {
                // Older adapters explicitly reject the optional read/ack field before
                // effects. Never retry an unknown transport outcome as a legacy read.
                if (
                  !('after_sequence' in args) ||
                  !(error instanceof Error) ||
                  !['unknown_mic_argument', 'unknown_argument'].includes(error.message)
                )
                  throw error;
                rejected = true;
              }
              // An undeclared old adapter may ignore the field instead of rejecting
              // it. Returned pre-cursor data (or an explicit lower ACK watermark)
              // proves the combined confirmation was not applied.
              const ignored =
                !rejected &&
                pendingAck !== undefined &&
                (capture.chunks.some((chunk: any) => chunk.sequence < pendingAck!) ||
                  (typeof capture.acknowledged_sequence === 'number' &&
                    capture.acknowledged_sequence < pendingAck));
              if (rejected || ignored) {
                piggyback = false;
                progress.ack_mode = 'legacy';
                await device('ack', { recording_id: id, next_sequence: pendingAck });
                progress.standalone_acks++;
                acknowledged(pendingAck!);
                capture = await device('read_chunk', {
                  recording_id: id,
                  limit: options.batchBlocks ?? 16,
                });
              }
              if (piggyback && pendingAck !== undefined) {
                acknowledged(pendingAck);
                progress.piggyback_acks++;
              }
              pendingAck = undefined;
              progress.read_ms = Math.round(performance.now() - began);
            }
            progress.reads++;
            progress.max_read_ms = Math.max(progress.max_read_ms, progress.read_ms);
            progress.device_dropped_samples = capture.dropped_samples ?? '0';
            if (capture.chunks.length) progress.first_batch_at_ms ??= Date.now();
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'recording_not_found' || !archive)
              throw error;
            const stored = await saved('read', { file: archive });
            capture = {
              recording: false,
              chunks: [],
              produced_samples: stored.metadata.produced_samples,
              capture_failed: stored.metadata.capture_failed,
              durable: true,
              storage_requested: stored.metadata.retention,
            };
          }
          archive = capture.file || archive;
          retention = capture.storage_requested ?? retention;
          if (capture.chunks.length) {
            status = await api(id, 'chunks', { chunks: capture.chunks }, signal);
            if (status.durable !== true) throw Error('audio_durable_receipt_required');
            progress.blocks = status.blocks ?? progress.blocks + capture.chunks.length;
            // offered_sequence is a device-wide peek high-water mark, not proof
            // that this host durably received every previously offered packet.
            pendingAck = Math.max(...capture.chunks.map((chunk: any) => chunk.sequence + 1));
            if (!piggyback) {
              await device('ack', { recording_id: id, next_sequence: pendingAck });
              progress.standalone_acks++;
              acknowledged(pendingAck!);
              pendingAck = undefined;
            }
          }
          publish();
          // A stopped snapshot with its whole remaining queue already durable
          // needs a final ACK, not another network round trip for an empty read.
          const drained =
            !capture.chunks.length ||
            (Number.isInteger(capture.buffered_chunks) &&
              capture.chunks.length >= capture.buffered_chunks);
          if (!capture.recording && drained && !capture.storage_pending) {
            if (pendingAck !== undefined) {
              await device('ack', { recording_id: id, next_sequence: pendingAck });
              progress.standalone_acks++;
              acknowledged(pendingAck);
            }
            progress.phase = 'drained';
            publish();
            break;
          }
          if (!capture.chunks.length) await pause(options.pollMs ?? 20, signal);
        }
        // Optional archive replay fills RAM/network gaps. It uses its existing block
        // index; duplicate compressed blocks are harmless at the durable ingress.
        if (archive && capture.durable) {
          let cursor = 0;
          for (;;) {
            signal.throwIfAborted();
            let batch;
            try {
              batch = await saved('read_chunk', { file: archive, cursor, limit: 16 });
            } catch (error) {
              if (
                error instanceof Error &&
                ['spi_busy', 'resource_busy', 'file_in_use'].includes(error.message)
              ) {
                await pause(20, signal);
                continue;
              }
              throw error;
            }
            if (batch.chunks.length) await api(id, 'chunks', { chunks: batch.chunks }, signal);
            if (!batch.more) break;
            if (batch.next_cursor <= cursor) throw Error('recording_cursor');
            cursor = batch.next_cursor;
          }
        }
        status = await api(
          id,
          'finish',
          { produced_samples: capture.produced_samples, capture_failed: capture.capture_failed },
          signal,
        );
      }
      while (['queued', 'processing'].includes(status.state)) {
        await pause(100, signal);
        status = await api(id, '', undefined, signal);
      }
      if (status.state !== 'accepted')
        throw Error(status.result?.error ?? 'audio_processing_failed');
      let cleanupError: string | undefined;
      if (archive)
        try {
          const stored = await saved('read', { file: archive });
          if (stored.metadata.retention === 'retry') await saved('remove', { file: archive });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !['not_found', 'storage_unavailable'].includes(error.message)
          )
            cleanupError = error instanceof Error ? error.message : String(error);
        }
      try {
        await device('release', { recording_id: id });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'recording_not_found')
          cleanupError = error instanceof Error ? error.message : String(error);
      }
      progress.phase = 'accepted';
      publish();
      return {
        state: 'accepted',
        ...status.result,
        ...(cleanupError ? { cleanup_error: cleanupError, archive } : {}),
      };
    } catch (error) {
      progress.phase = 'failed';
      progress.error = error instanceof Error ? error.message : String(error);
      if (!(error instanceof RetryableRemoteError) && !signal.aborted) {
        try {
          await api(id, 'abort', { error: progress.error.slice(0, 160) }, signal);
        } catch (cleanup) {
          progress.cleanup_error = cleanup instanceof Error ? cleanup.message : String(cleanup);
        }
      }
      publish();
      throw error;
    } finally {
      state.delete(r.request_id);
    }
  };
  handler.admit = admit;
  handler.replaySafe = true;
  return handler;
}
export function httpAudioApi(
  hub: string,
  device: string,
  token = '',
  fetcher: typeof fetch = fetch,
): AudioApi {
  return async (id, action, args, signal) => {
    const path = `/api/devices/${encodeURIComponent(device)}/audio/${encodeURIComponent(id)}${action ? '/' + action : ''}`;
    let r: Response;
    try {
      r = await fetcher(new URL(path, hub), {
        method: action ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(action ? { body: JSON.stringify(args ?? {}) } : {}),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RetryableRemoteError('audio_server_transport');
    }
    const result = await r.json();
    if (r.status >= 500) throw new RetryableRemoteError(result.error ?? 'audio_server_unavailable');
    if (!r.ok) throw Error(result.error ?? `audio_http_${r.status}`);
    return result;
  };
}
