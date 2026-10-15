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
  options: { pollMs?: number; batchBlocks?: number } = {},
): RemoteHandler {
  const state = new Map<string, { id: string; rate: number }>();
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
    try {
      capture = await device('read', { recording_id: id });
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
    state.set(r.request_id, { id, rate: capture.sample_rate });
  };
  const handler: RemoteHandler = async (r, signal) => {
    const id = identity(r);
    if (!state.has(r.request_id)) await admit(r, signal);
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
        for (;;) {
          signal.throwIfAborted();
          try {
            capture = await device('read_chunk', {
              recording_id: id,
              limit: options.batchBlocks ?? 16,
            });
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
            await device('ack', { recording_id: id, next_sequence: capture.offered_sequence });
          }
          if (!capture.recording && !capture.chunks.length && !capture.storage_pending) break;
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
      return {
        state: 'accepted',
        ...status.result,
        ...(cleanupError ? { cleanup_error: cleanupError, archive } : {}),
      };
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
