import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { OsRpcSocket } from '../os-rpc-socket.js';
import type { ConnectorConfig } from './config.js';
export class ConnectorRelay {
  private abort = new AbortController();
  private sockets = new Set<WebSocket>();
  private tasks: Promise<void>[] = [];
  connected = false;
  lastError = '';
  private authorizationRejected = false;
  constructor(
    private cloud: NonNullable<ConnectorConfig['cloud']>,
    private devices: () => string[],
    private api: (path: string, body?: unknown) => Promise<unknown>,
    private attach: (id: string, peer: OsRpcSocket) => void,
  ) {}
  private endpoint(path: string) {
    const u = new URL(path, this.cloud.endpoint);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u;
  }
  start() {
    this.tasks.push(
      this.loop('/v1/connector', (socket) => {
        this.connected = true;
        this.lastError = '';
        socket.on('message', (raw, binary) => {
          const bytes = Buffer.isBuffer(raw)
            ? raw
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw)
              : Buffer.concat(raw);
          if (binary || bytes.length > 262144) {
            socket.close(1002);
            return;
          }
          let m: any;
          try {
            m = JSON.parse(bytes.toString());
          } catch {
            socket.close(1002);
            return;
          }
          if (m.kind !== 'request' || typeof m.id !== 'string' || typeof m.path !== 'string') {
            socket.close(1002);
            return;
          }
          const work = this.api(m.path, m.body).then(
            (result) => {
              if (socket.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ kind: 'response', id: m.id, result }));
            },
            () => {
              if (socket.readyState === WebSocket.OPEN)
                socket.send(
                  JSON.stringify({ kind: 'response', id: m.id, error: 'host_request_failed' }),
                );
            },
          );
          this.pending.add(work);
          void work.finally(() => this.pending.delete(work));
        });
        socket.once('close', () => {
          this.connected = false;
        });
      }),
    );
    for (const id of this.devices())
      this.tasks.push(
        this.loop('/v1/device-tunnel?id=' + encodeURIComponent(id), (socket) => {
          const peer = new OsRpcSocket(socket);
          peer.once('ready', () => this.attach(id, peer));
        }),
      );
  }
  private pending = new Set<Promise<unknown>>();
  private async loop(path: string, ready: (socket: WebSocket) => void) {
    let failures = 0;
    while (!this.abort.signal.aborted && !this.authorizationRejected) {
      try {
        await new Promise<void>((resolve) => {
          const socket = new WebSocket(this.endpoint(path), {
            headers: { Authorization: 'Bearer ' + this.cloud.connectorToken },
            maxPayload: 262144,
            perMessageDeflate: false,
            handshakeTimeout: 10000,
          });
          this.sockets.add(socket);
          socket.once('open', () => {
            failures = 0;
            ready(socket);
          });
          socket.once('unexpected-response', (_request, response) => {
            if ([401, 403].includes(response.statusCode ?? 0)) {
              this.authorizationRejected = true;
              this.lastError = 'relay_authorization_required';
            }
            response.resume();
            socket.terminate();
          });
          socket.on('error', () => {
            if (!this.authorizationRejected) this.lastError = 'relay_connection_unavailable';
          });
          socket.once('close', () => {
            this.sockets.delete(socket);
            resolve();
          });
          const stop = () => socket.terminate();
          this.abort.signal.addEventListener('abort', stop, { once: true });
          socket.once('close', () => this.abort.signal.removeEventListener('abort', stop));
        });
      } catch {
        if (!this.authorizationRejected) this.lastError = 'relay_connection_unavailable';
      }
      if (!this.abort.signal.aborted && !this.authorizationRejected)
        await delay(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), undefined, {
          signal: this.abort.signal,
        }).catch(() => {});
    }
  }
  async close() {
    this.abort.abort();
    for (const socket of this.sockets) socket.terminate();
    await Promise.allSettled([...this.tasks, ...this.pending]);
    this.connected = false;
  }
}
