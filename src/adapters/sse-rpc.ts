import { EventEmitter } from 'node:events';
/** WorkBuddy's documented ACP: GET receives JSON-RPC; POST sends it under the
 * exact Acp-Connection-Id. HTTP admission is not a prompt completion. */
export class SseRpc extends EventEmitter {
  private next = 1;
  private opening?: Promise<void>;
  private abort = new AbortController();
  private connection = '';
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private writes = new Set<Promise<void>>();
  constructor(
    private endpoint: string,
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {
    super();
  }
  private open() {
    return (this.opening ??= (async () => {
      const timeout = setTimeout(() => this.fail(Error('acp_open_timeout')), 10000);
      let response: Response;
      try {
        response = await this.fetcher(this.endpoint, {
          headers: { Authorization: 'Bearer ' + this.token, Accept: 'text/event-stream' },
          signal: this.abort.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok || !response.body) throw Error('acp_receive_http_' + response.status);
      this.connection = response.headers.get('Acp-Connection-Id') ?? '';
      if (!this.connection) throw Error('acp_connection_identity');
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      const receive = (async () => {
        let buffer = '';
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            buffer += decoder.decode(r.value, { stream: true });
            if (buffer.length > 4 * 1024 * 1024) throw Error('acp_frame_limit');
            for (;;) {
              const separator = /\r?\n\r?\n|\r\r/.exec(buffer);
              if (!separator) break;
              const at = separator.index;
              const event = buffer.slice(0, at);
              buffer = buffer.slice(at + separator[0].length);
              const data = event
                .split(/\r\n|\r|\n/)
                .filter((x) => x.startsWith('data:'))
                .map((x) => x.slice(5).trimStart())
                .join('\n');
              if (!data) continue;
              const m = JSON.parse(data);
              if (m.method) this.emit('message', m);
              else {
                const p = this.pending.get(m.id);
                if (p) {
                  clearTimeout(p.timer);
                  this.pending.delete(m.id);
                  m.error ? p.reject(Error('acp_rpc_' + m.error.code)) : p.resolve(m.result);
                }
              }
            }
          }
          if (!this.abort.signal.aborted) this.fail(Error('acp_receive_closed'));
        } catch {
          if (!this.abort.signal.aborted) this.fail(Error('acp_receive_failed'));
        } finally {
          reader.releaseLock();
        }
      })();
      this.writes.add(receive);
      void receive.finally(() => this.writes.delete(receive));
    })().catch((error) => {
      this.fail(error);
      throw error;
    }));
  }
  private async post(message: unknown) {
    if (this.abort.signal.aborted) throw Error('acp_closed');
    await this.open();
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + this.token,
        'Content-Type': 'application/json',
        'Acp-Connection-Id': this.connection,
      },
      body: JSON.stringify(message),
      signal: this.abort.signal,
    });
    await response.body?.cancel();
    if (!response.ok) throw Error('acp_send_http_' + response.status);
  }
  write(message: any) {
    const send = this.post({ jsonrpc: '2.0', ...message });
    this.writes.add(send);
    void send
      .catch(() => this.fail(Error('acp_send_outcome_unknown')))
      .finally(() => this.writes.delete(send));
  }
  async request(method: string, params: unknown, timeoutMs = 30000) {
    await this.open();
    const id = this.next++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('acp_outcome_unknown'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  private fail(error: Error) {
    if (!this.abort.signal.aborted) this.abort.abort(error);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit('closed', error);
  }
  async close() {
    this.abort.abort();
    this.fail(Error('acp_closed'));
    await Promise.allSettled([...this.writes]);
  }
}
