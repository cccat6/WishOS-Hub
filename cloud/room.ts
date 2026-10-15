import { dispatchPause, type DispatchRecovery } from '../src/dispatch-recovery';
import { TransportFailure } from '../src/transport-failure';
import { packageJobKinds, runPackageJob } from '../src/package-jobs';
import { guardedInvocation } from '../src/preflight-call';
import type { DeviceRpc } from '../src/os-remote';
import { cloudLuaCompiler } from './lua-compiler';
import { preflightBundle } from '../src/preflight';
import { CloudArtifacts, CloudJobStore } from './artifacts';
import { ResourceJobs } from '../src/resource-jobs';
import { canonicalValue } from '../src/control-receipts';
import { deliverBundle } from '../src/bundle-transfer';
import { DurableObject } from 'cloudflare:workers';
import { CloudError, hash, random, type Grant, type Role } from './http';
import { ControlGuard, type ControlInput, type ControlReply } from '../src/control-receipts';
import { CloudControlStore } from './control-store';
import { CloudWire } from './wire';
type Tag = {
  role: 'device' | 'connector' | 'bridge';
  device?: string;
  boot?: string;
  next?: number;
};
type Device = { id: string; label: string; issued: number; revision: number };
type Meta = {
  id: string;
  label: string;
  host: string;
  port: number;
  seed: string;
  created: number;
};
export class WishosRoom extends DurableObject<WishosCloudEnv> {
  private meta?: Meta;
  private artifacts: CloudArtifacts;
  private jobs: ResourceJobs;
  private control: ControlGuard;
  private wires = new Map<string, CloudWire>();
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(ctx: DurableObjectState, env: WishosCloudEnv) {
    super(ctx, env);
    this.artifacts = new CloudArtifacts(this.ctx.storage.sql);
    this.jobs = new ResourceJobs(new CloudJobStore(this.ctx.storage.sql));
    this.control = new ControlGuard(new CloudControlStore(this.ctx.storage.sql));
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS grants(hash TEXT PRIMARY KEY,value TEXT,expires INTEGER);CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,value TEXT);',
    );
    this.ctx.blockConcurrencyWhile(async () => {
      this.meta = await this.ctx.storage.get<Meta>('meta');
    });
    for (const socket of this.ctx.getWebSockets()) {
      const tag = socket.deserializeAttachment() as Tag;
      if (socket.readyState === WebSocket.OPEN && tag.role === 'device' && tag.device)
        this.makeWire(tag.device, socket).boot = tag.boot ?? '';
    }
  }
  async initialize(id: string, label: string, host: string, port: number, seed?: string) {
    if (this.meta) {
      if (
        !seed ||
        seed.length !== this.meta.seed.length ||
        !crypto.subtle.timingSafeEqual(
          new TextEncoder().encode(seed),
          new TextEncoder().encode(this.meta.seed),
        )
      )
        throw new CloudError(409, 'installation_exists');
    } else {
      this.meta = { id, label, host, port, seed: seed ?? random(), created: Date.now() };
      await this.ctx.storage.put('meta', this.meta);
    }
    return {
      ownerToken: await this.fixedGrant('owner'),
      connectorToken: await this.fixedGrant('connector'),
    };
  }
  private async derive(label: string) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.meta!.seed),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const data = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(label)),
    );
    return btoa(String.fromCharCode(...data))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
  }
  private async fixedGrant(role: 'owner' | 'connector') {
    const token = this.meta!.id + '.' + role + '.' + (await this.derive(role + ':1')),
      grant: Grant = { role, scopes: [role], expires: this.meta!.created + 365 * 86400000 };
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO grants VALUES(?,?,?)',
      await hash(token),
      JSON.stringify(grant),
      grant.expires,
    );
    return token;
  }

  async check(token: string, roles: Role[]) {
    const row = this.ctx.storage.sql
      .exec<{
        value: string;
      }>('SELECT value FROM grants WHERE hash=? AND expires>?', await hash(token), Date.now())
      .toArray()[0];
    if (!row) return null;
    const grant = JSON.parse(row.value) as Grant;
    return roles.includes(grant.role) ? grant : null;
  }
  async issue(grant: Grant) {
    if (!this.meta) throw new CloudError(404, 'installation_not_found');
    this.ctx.storage.sql.exec('DELETE FROM grants WHERE expires<?', Date.now());
    const token = this.meta.id + '.' + grant.role + '.' + random();
    this.ctx.storage.sql.exec(
      'INSERT INTO grants VALUES(?,?,?)',
      await hash(token),
      JSON.stringify(grant),
      grant.expires,
    );
    return token;
  }
  async rotateRefresh(token: string, client: string) {
    const row = this.ctx.storage.sql
      .exec<{
        value: string;
      }>(
        "DELETE FROM grants WHERE hash=? AND expires>? AND json_extract(value,'$.role')='refresh' AND json_extract(value,'$.client')=? RETURNING value",
        await hash(token),
        Date.now(),
        client,
      )
      .toArray()[0];
    if (!row) throw new CloudError(400, 'invalid_grant');
    return JSON.parse(row.value) as Grant;
  }

  async addDevice(id: string, label: string) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id) || !label || label.length > 64)
      throw new CloudError(400, 'device_identity');
    const existing = this.ctx.storage.sql.exec('SELECT id FROM devices WHERE id=?', id).toArray();
    if (existing.length) {
      const device = this.device(id)!;
      if (device.label !== label) throw new CloudError(409, 'device_exists');
      return { id, label };
    }
    if (this.ctx.storage.sql.exec<{ n: number }>('SELECT count(*) n FROM devices').one().n >= 32)
      throw new CloudError(409, 'device_capacity');
    this.ctx.storage.sql.exec(
      'INSERT INTO devices VALUES(?,?)',
      id,
      JSON.stringify({ id, label, issued: Date.now(), revision: 1 }),
    );
    return { id, label };
  }
  async deviceToken(id: string) {
    const device = this.device(id);
    if (!device || !this.meta) throw new CloudError(404, 'device_not_found');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.meta.seed),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const data = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id + ':' + device.revision)),
    );
    const secret = btoa(String.fromCharCode(...data))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const token = this.meta.id + '.device.' + secret,
      grant: Grant = {
        role: 'device',
        device: id,
        scopes: ['device-connect'],
        expires: device.issued + 365 * 86400000,
      };
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO grants VALUES(?,?,?)',
      await hash(token),
      JSON.stringify(grant),
      grant.expires,
    );
    return token;
  }

  private device(id: string) {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM devices WHERE id=?', id)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as Device) : undefined;
  }
  private sockets(role: Tag['role'], device?: string) {
    return this.ctx.getWebSockets().filter((s) => {
      if (s.readyState !== WebSocket.OPEN) return false;
      const t = s.deserializeAttachment() as Tag;
      return t.role === role && (device === undefined || t.device === device);
    });
  }
  private makeWire(id: string, socket: WebSocket) {
    this.wires.get(id)?.close();
    const wire = new CloudWire(
      (bytes) => socket.send(bytes),
      () => {
        const tag = socket.deserializeAttachment() as Tag;
        const id = tag.next ?? (crypto.getRandomValues(new Uint32Array(1))[0]! || 1);
        socket.serializeAttachment({ ...tag, next: id + 1 });
        return id;
      },
      () => socket.close(1011, 'RPC reply timeout'),
    );
    this.wires.set(id, wire);
    return wire;
  }

  async profile(device: string) {
    if (!this.device(device) || !this.meta) throw new CloudError(404, 'device_not_found');
    const token = await this.deviceToken(device),
      relay = new URL(this.env.RELAY_ORIGIN);
    return {
      device_id: device,
      connector_id: this.meta.id,
      token,
      link: {
        enabled: true,
        endpoints: [
          {
            id: 'lan',
            host: this.meta.host,
            port: this.meta.port,
            path: '/os/device?id=' + encodeURIComponent(device),
            tls: false,
            headers: { Authorization: 'Bearer ' + token },
          },
          {
            id: 'relay',
            host: relay.hostname,
            port: Number(relay.port) || 443,
            path: '/os/device?id=' + encodeURIComponent(device),
            tls: relay.protocol === 'https:',
            verify_peer: true,
            headers: { Authorization: 'Bearer ' + token },
          },
        ],
      },
    };
  }
  async publicStatus() {
    return {
      installation_id: this.meta?.id,
      label: this.meta?.label,
      connector_online: this.sockets('connector').length > 0,
      devices: this.ctx.storage.sql
        .exec<{ value: string }>('SELECT value FROM devices ORDER BY id')
        .toArray()
        .map((r) => ({
          ...JSON.parse(r.value),
          online: Boolean(this.wires.get((JSON.parse(r.value) as Device).id)?.boot),
        })),
      credentials: 'user_host',
      transcript_storage: false,
    };
  }
  async remove() {
    for (const s of this.ctx.getWebSockets()) s.close(1000, 'installation removed');
    for (const wire of this.wires.values()) wire.close();
    this.wires.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error('connector_disconnected'));
    }
    this.pending.clear();
    await this.jobs.close();
    await this.ctx.storage.deleteAll();
    this.meta = undefined;
  }
  async fetch(request: Request) {
    const url = new URL(request.url),
      token = request.headers.get('Authorization')?.slice(7) ?? '',
      role =
        url.pathname === '/os/device'
          ? 'device'
          : url.pathname === '/v1/device-tunnel'
            ? 'bridge'
            : 'connector';
    const id = url.searchParams.get('id') ?? '';
    const grant = await this.check(token, role === 'device' ? ['device'] : ['connector']);
    if (
      !grant ||
      (role === 'device' && grant.device !== id) ||
      (role !== 'connector' && !this.device(id))
    )
      return new Response('Unauthorized', { status: 401 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('WebSocket required', { status: 426 });
    if (role === 'connector' && [...this.wires.values()].some((w) => w.busy))
      return new Response('Route operation in progress', { status: 409 });
    if (role === 'device' && this.sockets('connector').length && !this.sockets('bridge', id).length)
      return new Response('Connector preparing route', { status: 503 });
    const pair = new WebSocketPair(),
      client = pair[0],
      socket = pair[1];
    const tag: Tag = { role, ...(role !== 'connector' ? { device: id } : {}) };
    socket.serializeAttachment(tag);
    this.ctx.acceptWebSocket(socket);
    for (const previous of this.sockets(role, role === 'connector' ? undefined : id))
      if (previous !== socket) previous.close(1000, 'connection replaced');
    if (role === 'connector') {
      for (const wire of this.wires.values()) wire.close();
      this.wires.clear();
      for (const previous of this.sockets('device')) previous.close(1001, 'connector route ready');
    }
    if (role === 'device' && !this.sockets('connector').length) this.makeWire(id, socket);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const tag = socket.deserializeAttachment() as Tag;
    try {
      if (tag.role === 'connector') {
        if (typeof message !== 'string' || message.length > 262144) throw Error('control_frame');
        const m = JSON.parse(message);
        if (m.kind !== 'response' || typeof m.id !== 'string') throw Error('control_frame');
        const p = this.pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        m.error
          ? p.reject(new TransportFailure('connector_outcome_unknown', true))
          : p.resolve(m.result);
        return;
      }
      if (typeof message === 'string' || message.byteLength > 1024) throw Error('device_frame');
      if (tag.role === 'bridge') {
        const device = this.sockets('device', tag.device)[0];
        if (!device) {
          socket.close(1013, 'device offline');
          return;
        }
        device.send(message);
        return;
      }
      const bridge = this.sockets('bridge', tag.device)[0];
      if (this.sockets('connector').length) {
        if (!bridge) {
          socket.close(1013, 'route preparing');
          return;
        }
        bridge.send(message);
      } else {
        const wire = this.wires.get(tag.device!) ?? this.makeWire(tag.device!, socket);
        wire.message(message);
        if (wire.boot && !tag.boot) socket.serializeAttachment({ ...tag, boot: wire.boot });
      }
    } catch {
      socket.close(1002, 'invalid frame');
    }
  }
  async webSocketClose(socket: WebSocket) {
    const tag = socket.deserializeAttachment() as Tag;
    if (tag.role === 'device') {
      if (this.sockets('device', tag.device).some((s) => s !== socket)) return;
      this.wires.get(tag.device!)?.close();
      this.wires.delete(tag.device!);
      for (const s of this.sockets('bridge', tag.device)) s.close(1001, 'device disconnected');
    }
    if (tag.role === 'bridge' && !this.sockets('bridge', tag.device).length)
      for (const s of this.sockets('device', tag.device))
        s.close(1001, 'connector tunnel disconnected');
    if (tag.role === 'connector') {
      if (this.sockets('connector').some((s) => s !== socket)) return;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new TransportFailure('connector_outcome_unknown', true));
      }
      this.pending.clear();
      for (const s of [...this.sockets('device'), ...this.sockets('bridge')])
        s.close(1001, 'connector disconnected');
    }
  }
  async webSocketError(socket: WebSocket) {
    socket.close(1011, 'connection error');
    await this.webSocketClose(socket);
  }
  private host(path: string, payload?: unknown) {
    const socket = this.sockets('connector')[0];
    if (!socket) throw new TransportFailure('connector_offline', false);
    if (this.pending.size >= 16) throw new CloudError(429, 'connector_capacity');
    const id = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CloudError(504, 'connector_outcome_unknown'));
        socket.close(1001, 'host request timeout');
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(
          JSON.stringify({
            kind: 'request',
            id,
            path,
            ...(payload === undefined ? {} : { body: payload }),
          }),
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async alarm() {
    this.artifacts.cleanup();
    if (this.ctx.storage.sql.exec<{ n: number }>('SELECT count(*) n FROM artifacts').one().n)
      await this.ctx.storage.setAlarm(Date.now() + 3600000);
  }
  async api(path: string, payload?: unknown): Promise<unknown> {
    if (path === '/api/service')
      return {
        format: 'wishos-hub/1',
        deployment: 'cloud',
        resources: {
          maxFileBytes: this.artifacts.maxFile,
          maxStoredBytes: this.artifacts.maxRoom,
          ttlMs: 3600000,
          packagePreflight: true,
          staging: true,
          delivery: true,
        },
        session_owner: 'selected-runtime',
        direct_model_api: false,
      };
    if (path === '/api/os/jobs/read' || path === '/api/os/jobs/cancel') {
      const v = payload as any;
      if (typeof v?.id !== 'string') throw new CloudError(400, 'resource_job_identity');
      return path.endsWith('/read') ? this.jobs.read(v.id) : this.jobs.cancel(v.id);
    }
    if (path === '/api/os/jobs') {
      const v = payload as any;
      if (
        !v ||
        !['stage', 'image', 'deliver', ...packageJobKinds].includes(v.kind) ||
        !v.input ||
        typeof v.input !== 'object'
      )
        throw new CloudError(400, 'resource_job_request');
      if (v.input.device_id && !this.device(v.input.device_id))
        throw new CloudError(404, 'device_not_found');
      if (v.kind === 'image') throw new CloudError(409, 'image_preparation_requires_user_host');
      if (
        v.kind === 'deliver' &&
        (!this.device(v.input.device_id) ||
          !Array.isArray(v.input.files) ||
          typeof v.input.expected_boot_id !== 'string')
      )
        throw new CloudError(400, 'resource_delivery_request');
      const id = v.request_id ?? crypto.randomUUID();
      if (typeof id !== 'string' || !id.match(/^[A-Za-z0-9_.:-]{1,128}$/))
        throw new CloudError(400, 'resource_job_identity');
      const fingerprint = await hash(canonicalValue({ kind: v.kind, input: v.input }));
      const rpcFor =
        (deviceId: string): DeviceRpc =>
        async (path, method, args) => {
          const reply = await this.api(
            '/api/os/devices/' + encodeURIComponent(deviceId) + '/invoke',
            {
              path,
              method,
              args,
              expected_boot_id: v.input.expected_boot_id,
              request_id: crypto.randomUUID(),
            },
          );
          return reply as ControlReply;
        };
      const job = this.jobs.submit(id, fingerprint, v.kind, (signal) =>
        v.kind === 'stage'
          ? this.artifacts.stage(v.input, signal)
          : packageJobKinds.includes(v.kind)
            ? runPackageJob(v.kind, v.input, {
                source: this.artifacts,
                stage: (text, signal) => this.artifacts.stage({ text }, signal),
                compiler: cloudLuaCompiler,
                rpc: rpcFor,
                signal,
              })
            : deliverBundle(
                rpcFor(v.input.device_id),
                v.input.files,
                signal,
                v.input.expected_boot_id,
                undefined,
                this.artifacts,
                { compiler: cloudLuaCompiler },
              ),
      );
      this.ctx.waitUntil(this.jobs.wait(id));
      await this.ctx.storage.setAlarm(Date.now() + 3600000);
      return job;
    }
    const invoke = path.match(/^\/api\/os\/devices\/([A-Za-z0-9_.:-]+)\/invoke$/),
      state = path.match(/^\/api\/devices\/([A-Za-z0-9_.:-]+)\/(state|usage|tools)$/);
    if (path === '/api/os/receipts/read') {
      const input = payload as any;
      if (
        !input ||
        !['device_id', 'boot_id', 'request_id'].every((k) => typeof input[k] === 'string') ||
        !this.device(input.device_id)
      )
        throw new CloudError(400, 'receipt_identity');
      return this.control.read(input.device_id, input.boot_id, input.request_id);
    }
    if (path !== '/api/devices' && path !== '/api/os/artifacts' && !invoke && !state)
      throw new CloudError(404, 'resource_not_found');
    const id = invoke?.[1] ?? state?.[1];
    if (id && !this.device(id)) throw new CloudError(404, 'device_not_found');
    if (invoke) {
      const input = payload as ControlInput;
      if (
        !input ||
        Object.keys(input).some(
          (k) => !['path', 'method', 'args', 'request_id', 'expected_boot_id'].includes(k),
        ) ||
        typeof input.path !== 'string' ||
        typeof input.method !== 'string' ||
        !input.args ||
        typeof input.args !== 'object' ||
        Array.isArray(input.args)
      )
        throw new CloudError(400, 'resource_request');
      const raw = async (p: ControlInput): Promise<ControlReply> => {
        if (this.sockets('connector').length) return (await this.host(path, p)) as ControlReply;
        const wire = this.wires.get(id!);
        if (!wire?.ready) throw new TransportFailure('device_not_ready', false);
        return wire.rpc(p.path, p.method, {
          ...p.args,
          ...(p.expected_boot_id ? { expected_boot_id: p.expected_boot_id } : {}),
        });
      };
      const expected = input.expected_boot_id ?? this.wires.get(id!)?.boot;
      const recovery: DispatchRecovery | undefined = expected
        ? {
            wait: async (deadline) => {
              while (Date.now() < deadline) {
                const current = this.wires.get(id!);
                if (current?.boot && current.boot !== expected)
                  throw new TransportFailure('device_boot_changed_before_dispatch', false);
                if (current?.ready || this.sockets('connector').length) {
                  await dispatchPause();
                  return;
                }
                await dispatchPause();
              }
              throw new TransportFailure('device_disconnected_before_dispatch', false);
            },
          }
        : undefined;
      return this.control.invoke(
        id!,
        input,
        () =>
          raw({
            path: '/sys/capabilities',
            method: 'describe',
            args: { path: input.path },
            expected_boot_id: input.expected_boot_id,
          }),
        () =>
          guardedInvocation(
            (path, method, args) =>
              raw({
                path,
                method,
                args,
                expected_boot_id: input.expected_boot_id,
                request_id:
                  path === input.path && method === input.method
                    ? input.request_id
                    : crypto.randomUUID(),
              }),
            cloudLuaCompiler,
            input.path,
            input.method,
            input.args,
            AbortSignal.timeout(30000),
            expected ?? '',
            recovery,
          ),
        recovery,
      );
    }
    if (this.sockets('connector').length) return this.host(path, payload);
    if (path === '/api/devices') return (await this.publicStatus()).devices;
    if (state) {
      if (state[2] !== 'state') throw new CloudError(503, 'user_runtime_required');
      return {
        device_id: id,
        online: Boolean(this.wires.get(id!)?.boot),
        boot_id: this.wires.get(id!)?.boot ?? null,
        transport: 'relay',
        harness_capabilities: {},
        connector_online: false,
      };
    }
    throw new CloudError(503, 'user_resource_service_required');
  }
}
