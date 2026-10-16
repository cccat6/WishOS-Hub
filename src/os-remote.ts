import { canonicalValue } from './control-receipts.js';
/** Portable transport bridge. Handlers are upstream service adapters; device apps use the managed system APIs. */
import { createHash } from 'node:crypto';
import { MemoryRemoteJournal, type RemoteJournal } from './os-journal.js';
export type RemoteRequest = {
  id: number;
  request_id: string;
  boot_id?: string;
  observed_at_ms?: number;
  route: string;
  payload: Record<string, unknown>;
};
export type RemoteHandler = ((
  request: RemoteRequest,
  signal: AbortSignal,
) => Promise<unknown> | unknown) & {
  /** Admission may establish ordered stream identity; it must not wait for the task. */
  admit?: (request: RemoteRequest, signal: AbortSignal) => Promise<void>;
  /** Only adapters with an upstream request-id guarantee may opt into replay. */
  replaySafe?: boolean;
};
export interface DeviceRpc {
  (
    path: string,
    method: string,
    args: Record<string, unknown>,
  ): Promise<{ boot_id: string; ok: boolean; error?: string; result: any }>;
}
export class RetryableRemoteError extends Error {}
type Task = {
  boot: string;
  request: RemoteRequest;
  fingerprint: string;
  abort: AbortController;
  state: 'running' | 'ready' | 'retry';
  ok: boolean;
  result: unknown;
  retryAt: number;
  journalled: boolean;
};
export class OsRemoteBridge {
  private polling = false;
  private closed = false;
  private tasks = new Map<number, Task>();
  private boot?: string;
  private journal: RemoteJournal;
  private capacity: number;
  get pendingCount() {
    return this.tasks.size;
  }
  constructor(
    private rpc: DeviceRpc,
    private handlers: Readonly<Record<string, RemoteHandler>>,
    options: { journal?: RemoteJournal; maxInFlight?: number } = {},
  ) {
    this.journal = options.journal ?? new MemoryRemoteJournal();
    this.capacity = options.maxInFlight ?? 4;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) throw Error('remote_concurrency');
  }
  private settle(task: Task, ok: boolean, value: unknown) {
    if (this.closed || task.abort.signal.aborted) return;
    let result = value ?? null;
    try {
      const text = JSON.stringify(result);
      if (text === undefined) throw Error();
      if (Buffer.byteLength(text) > 1536) {
        ok = false;
        result = { error: 'result_too_large', hint: 'Return a file URL or storage reference' };
      } else result = JSON.parse(text);
    } catch {
      ok = false;
      result = { error: 'result_not_json' };
    }
    this.journal.complete(task.request.request_id, task.fingerprint, ok, result);
    task.journalled = true;
    task.ok = ok;
    task.result = result;
    task.state = 'ready';
  }
  private async start(task: Task, signal: AbortSignal) {
    if (this.closed || signal.aborted || task.abort.signal.aborted) return;
    const handler = this.handlers[task.request.route],
      previous = this.journal.get(task.request.request_id);
    if (previous && previous.fingerprint !== task.fingerprint) {
      task.ok = false;
      task.result = { error: 'request_id_conflict' };
      task.state = 'ready';
      return;
    }
    if (previous && previous.state !== 'executing') {
      task.journalled = true;
      task.ok = !!previous.ok;
      task.result = previous.result;
      task.state = 'ready';
      return;
    }
    if (previous?.state === 'executing' && !handler?.replaySafe) {
      this.settle(task, false, {
        error: 'handler_outcome_unknown',
        hint: 'Reconcile the service outcome before using a new request identity',
      });
      return;
    }
    if (!handler) {
      this.settle(task, false, { error: 'route_not_registered' });
      return;
    }
    this.journal.begin(task.request.request_id, task.fingerprint);
    task.journalled = true;
    task.state = 'running';
    const combined = AbortSignal.any([signal, task.abort.signal]);
    const failed = (error: unknown) => {
      if (this.closed || combined.aborted) return;
      if (handler.replaySafe && error instanceof RetryableRemoteError && !combined.aborted) {
        task.state = 'retry';
        task.retryAt = Date.now() + 500;
      } else
        this.settle(task, false, { error: error instanceof Error ? error.message : String(error) });
    };
    try {
      if (handler.admit) await handler.admit(task.request, combined);
    } catch (error) {
      failed(error);
      return;
    }
    if (this.closed || combined.aborted) return;
    void Promise.resolve()
      .then(() => {
        if (this.closed || combined.aborted) return;
        return handler(task.request, combined);
      })
      .then((result) => this.settle(task, true, result), failed);
  }
  async poll(signal: AbortSignal): Promise<void> {
    if (this.closed || this.polling || signal.aborted) return;
    this.polling = true;
    try {
      let after = 0;
      const seen = new Set<number>();
      for (let page = 0; page < this.capacity + 1; page++) {
        const peek = await this.rpc('/services/remote', 'peek', { after_id: after });
        if (this.closed || signal.aborted) return;
        if (!peek.ok) throw Error(peek.error ?? 'device_peek_failed');
        if (this.boot && this.boot !== peek.boot_id) {
          for (const task of this.tasks.values()) task.abort.abort(Error('device_boot_changed'));
          this.tasks.clear();
        }
        this.boot = peek.boot_id;
        const request = peek.result as RemoteRequest & { state: string };
        if (request.state === 'empty') break;
        if (!Number.isInteger(request.id) || request.id <= after) break;
        after = request.id;
        seen.add(request.id);
        let task = this.tasks.get(request.id);
        if (!task && this.tasks.size < this.capacity) {
          const key = request.request_id || `${peek.boot_id}:${request.id}`;
          request.request_id = key;
          request.boot_id = peek.boot_id;
          request.observed_at_ms = Date.now();
          task = {
            boot: peek.boot_id,
            request,
            fingerprint: createHash('sha256')
              .update(canonicalValue({ route: request.route, payload: request.payload }))
              .digest('hex'),
            abort: new AbortController(),
            state: 'running',
            ok: false,
            result: null,
            retryAt: 0,
            journalled: false,
          };
          this.tasks.set(request.id, task);
          await this.start(task, signal);
        } else if (task?.state === 'retry' && Date.now() >= task.retryAt)
          await this.start(task, signal);
      }
      for (const [id, task] of this.tasks) {
        if (!seen.has(id) && task.state !== 'ready') {
          task.abort.abort(Error('request_retired'));
          this.tasks.delete(id);
          continue;
        }
        if (task.state !== 'ready') continue;
        const done = await this.rpc('/services/remote', 'complete', {
          id,
          expected_boot_id: task.boot,
          ok: task.ok,
          result: task.result,
        });
        if (!done.ok) {
          if (
            done.error === 'request_not_found' ||
            done.error === 'boot_changed' ||
            done.error === 'completion_conflict'
          ) {
            this.tasks.delete(id);
            continue;
          }
          throw Error(done.error ?? 'device_completion_failed');
        }
        if (this.closed || signal.aborted) return;
        if (task.journalled) this.journal.acknowledge(task.request.request_id);
        this.tasks.delete(id);
      }
    } finally {
      this.polling = false;
    }
  }
  close() {
    this.closed = true;
    for (const task of this.tasks.values()) task.abort.abort(Error('bridge_closed'));
    this.tasks.clear();
  }
}
export function deviceRpc(base: string, fetcher: typeof fetch = fetch): DeviceRpc {
  const endpoint = new URL('/os/invoke', base);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw Error('HTTP endpoint required');
  return async (path, method, args) => {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, method, args }),
      signal: AbortSignal.timeout(10000),
    });
    return await response.json();
  };
}
export function harnessRoute(
  hub: string,
  device: string,
  token = '',
  fetcher: typeof fetch = fetch,
): RemoteHandler {
  const handler: RemoteHandler = async (request, signal) => {
    if (typeof request.payload.text !== 'string') throw Error('text_required');
    let response: Response;
    try {
      response = await fetcher(
        new URL(`/api/devices/${encodeURIComponent(device)}/messages`, hub),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            request_id: request.request_id,
            text: request.payload.text,
            ...(Object.hasOwn(request.payload, 'session_id')
              ? { session_id: request.payload.session_id }
              : {}),
          }),
          signal,
        },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RetryableRemoteError('harness_transport_unavailable');
    }
    if (response.status >= 500)
      throw new RetryableRemoteError(`harness_service_unavailable:${response.status}`);
    const result = (await response.json()) as { id?: string };
    if (!response.ok) throw Error(`harness_request_failed:${response.status}`);
    return { state: 'accepted', run_id: result.id };
  };
  handler.replaySafe = true;
  return handler;
}
