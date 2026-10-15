import { WebSocket } from 'ws';
import { once } from 'node:events';
export function frames(value: unknown, id = 1) {
  const bytes = Buffer.from(JSON.stringify(value)),
    result: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 1012) {
    const n = Math.min(1012, bytes.length - offset),
      frame = Buffer.alloc(12 + n);
    frame.write('WOS1');
    frame.writeUInt32LE(id, 4);
    frame.writeUInt16LE(offset, 8);
    frame.writeUInt16LE(bytes.length, 10);
    bytes.copy(frame, 12, offset, offset + n);
    result.push(frame);
  }
  return result;
}
export class WireDevice {
  socket!: WebSocket;
  calls: any[] = [];
  writes = 0;
  boot = 'fixture-boot';
  descriptions: Record<string, any> = {};
  board?: Record<string, unknown>;
  resourceHandler?: (call: any) => Promise<unknown> | unknown;
  handler?: (call: any) => Promise<unknown> | unknown;
  private bytes = Buffer.alloc(4096);
  private total = 0;
  private received = 0;
  private id = 0;
  private frameId = 1;
  async connect(url: string, token: string) {
    const socket = (this.socket = new WebSocket(url, {
      headers: { Authorization: 'Bearer ' + token },
    }));
    socket.on('error', () => {});
    await once(socket, 'open');
    for (const frame of frames(
      { type: 'hello', abi: 'wishos-rpc/1', boot_id: this.boot },
      this.frameId++,
    ))
      socket.send(frame);
    socket.on('message', (raw) => {
      const p = Buffer.from(raw as Buffer),
        id = p.readUInt32LE(4),
        offset = p.readUInt16LE(8),
        total = p.readUInt16LE(10);
      if (!offset) {
        this.id = id;
        this.total = total;
        this.received = 0;
      }
      if (id !== this.id || offset !== this.received || total !== this.total)
        throw Error('fixture frame order');
      p.copy(this.bytes, offset, 12);
      this.received += p.length - 12;
      if (this.received !== this.total) return;
      const call = JSON.parse(this.bytes.toString('utf8', 0, total));
      this.received = this.total = 0;
      this.calls.push(call);
      void this.respond(call, socket, this.boot);
    });
    return this;
  }
  private async respond(call: any, socket: WebSocket, boot: string) {
    let result: any = {};
    let ok = true,
      error: string | undefined;
    if (call.args?.expected_boot_id && call.args.expected_boot_id !== this.boot) {
      ok = false;
      error = 'boot_changed';
    } else if (call.path === '/sys/capabilities' && call.method === 'describe')
      result =
        this.descriptions[call.args.path] ??
        (call.args.path === '/sys/capabilities'
          ? { path: '/sys/capabilities', methods: 'list,describe', read_methods: 'list,describe' }
          : call.args.path === '/services/ai'
            ? {
                request_format: 'wishos-ai/2',
                result_format: 'wishos-result/2',
                action_limit_bytes: 2048,
                inline_result_limit_bytes: 1536,
                methods: 'read,submit',
                read_methods: 'read',
              }
            : { path: call.args.path, methods: 'read,write', read_methods: 'read' });
    else if (call.path === '/sys/capabilities')
      result = {
        devices: [{ path: '/dev/fixture', methods: 'read,write', read_methods: 'read' }],
        more: false,
      };
    else if (call.path === '/services/remote') result = { state: 'empty' };
    else if (call.path === '/sys/board')
      result = this.board ?? { board: 'fixture', mac: '02:00:00:00:00:01' };
    else if (call.path === '/dev/fixture') {
      if (call.method === 'write') ++this.writes;
      if (this.handler) {
        const value = await this.handler(call);
        if (value === undefined) return;
        result = value;
      } else result = { writes: this.writes };
    } else if (this.resourceHandler) result = await this.resourceHandler(call);
    else {
      ok = false;
      error = 'not_found';
    }
    if (socket.readyState === WebSocket.OPEN)
      for (const frame of frames(
        { id: call.id, boot_id: boot, ok, ...(error ? { error } : {}), result },
        this.frameId++,
      ))
        socket.send(frame);
  }
  async close() {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      const closed = once(this.socket, 'close');
      this.socket.terminate();
      await closed;
    }
  }
}
export async function eventually<T>(check: () => Promise<T | undefined | false>, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('condition timeout');
}
/** Filesystem-free model of the public transfer protocol for socket tests. */
export class TransferFixture {
  received = Buffer.alloc(0);
  committed = false;
  expectedHash = '';
  call(call: any) {
    if (call.path === '/fs' && call.method === 'mounts') return { providers: [] };
    if (call.path !== '/sys/transfers') throw Error('fixture_resource');
    switch (call.method) {
      case 'read':
        return { policy: { targets: [] } };
      case 'begin':
        this.received = Buffer.alloc(0);
        this.committed = false;
        return { id: 1, chunk_bytes: 128, files_complete: 0, state: 'receiving' };
      case 'file':
        this.expectedHash = call.args.sha256;
        return { file_offset: 0 };
      case 'chunk':
        assertOffset(call.args.offset, this.received.length);
        this.received = Buffer.concat([this.received, Buffer.from(call.args.hex, 'hex')]);
        return {};
      case 'close_file':
        return {};
      case 'commit':
        this.committed = true;
        return { root: '/card/transfers/test' };
      case 'abort':
        return { aborted: true };
      default:
        throw Error('fixture_method');
    }
  }
}
function assertOffset(value: string, expected: number) {
  if (Number(value) !== expected) throw Error('fixture_transfer_offset');
}
