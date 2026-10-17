import { TransportFailure } from './transport-failure.js';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { DeviceRpc } from './os-remote.js';
const LIMIT = 4096,
  FRAME = 1024,
  HEADER = 12;
type RpcTiming = {
  id: number;
  path: string;
  method: string;
  completed_at_ms: number;
  queue_ms: number;
  first_frame_ms: number;
  response_span_ms: number;
  round_trip_ms: number;
  total_ms: number;
  request_bytes: number;
  response_bytes: number;
  priority: 'foreground' | 'background';
};
/** A bidirectional WishOS control peer. Calls are ordered by the device event
 * loop; a disconnected or timed-out call has an unknown result, never replayed. */
export class OsRpcSocket extends EventEmitter {
  private received = 0;
  private total = 0;
  private inbound = 0;
  private buffer = Buffer.alloc(LIMIT);
  private sequence = 1;
  private calls = new Map<
    number,
    {
      resolve: (r: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
      data: Buffer;
      sent: boolean;
      queuedAt: number;
      sentAt: number;
      firstFrameAt?: number;
      path: string;
      method: string;
      priority: 'foreground' | 'background';
    }
  >();
  private inFlight = 0;
  private timings: RpcTiming[] = [];
  private pumpTask?: NodeJS.Immediate;
  private foregroundBurst = 0;
  boot = '';
  private closed = false;
  constructor(
    readonly socket: WebSocket,
    private scheduling = { maxForegroundBurst: 4 },
  ) {
    super();
    if (!Number.isSafeInteger(scheduling.maxForegroundBurst) || scheduling.maxForegroundBurst < 1)
      throw Error('rpc_scheduling_policy');
    socket.on('message', (raw, binary) => {
      try {
        if (!binary) throw Error('rpc_binary_required');
        const p = Buffer.from(raw as Buffer);
        if (p.length < HEADER || p.length > FRAME || p.toString('ascii', 0, 4) !== 'WOS1')
          throw Error('rpc_frame');
        const id = p.readUInt32LE(4),
          offset = p.readUInt16LE(8),
          total = p.readUInt16LE(10);
        if (!total || total > LIMIT || offset > total || p.length - HEADER > total - offset)
          throw Error('rpc_frame_range');
        if (!offset) {
          const active = this.calls.get(this.inFlight);
          if (this.boot && active?.sent && active.firstFrameAt === undefined)
            active.firstFrameAt = performance.now();
          this.inbound = id;
          this.received = 0;
          this.total = total;
        }
        if (id !== this.inbound || offset !== this.received || total !== this.total)
          throw Error('rpc_frame_order');
        p.copy(this.buffer, offset, HEADER);
        this.received += p.length - HEADER;
        if (this.received === total) {
          this.received = this.total = 0;
          this.message(JSON.parse(this.buffer.toString('utf8', 0, total)), total);
        }
      } catch {
        socket.close(1002, 'invalid control frame');
      }
    });
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }
  diagnostics() {
    return { request_window: 1, pending: this.calls.size, recent: this.timings.slice() };
  }
  private message(m: any, responseBytes: number) {
    if (!this.boot) {
      if (m.type !== 'hello' || m.abi !== 'wishos-rpc/1' || typeof m.boot_id !== 'string')
        throw Error('rpc_hello_required');
      this.boot = m.boot_id;
      this.emit('ready');
      return;
    }
    const call = this.calls.get(m.id);
    if (!call) return;
    const now = performance.now(),
      first = call.firstFrameAt ?? now;
    const ms = (n: number) => Math.round(n * 100) / 100;
    this.timings.push({
      id: m.id,
      path: call.path,
      method: call.method,
      completed_at_ms: Date.now(),
      queue_ms: ms(call.sentAt - call.queuedAt),
      first_frame_ms: ms(first - call.sentAt),
      response_span_ms: ms(now - first),
      round_trip_ms: ms(now - call.sentAt),
      total_ms: ms(now - call.queuedAt),
      request_bytes: call.data.length,
      response_bytes: responseBytes,
      priority: call.priority,
    });
    if (this.timings.length > 16) this.timings.shift();
    clearTimeout(call.timer);
    this.calls.delete(m.id);
    this.inFlight = 0;
    call.resolve(m);
    // Resolve the consumer first: its durable append/next-read continuation can
    // enqueue work before a queued discovery scan takes the next wire slot.
    this.schedulePump();
  }
  readonly rpc: DeviceRpc = async (path, method, args, scheduling) => {
    if (this.closed || !this.boot || this.socket.readyState !== WebSocket.OPEN)
      throw new TransportFailure('device_disconnected', false);
    if (this.calls.size >= 8) throw new TransportFailure('rpc_backpressure', false);
    const id = this.sequence++;
    const data = Buffer.from(JSON.stringify({ id, path, method, args }));
    if (data.length > LIMIT) throw new TransportFailure('rpc_message_limit', false);
    if (this.socket.bufferedAmount > 65536) throw new TransportFailure('rpc_backpressure', false);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.calls.get(id);
        if (!entry) return;
        this.calls.delete(id);
        reject(
          new TransportFailure(
            entry.sent ? 'rpc_outcome_unknown' : 'rpc_queue_timeout',
            entry.sent,
          ),
        );
        if (entry.sent) {
          this.socket.terminate();
          this.close();
        } else this.schedulePump();
      }, 10000);
      this.calls.set(id, {
        resolve,
        reject,
        timer,
        data,
        sent: false,
        queuedAt: performance.now(),
        sentAt: 0,
        path,
        method,
        priority: scheduling?.priority ?? 'foreground',
      });
      if (scheduling?.priority === 'background') this.schedulePump();
      else this.pump();
    });
  };
  private schedulePump() {
    if (this.closed || this.pumpTask) return;
    this.pumpTask = setImmediate(() => {
      this.pumpTask = undefined;
      this.pump();
    });
  }
  private pump() {
    if (this.closed || this.inFlight) return;
    const pending = [...this.calls.entries()];
    const foreground = pending.find(([, call]) => call.priority === 'foreground');
    const background = pending.find(([, call]) => call.priority === 'background');
    const next =
      background && (!foreground || this.foregroundBurst >= this.scheduling.maxForegroundBurst)
        ? background
        : foreground;
    if (!next) return;
    const [id, call] = next;
    this.foregroundBurst =
      call.priority === 'foreground' && background ? this.foregroundBurst + 1 : 0;
    this.inFlight = id;
    call.sent = true;
    call.sentAt = performance.now();
    const data = call.data;
    try {
      for (let at = 0; at < data.length; at += FRAME - HEADER) {
        const n = Math.min(FRAME - HEADER, data.length - at),
          frame = Buffer.alloc(HEADER + n);
        frame.write('WOS1');
        frame.writeUInt32LE(id, 4);
        frame.writeUInt16LE(at, 8);
        frame.writeUInt16LE(data.length, 10);
        data.copy(frame, HEADER, at, at + n);
        this.socket.send(frame, { binary: true });
      }
    } catch {
      this.socket.terminate();
      this.close();
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.pumpTask) clearImmediate(this.pumpTask);
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(
        new TransportFailure(
          call.sent ? 'rpc_outcome_unknown' : 'device_disconnected_before_dispatch',
          call.sent,
        ),
      );
    }
    this.calls.clear();
    this.emit('closed');
  }
}
