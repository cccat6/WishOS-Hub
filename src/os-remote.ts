/** Portable device-to-service bridge. Handler implementations belong to applications. */
export type RemoteRequest = {
  id: number; request_id: string; route: string; payload: Record<string, unknown>;
};
export type RemoteHandler = (request: RemoteRequest, signal: AbortSignal) => Promise<unknown>;
export interface DeviceRpc {
  (path: string, method: string, args: Record<string, unknown>): Promise<{boot_id: string; ok: boolean; error?: string; result: any}>;
}
export class OsRemoteBridge {
  private active = false;
  // Keep a completed result across transport loss; never repeat a completed side effect.
  private pending?: {boot: string; request: RemoteRequest; result: unknown; ok: boolean};
  constructor(private rpc: DeviceRpc, private handlers: Readonly<Record<string, RemoteHandler>>) {}
  async poll(signal: AbortSignal): Promise<void> {
    if (this.active || signal.aborted) return;
    this.active = true;
    try {
      const peek = await this.rpc('/services/remote', 'peek', {});
      if (!peek.ok) throw Error(peek.error ?? 'device_peek_failed');
      const request = peek.result as RemoteRequest & {state: string};
      if (this.pending && (this.pending.boot !== peek.boot_id || request.id !== this.pending.request.id)) {
        // Old boot/expired request cannot receive a result for a newer request ID.
        this.pending = undefined;
      }
      if (request.state === 'empty') return;
      if (!this.pending) {
        let result: unknown, ok = false;
        const handler = this.handlers[request.route];
        try {
          if (!handler) throw Error('route_not_registered');
          result = await handler(request, signal); ok = true;
        } catch (error) { result = {error: error instanceof Error ? error.message : String(error)}; }
        if (result === undefined) result = null;
        try {
          const encoded = JSON.stringify(result);
          if (encoded === undefined) throw Error('result_not_json');
          if (Buffer.byteLength(encoded) > 1536) {
            result = {error: 'result_too_large', hint: 'Return a file URL or storage reference'}; ok = false;
          } else result = JSON.parse(encoded); // Immutable snapshot for completion retries.
        } catch {
          result = {error: 'result_not_json'}; ok = false;
        }
        this.pending = {boot: peek.boot_id, request, result, ok};
      }
      const done = this.pending;
      const response = await this.rpc('/services/remote', 'complete', {
        id: done.request.id, expected_boot_id: done.boot, ok: done.ok, result: done.result,
      });
      if (!response.ok) throw Error(response.error ?? 'device_completion_failed');
      this.pending = undefined;
    } finally { this.active = false; }
  }
}
export function deviceRpc(base: string, fetcher: typeof fetch = fetch): DeviceRpc {
  const endpoint = new URL('/os/invoke', base);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw Error('HTTP endpoint required');
  return async (path, method, args) => {
    const response = await fetcher(endpoint, {method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({path,method,args}),signal:AbortSignal.timeout(10000)});
    return await response.json();
  };
}
/** A Harness request uses the existing Hub session API, including its request-id deduplication. */
export function harnessRoute(hub: string, device: string, token = '', fetcher: typeof fetch = fetch): RemoteHandler {
  return async (request, signal) => {
    if (typeof request.payload.text !== 'string') throw Error('text_required');
    const response = await fetcher(new URL(`/api/devices/${encodeURIComponent(device)}/messages`, hub), {
      method:'POST', headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
      body:JSON.stringify({request_id:request.request_id,text:request.payload.text,
        ...(Object.hasOwn(request.payload,'session_id')?{session_id:request.payload.session_id}:{})}), signal,
    });
    const result = await response.json();
    if (!response.ok) throw Error(`harness_request_failed:${response.status}`);
    return {state:'accepted',run_id:result.id}; // Accepted is distinct from Harness completion.
  };
}
