import { TransportFailure } from '../src/transport-failure';
type Reply = { id: number; ok: boolean; boot_id: string; error?: string; result: unknown };
type Pending = {
  id: number;
  data: Uint8Array;
  sent: boolean;
  resolve: (value: Reply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class CloudWire {
  private input = new Uint8Array(4096);
  private offset = 0;
  private total = 0;
  private frameId = 0;
  private pending = new Map<number, Pending>();
  private inFlight = 0;
  private closed = false;
  boot = '';
  constructor(
    private send: (bytes: Uint8Array) => void,
    private nextId: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]!,
    private fatal: () => void = () => {},
  ) {}
  message(bytes: ArrayBuffer) {
    const p = new Uint8Array(bytes),
      view = new DataView(bytes);
    if (p.length < 12 || p.length > 1024 || new TextDecoder().decode(p.subarray(0, 4)) !== 'WOS1')
      throw Error('rpc_frame');
    const id = view.getUint32(4, true),
      offset = view.getUint16(8, true),
      total = view.getUint16(10, true);
    if (!total || total > 4096 || offset + p.length - 12 > total) throw Error('rpc_range');
    if (!offset) {
      this.offset = 0;
      this.total = total;
      this.frameId = id;
    }
    if (this.offset !== offset || this.total !== total || this.frameId !== id)
      throw Error('rpc_order');
    this.input.set(p.subarray(12), offset);
    this.offset += p.length - 12;
    if (this.offset === this.total) {
      const message = JSON.parse(new TextDecoder().decode(this.input.subarray(0, total)));
      this.offset = this.total = 0;
      if (!this.boot) {
        if (
          message.type !== 'hello' ||
          message.abi !== 'wishos-rpc/1' ||
          typeof message.boot_id !== 'string'
        )
          throw Error('rpc_hello');
        this.boot = message.boot_id;
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        this.inFlight = 0;
        pending.resolve(message);
        this.pump();
      }
    }
  }
  async rpc(path: string, method: string, args: Record<string, unknown>) {
    if (this.closed || !this.boot) throw new TransportFailure('device_not_ready', false);
    if (this.pending.size >= 8) throw new TransportFailure('rpc_backpressure', false);
    const id = this.nextId();
    if (!id || id > 0xffffffff) throw new TransportFailure('rpc_id_exhausted', false);
    const data = new TextEncoder().encode(JSON.stringify({ id, path, method, args }));
    if (data.length > 4096) throw new TransportFailure('rpc_message_limit', false);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        reject(
          new TransportFailure(
            entry.sent ? 'rpc_outcome_unknown' : 'rpc_queue_timeout',
            entry.sent,
          ),
        );
        if (entry.sent) {
          this.close();
          this.fatal();
        }
      }, 10000);
      this.pending.set(id, { id, data, sent: false, resolve, reject, timer });
      this.pump();
    });
  }
  private pump() {
    if (this.closed || this.inFlight) return;
    const call = this.pending.values().next().value;
    if (!call) return;
    this.inFlight = call.id;
    call.sent = true;
    try {
      for (let offset = 0; offset < call.data.length; offset += 1012) {
        const n = Math.min(1012, call.data.length - offset),
          frame = new Uint8Array(12 + n),
          view = new DataView(frame.buffer);
        frame.set(new TextEncoder().encode('WOS1'));
        view.setUint32(4, call.id, true);
        view.setUint16(8, offset, true);
        view.setUint16(10, call.data.length, true);
        frame.set(call.data.subarray(offset, offset + n), 12);
        this.send(frame);
      }
    } catch {
      this.close();
      this.fatal();
    }
  }
  get ready() {
    return !this.closed && !!this.boot;
  }
  get busy() {
    return this.pending.size > 0;
  }
  close() {
    this.closed = true;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(
        new TransportFailure(
          call.sent ? 'rpc_outcome_unknown' : 'device_disconnected_before_dispatch',
          call.sent,
        ),
      );
    }
    this.pending.clear();
    this.inFlight = 0;
    this.boot = '';
  }
}
