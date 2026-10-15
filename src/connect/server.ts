import { ResourceJobs } from '../resource-jobs.js';
import { HostJobStore } from './job-store.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { access, writeFile, readFile, mkdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, delimiter, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { ControlGuard, type ControlInput } from '../control-receipts.js';
import { HostControlStore } from './control-store.js';
import { Store } from '../store.js';
import { Hub, type DeviceConfig } from '../hub.js';
import { OsRpcSocket } from '../os-rpc-socket.js';
import { McpHttp } from '../mcp-http.js';
import { hubApi } from '../hub-api.js';
import { boundedJson } from '../adapters/runner-http.js';
import {
  ConfigStore,
  ConnectorConfig,
  RuntimeConfig,
  devicePairingToken,
  token,
  type DeviceBinding,
} from './config.js';
import { createRuntime, UnboundRuntime } from './runtime.js';
import { DeviceRoutes } from './routes.js';
import { ConnectorDiscovery, connectorHostname } from './mdns.js';
import { ConnectorRelay } from './relay.js';
import { runtimeCatalog, runtimeDescription } from './catalog.js';
import { clientConfigurations } from './mcp-config.js';
import { LocalSecrets } from './secrets.js';
import { LocalSpeechConfig, resolveSpeech } from './speech.js';
import { setupPage, setupScript } from './setup-page.js';
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const same = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const local = (req: IncomingMessage) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
const reply = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function requestBody(req: IncomingMessage) {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const data of req) {
    length += data.length;
    if (length > 262144) throw new ApiError(413, 'request_limit');
    chunks.push(Buffer.from(data));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
}
function allowedApi(path: string) {
  return (
    path === '/api/devices' ||
    path === '/api/service' ||
    path === '/api/os/receipts/read' ||
    path === '/api/os/jobs' ||
    path === '/api/os/jobs/read' ||
    path === '/api/os/jobs/cancel' ||
    path === '/api/os/artifacts' ||
    path === '/api/os/artifacts/upload' ||
    /^\/api\/os\/devices\/[A-Za-z0-9_.:-]+\/invoke$/.test(path) ||
    /^\/api\/devices\/[A-Za-z0-9_.:-]+\/(state|usage|tools)$/.test(path)
  );
}
async function executable(command: string) {
  const candidates =
    command.includes('/') || command.includes('\\')
      ? [command]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .flatMap((dir) =>
            process.platform === 'win32'
              ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT')
                  .split(';')
                  .map((ext) => join(dir, command + ext))
              : [join(dir, command)],
          );
  for (const path of candidates)
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {}
  return false;
}
export class ConnectorServer {
  readonly http = createServer((req, res) => {
    void this.handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const e = error as Error & { status?: number };
      reply(res, e.status ?? 400, {
        error: e.name === 'ZodError' ? 'invalid_configuration' : e.message,
      });
    });
  });
  private ws = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  private mcp = new McpHttp();
  private discovery = new ConnectorDiscovery();
  private relay?: ConnectorRelay;
  private config!: ConnectorConfig;
  private applying = false;
  private changing = false;
  private admissions = 0;
  private hub?: Hub;
  private store?: Store;
  private secrets!: LocalSecrets;
  private jobs?: ResourceJobs;
  private control?: ControlGuard;
  private controlStore?: HostControlStore;
  private hubBase = '';
  private internalToken = token();
  private cookie = token();
  private routes = new Map<string, DeviceRoutes>();
  private lockFile?: string;
  private ownsLock = false;
  private port = 0;
  private closing = false;
  private stop = new AbortController();
  private operations = new Set<Promise<unknown>>();
  constructor(
    readonly settings: ConfigStore,
    private options: { mdns?: boolean; entry?: string } = {},
  ) {}
  async start() {
    this.config = await this.settings.load();
    await this.lock();
    this.secrets = new LocalSecrets(this.settings.root);
    await this.secrets.load();
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost'),
        id = url.searchParams.get('id') ?? '',
        device = this.config.devices.find((d) => d.id === id);
      if (
        this.closing ||
        this.applying ||
        url.pathname !== '/os/device' ||
        !device ||
        req.headers.origin ||
        !same(req.headers.authorization ?? '', 'Bearer ' + device.token)
      ) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      this.ws.handleUpgrade(req, socket, head, (ws) => {
        const peer = new OsRpcSocket(ws),
          deadline = setTimeout(() => ws.close(1008, 'hello required'), 10000);
        peer.once('ready', () => {
          clearTimeout(deadline);
          this.attach(id, 'lan', peer);
        });
        peer.once('closed', () => clearTimeout(deadline));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.config.port, this.config.host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    this.port = (this.http.address() as { port: number }).port;
    this.store = new Store(join(this.settings.root, 'user-state.sqlite'));
    this.jobs = new ResourceJobs(new HostJobStore(this.store.db));
    this.controlStore = new HostControlStore(this.store.db);
    this.control = new ControlGuard(this.controlStore);
    await this.apply(this.config, false);
    await writeFile(
      join(this.settings.root, 'running.json'),
      JSON.stringify({ pid: process.pid, id: this.config.id, port: this.port }) + '\n',
      { mode: 0o600 },
    );
    if (this.config.mdns && this.options.mdns !== false)
      this.discovery.start(this.config.id, this.port);
    return { port: this.port, url: 'http://127.0.0.1:' + this.port };
  }
  private async lock() {
    this.lockFile = join(this.settings.root, 'connector.lock');
    await mkdir(this.settings.root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.lockFile, JSON.stringify({ pid: process.pid }), {
        flag: 'wx',
        mode: 0o600,
      });
      this.ownsLock = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number;
      try {
        pid = JSON.parse(await readFile(this.lockFile, 'utf8')).pid;
      } catch {
        throw new ApiError(409, 'connector_lock_invalid');
      }
      try {
        process.kill(pid, 0);
        throw new ApiError(409, 'connector_already_running');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
      await unlink(this.lockFile);
      await writeFile(this.lockFile, JSON.stringify({ pid: process.pid }), {
        flag: 'wx',
        mode: 0o600,
      });
      this.ownsLock = true;
    }
  }
  private attach(id: string, name: 'lan' | 'relay', peer: OsRpcSocket) {
    const route = this.routes.get(id);
    if (!route) {
      peer.socket.close(1008, 'device not configured');
      return;
    }
    const detach = route.attach(name, peer.rpc, peer.boot, () => peer.socket.terminate());
    peer.once('closed', detach);
  }
  private async apply(next: ConnectorConfig, persist = true) {
    if (
      this.applying ||
      Boolean(this.jobs?.activeCount) ||
      this.hub?.hasActiveWork() ||
      [...this.routes.values()].some((r) => r.busy)
    )
      throw new ApiError(409, 'active_operations_finish_first');
    this.applying = true;
    let candidate: Hub | undefined;
    try {
      const configPath = join(this.settings.root, 'wishos-mcp.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            wishos: {
              type: 'http',
              url: 'http://127.0.0.1:' + this.port + '/mcp',
              headers: { Authorization: 'Bearer ' + next.localToken },
            },
          },
        }),
        { mode: 0o600 },
      );
      const adapters = new Map(
        next.runtimes.map((r) => [
          r.id,
          createRuntime(r, {
            url: 'http://127.0.0.1:' + this.port + '/mcp',
            token: next.localToken,
            mcpConfig: configPath,
          }),
        ]),
      );
      const devices: DeviceConfig[] = next.devices.map((d) => ({
        id: d.id,
        token: d.token,
        runtimeId: d.runtimeId,
        sessionId: d.sessionId,
        adapter: d.runtimeId ? adapters.get(d.runtimeId)! : new UnboundRuntime(),
      }));
      candidate = new Hub({
        resourceJobs: this.jobs!,
        devices,
        adminToken: this.internalToken,
        store: this.store!,
        artifactRoot: join(this.settings.root, 'artifacts'),
        artifactMaxBytes: next.resources.maxFileBytes,
        artifactPolicy: {
          maxStoredBytes: next.resources.maxStoredBytes,
          ttlMs: next.resources.ttlMs,
        },
        speech: resolveSpeech(next.speech, this.secrets).applied,
      });
      const address = (await candidate.listen(0, '127.0.0.1')) as { port: number };
      if (persist) await this.settings.save(next);
      await this.relay?.close();
      this.relay = undefined;
      for (const route of this.routes.values()) route.close();
      this.routes.clear();
      await this.hub?.close();
      this.hub = candidate;
      candidate = undefined;
      this.hubBase = 'http://127.0.0.1:' + address.port;
      this.config = next;
      for (const d of next.devices) {
        const routes = new DeviceRoutes(d.id);
        this.routes.set(d.id, routes);
        this.hub.bindDeviceRpc(d.id, async (path, method, args) => {
          if (this.applying || this.changing) throw Error('connector_configuration_pending');
          return routes.rpc(path, method, args);
        });
      }
      this.startRelay();
    } catch (error) {
      await candidate?.close();
      throw error;
    } finally {
      this.applying = false;
    }
  }
  private startRelay() {
    if (!this.config.cloud || this.closing) return;
    this.relay = new ConnectorRelay(
      this.config.cloud,
      () => this.config.devices.map((d) => d.id),
      (path, body) => this.api(path, body),
      (id, peer) => this.attach(id, 'relay', peer),
    );
    this.relay.start();
  }
  private api(path: string, payload?: unknown) {
    const work = this.dispatchApi(path, payload);
    this.operations.add(work);
    void work.finally(() => this.operations.delete(work)).catch(() => {});
    return work;
  }
  private async dispatchApi(path: string, payload?: unknown) {
    if (!allowedApi(path)) throw new ApiError(404, 'resource_not_found');
    if (this.closing || this.applying || this.changing)
      throw new ApiError(503, 'configuration_pending');
    ++this.admissions;
    try {
      if (path === '/api/service')
        return {
          format: 'wishos-hub/1',
          deployment: 'user-host',
          resources: {
            ...this.config.resources,
            imagePreparation: true,
            packagePreflight: true,
            formats: ['png', 'rgb8', 'indexed8'],
          },
          session_owner: 'selected-runtime',
          direct_model_api: false,
        };
      if (path === '/api/os/jobs/read' || path === '/api/os/jobs/cancel') {
        const { id } = payload as any;
        if (typeof id !== 'string') throw new ApiError(400, 'resource_job_identity');
        return path.endsWith('/read') ? this.jobs!.read(id) : this.jobs!.cancel(id);
      }
      if (path === '/api/os/jobs') {
        return this.hub!.submitResourceJob(payload);
      }
      if (path === '/api/os/receipts/read') {
        const input = payload as any;
        if (
          !input ||
          !['device_id', 'boot_id', 'request_id'].every((k) => typeof input[k] === 'string')
        )
          throw new ApiError(400, 'receipt_identity');
        if (!this.config.devices.some((d) => d.id === input.device_id))
          throw new ApiError(404, 'device_not_found');
        return this.control!.read(input.device_id, input.boot_id, input.request_id);
      }
      const invoke = path.match(/^\/api\/os\/devices\/([A-Za-z0-9_.:-]+)\/invoke$/);
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
          throw new ApiError(400, 'resource_request');
        const guard = input.expected_boot_id ? { expected_boot_id: input.expected_boot_id } : {};
        return await this.control!.invoke(
          invoke[1]!,
          input,
          () =>
            this.hub!.invokeDevice(invoke[1]!, '/sys/capabilities', 'describe', {
              path: input.path,
              ...guard,
            }),
          () =>
            this.hub!.invokeDevice(invoke[1]!, input.path, input.method, {
              ...input.args,
              ...guard,
            }),
          this.hub!.deviceRecovery(invoke[1]!, input.expected_boot_id),
        );
      }
      const result = await hubApi(
        this.hubBase,
        this.internalToken,
        this.stop.signal,
      )(path, payload);
      const data = JSON.parse(result.content[0]!.text);
      const annotate = (value: any) => ({
        ...value,
        route: this.routes.get(value.device_id)?.status(),
      });
      return path === '/api/devices'
        ? data.map(annotate)
        : path.endsWith('/state')
          ? annotate(data)
          : data;
    } finally {
      --this.admissions;
    }
  }
  private authorized(req: IncomingMessage) {
    return same(req.headers.authorization ?? '', 'Bearer ' + this.config.localToken);
  }
  private browser(req: IncomingMessage) {
    if (
      !local(req) ||
      !same(
        (req.headers.cookie ?? '')
          .split(';')
          .map((x) => x.trim())
          .find((x) => x.startsWith('wishos_session='))
          ?.slice(15) ?? '',
        this.cookie,
      )
    )
      throw new ApiError(401, 'local_setup_required');
    const origin = req.headers.origin;
    if (
      origin &&
      ![
        'http://127.0.0.1:' + this.port,
        'http://localhost:' + this.port,
        'http://[::1]:' + this.port,
      ].includes(origin)
    )
      throw new ApiError(403, 'origin_rejected');
  }
  private async cloud(path: string, payload?: unknown, configured = this.config.cloud) {
    if (!configured) throw new ApiError(409, 'cloud_not_configured');
    return boundedJson(
      await fetch(new URL(path, configured.endpoint), {
        method: payload === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + configured.ownerToken,
          'Content-Type': 'application/json',
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      }),
    );
  }
  private profile(d: DeviceBinding) {
    const headers = { Authorization: 'Bearer ' + d.token },
      lan = {
        id: 'lan',
        host: connectorHostname(this.config.id).trim(),
        port: this.port,
        path: '/os/device?id=' + encodeURIComponent(d.id),
        tls: false,
        headers,
      };
    const endpoints: any[] = [lan];
    if (this.config.cloud) {
      const u = new URL(this.config.cloud.relayEndpoint ?? this.config.cloud.endpoint);
      endpoints.push({
        id: 'relay',
        host: u.hostname,
        port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
        path: lan.path,
        tls: u.protocol === 'https:',
        verify_peer: true,
        headers,
      });
    }
    return {
      device_id: d.id,
      link: {
        enabled: true,
        endpoints,
        attempt_timeout_ms: 20000,
        retry_ms: 5000,
        probe_interval_ms: 60000,
        idle_ms: 250,
      },
      proxy_note:
        'Preserve explicit proxy bypass rules; add .local or this LAN hostname when using a proxy.',
    };
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/healthz') {
      reply(res, 200, {
        ok: true,
        id: this.config?.id,
        service: 'wishos-connector',
        configuration_pending: this.applying,
      });
      return;
    }
    if (path === '/' && req.method === 'GET') {
      if (!local(req)) throw new ApiError(403, 'setup_is_local');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': 'wishos_session=' + this.cookie + '; HttpOnly; SameSite=Strict; Path=/',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(setupPage);
      return;
    }
    if (path === '/setup.js' && req.method === 'GET') {
      this.browser(req);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(setupScript);
      return;
    }
    if (path.startsWith('/setup/api/')) {
      this.browser(req);
      const action = path.slice(11);
      if (action === 'state' && req.method === 'GET') {
        const runtimes = await Promise.all(
          this.config.runtimes.map(async (r) => ({
            ...runtimeDescription(r),
            executable_detected: ['codex', 'claude-code', 'deepseek', 'cursor'].includes(r.kind)
              ? await executable(
                  r.command ??
                    (
                      {
                        codex: 'codex',
                        'claude-code': 'claude',
                        deepseek: 'dsh',
                        cursor: 'agent',
                      } as Record<string, string>
                    )[r.kind]!,
                )
              : undefined,
          })),
        );
        reply(res, 200, {
          config: this.settings.public(this.config),
          applying: this.applying,
          runtimes,
          speech: {
            credential_configured: resolveSpeech(this.config.speech, this.secrets)
              .credentialConfigured,
          },
          catalog: runtimeCatalog,
          cloud: { connected: this.relay?.connected ?? false, error: this.relay?.lastError },
          devices: await this.api('/api/devices'),
        });
        return;
      }
      if (action === 'mcp-config' && req.method === 'GET') {
        reply(
          res,
          200,
          clientConfigurations(
            this.config,
            this.options.entry ?? resolve('dist/connect/cli.js'),
            this.settings.root,
          ),
        );
        return;
      }
      if (action === 'recovery' && req.method === 'GET') {
        const approvals = JSON.parse(
          (await hubApi(this.hubBase, this.internalToken, this.stop.signal)('/api/approvals'))
            .content[0]!.text,
        );
        reply(res, 200, {
          approvals,
          runs: this.store!.db.prepare(
            "SELECT id,device_id,resolved_session,status,created_at FROM runs WHERE status IN ('running','uncertain') ORDER BY created_at DESC LIMIT 100",
          ).all(),
          receipts: this.controlStore!.list(),
          jobs: this.jobs!.list(),
        });
        return;
      }
      const input = await requestBody(req);
      if (action === 'approval' && req.method === 'POST') {
        if (
          typeof input.id !== 'string' ||
          !input.id.match(/^[a-zA-Z0-9-]+$/) ||
          typeof input.accept !== 'boolean'
        )
          throw new ApiError(400, 'approval_fields');
        const r = await hubApi(
          this.hubBase,
          this.internalToken,
          this.stop.signal,
        )('/api/approvals/' + input.id, { accept: input.accept });
        reply(res, 200, JSON.parse(r.content[0]!.text));
        return;
      }
      if (action === 'resolve-run' && req.method === 'POST') {
        if (!['completed', 'failed'].includes(input.status)) throw new ApiError(400, 'resolution');
        const row = this.store!.run(input.id);
        if (row?.status !== 'uncertain') throw new ApiError(409, 'run_not_uncertain');
        this.store!.finishRun(
          input.id,
          input.status,
          'Manually reconciled by local owner; result inspected in native Harness.',
        );
        reply(res, 200, { reconciled: true, replayed: false });
        return;
      }
      if (action === 'resolve-receipt' && req.method === 'POST') {
        if (!['completed', 'not_completed'].includes(input.resolution))
          throw new ApiError(400, 'resolution');
        reply(res, 200, await this.controlStore!.reconcile(input.key, input.resolution));
        return;
      }
      if (action === 'cancel-job' && req.method === 'POST') {
        reply(res, 200, this.jobs!.cancel(input.id));
        return;
      }
      if (action === 'interrupt' && req.method === 'POST') {
        const row = this.store!.run(input.id);
        if (row?.status !== 'running') throw new ApiError(409, 'run_not_active');
        const result = await hubApi(
          this.hubBase,
          this.internalToken,
          this.stop.signal,
        )('/api/devices/' + encodeURIComponent(row.device_id) + '/interrupt', {});
        reply(res, 200, JSON.parse(result.content[0]!.text));
        return;
      }
      if (action === 'relay-reconnect' && req.method === 'POST') {
        await this.relay?.close();
        this.startRelay();
        reply(res, 200, { reconnecting: true });
        return;
      }
      const changing = ['runtimes', 'devices', 'cloud', 'speech'].includes(action);
      if (changing) {
        if (
          this.changing ||
          this.applying ||
          Boolean(this.jobs?.activeCount) ||
          this.hub?.hasActiveWork() ||
          [...this.routes.values()].some((r) => r.busy) ||
          this.admissions
        )
          throw new ApiError(409, 'active_operations_finish_first');
        this.changing = true;
      }
      try {
        if (action === 'speech' && req.method === 'POST') {
          if (!input || Object.keys(input).some((k) => !['settings', 'token'].includes(k)))
            throw new ApiError(400, 'speech_fields');
          const speech = LocalSpeechConfig.parse(input.settings);
          if (input.token !== undefined) {
            if (typeof input.token !== 'string' || !speech.thirdParty)
              throw new ApiError(400, 'speech_token');
            const ref = 'asr-' + randomUUID();
            speech.thirdParty.tokenRef = ref;
            delete speech.thirdParty.tokenEnv;
            if (input.token) await this.secrets.set(ref, input.token);
            else delete speech.thirdParty.tokenRef;
          }
          await this.apply(ConnectorConfig.parse({ ...this.config, speech }));
          reply(res, 200, { saved: true });
          return;
        }
        if (action === 'runtimes' && req.method === 'POST') {
          const runtime = RuntimeConfig.parse(input),
            next = ConnectorConfig.parse({
              ...this.config,
              runtimes: [...this.config.runtimes.filter((r) => r.id !== runtime.id), runtime],
            });
          await this.apply(next);
          reply(res, 200, { saved: true });
          return;
        }
        if (action === 'devices' && req.method === 'POST') {
          if (
            !input ||
            Object.keys(input).some((k) => !['id', 'label', 'runtimeId', 'sessionId'].includes(k))
          )
            throw new ApiError(400, 'device_fields');
          const existing = this.config.devices.find((d) => d.id === input.id);
          const d = {
            ...input,
            token: existing?.token ?? devicePairingToken(this.config, input.id),
          };
          const next = ConnectorConfig.parse({
            ...this.config,
            devices: [...this.config.devices.filter((x) => x.id !== d.id), d],
          });
          if (this.config.cloud && !existing) {
            const profile = await this.cloud('/v1/devices', { id: d.id, label: d.label });
            if (profile.token !== d.token) throw new ApiError(409, 'pairing_identity_mismatch');
          }
          await this.apply(next);
          reply(res, 200, { saved: true, device_id: d.id });
          return;
        }
        if (action === 'device-profile' && req.method === 'POST') {
          const d = this.config.devices.find((d) => d.id === input.id);
          if (!d) throw new ApiError(404, 'device_not_found');
          reply(res, 200, this.profile(d));
          return;
        }
        if (action === 'cloud' && req.method === 'POST') {
          if (this.config.cloud) throw new ApiError(409, 'cloud_already_configured');
          if (
            !input ||
            Object.keys(input).some((k) => k !== 'endpoint') ||
            typeof input.endpoint !== 'string'
          )
            throw new ApiError(400, 'cloud_endpoint');
          const endpoint = new URL(input.endpoint);
          if (
            endpoint.protocol !== 'https:' &&
            !['127.0.0.1', 'localhost'].includes(endpoint.hostname)
          )
            throw new ApiError(400, 'cloud_requires_https');
          const cloud = await boundedJson(
            await fetch(new URL('/v1/installations', endpoint), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: this.config.cloudRoomId,
                label: 'WishOS ' + this.config.id.slice(-8),
                hostname: connectorHostname(this.config.id).trim(),
                port: this.port,
                pairing_seed: this.config.pairingSeed,
              }),
              redirect: 'error',
              signal: AbortSignal.timeout(20000),
            }),
          );
          const configured = {
            endpoint: endpoint.origin,
            relayEndpoint: cloud.relay_origin,
            roomId: cloud.room_id,
            ownerToken: cloud.owner_token,
            connectorToken: cloud.connector_token,
          };
          const next = ConnectorConfig.parse({ ...this.config, cloud: configured });
          for (const d of next.devices) {
            const p = await this.cloud('/v1/devices', { id: d.id, label: d.label }, configured);
            if (p.token !== d.token) throw new ApiError(409, 'pairing_identity_mismatch');
          }
          await this.apply(next);
          reply(res, 200, { saved: true });
          return;
        }
        if (action === 'pair-code' && req.method === 'POST') {
          if (
            !input ||
            !['device', 'mcp'].includes(input.purpose) ||
            Object.keys(input).some((k) => !['purpose', 'device_id'].includes(k))
          )
            throw new ApiError(400, 'pairing_fields');
          reply(res, 200, await this.cloud('/v1/pair/code', input));
          return;
        }
      } finally {
        if (changing) this.changing = false;
      }
      throw new ApiError(404, 'setup_operation_not_found');
    }
    if (!this.authorized(req)) throw new ApiError(401, 'connector_authorization_required');
    if (req.headers.origin) throw new ApiError(403, 'browser_tool_origin_rejected');
    if (path === '/mcp') {
      await this.mcp.handle(req, res, async (path, body) => ({
        content: [{ type: 'text', text: JSON.stringify(await this.api(path, body)) }],
      }));
      return;
    }
    if (path === '/api/os/artifacts/upload' && req.method === 'POST') {
      if (this.closing || this.applying || this.changing)
        throw new ApiError(503, 'configuration_pending');
      ++this.admissions;
      try {
        const response = await fetch(new URL(path, this.hubBase), {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + this.internalToken,
            'Content-Type': 'application/octet-stream',
          },
          body: Readable.toWeb(req) as ReadableStream,
          duplex: 'half',
        } as RequestInit);
        reply(res, response.status, await boundedJson(response, 4096));
      } finally {
        --this.admissions;
      }
      return;
    }
    if (allowedApi(path)) {
      reply(
        res,
        200,
        await this.api(path, req.method === 'POST' ? await requestBody(req) : undefined),
      );
      return;
    }
    throw new ApiError(404, 'not_found');
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    this.stop.abort();
    for (const route of this.routes.values()) route.close();
    await this.discovery.close();
    await this.relay?.close();
    for (const socket of this.ws.clients) socket.terminate();
    await this.mcp.close();
    await this.jobs?.close();
    await this.hub?.close();
    await Promise.allSettled([...this.operations]);
    this.store?.db.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await new Promise<void>((resolve) => this.ws.close(() => resolve()));
    if (this.ownsLock) {
      if (this.lockFile) await unlink(this.lockFile).catch(() => {});
      await unlink(join(this.settings.root, 'running.json')).catch(() => {});
      this.ownsLock = false;
    }
  }
}
