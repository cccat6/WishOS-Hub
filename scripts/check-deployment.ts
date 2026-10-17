import { PackageDevice } from '../test/fixtures/package-device.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WireDevice, TransferFixture, eventually } from '../test/fixtures/wire-device.js';
const base = new URL(process.argv[2] ?? 'https://mcp.wishos.dev').origin;
async function api(path: string, body?: unknown, token?: string) {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const v = (await r.json()) as any;
  if (!r.ok) throw Error(path + ': ' + r.status + ' ' + JSON.stringify(v));
  return v;
}
const health = await api('/healthz');
assert(health.ok);
const metadata = await api('/.well-known/oauth-authorization-server');
assert.equal(metadata.issuer, base);
const id = randomUUID();
let owner: string | undefined;
const device = new WireDevice(),
  transfer = new TransferFixture(1024);
let client: Client | undefined;
let report: Record<string, unknown> | undefined;
let diagnosticNative: PackageDevice | undefined;
let failure: unknown;
let lastJob: Record<string, unknown> | undefined;
const progress: Record<string, unknown>[] = [];
const started = Date.now();
let jobTimeoutMs = 60000;
let jobTimeoutSource = 'legacy-client-default';
try {
  const install = await api('/v1/installations', {
    id,
    label: 'Deployment check',
    hostname: 'wishos-check.local',
    port: 18762,
    pairing_seed: randomBytes(32).toString('base64url'),
  });
  owner = install.owner_token;
  const profile = await api(
    '/v1/devices',
    { id: 'test-device', label: 'Synthetic wire fixture' },
    owner,
  );
  const token = (await api('/v1/access', {}, owner)).token;
  client = new Client(
    { name: 'wishos-release-check', version: '1' },
    {
      supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }),
  );
  const call = async (name: string, args: any) => {
    const r: any = await client!.callTool({ name, arguments: args });
    assert(!r.isError, JSON.stringify(r));
    return JSON.parse(r.content[0].text);
  };
  const service = await call('server_capabilities', {});
  const configuredTimeout = process.env.WISHOS_CHECK_JOB_TIMEOUT_MS;
  const advertisedTimeout = service.resources?.jobs?.timeout_ms;
  if (configuredTimeout !== undefined || advertisedTimeout !== undefined) {
    jobTimeoutMs = Number(configuredTimeout ?? advertisedTimeout);
    assert(
      Number.isSafeInteger(jobTimeoutMs) && jobTimeoutMs > 0,
      'invalid job observation deadline',
    );
    jobTimeoutSource =
      configuredTimeout !== undefined ? 'explicit-client-override' : 'server-contract';
  }
  const relay = new URL(install.relay_origin);
  relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';
  relay.pathname = '/os/device';
  relay.search = '?id=test-device';
  device.resourceHandler = (c) => transfer.call(c);
  await device.connect(relay.toString(), profile.token);
  await eventually(
    async () => (await call('device_state', { device_id: 'test-device' })).online,
    20000,
  );
  const input = {
    device_id: 'test-device',
    path: '/dev/fixture',
    method: 'write',
    args: { value: 1 },
    expected_boot_id: device.boot,
    request_id: 'check-write',
  };
  assert((await call('invoke_resource', input)).ok);
  await call('invoke_resource', input);
  assert.equal(device.writes, 1);
  const receipt = await call('read_operation', {
    device_id: 'test-device',
    boot_id: device.boot,
    request_id: 'check-write',
  });
  assert.equal(receipt.state, 'returned');
  const job = await call('stage_resource', { text: 'WishOS resource check 中文 '.repeat(400) });
  const asset = await eventually(async () => {
    const j = await call('read_resource_job', { id: job.id });
    if (j.state === 'failed') throw Error(j.error);
    return j.state === 'completed' ? j.result : false;
  }, 20000);
  const delivery = await call('deliver_resources', {
    device_id: 'test-device',
    expected_boot_id: device.boot,
    files: [{ path: 'check.txt', artifact_id: asset.id }],
  });
  await eventually(async () => {
    const j = await call('read_resource_job', { id: delivery.id });
    if (['failed', 'unknown'].includes(j.state)) throw Error(JSON.stringify(j));
    return j.state === 'completed';
  }, jobTimeoutMs);
  assert(transfer.committed);
  assert.equal(createHash('sha256').update(transfer.received).digest('hex'), asset.sha256);
  const native = new PackageDevice();
  diagnosticNative = native;
  native.boot = device.boot;
  native.paginatedMounts = true;
  native.descriptions['/sys/apps'].install_providers = ['card'];
  device.descriptions = native.descriptions;
  device.board = {
    component_index: { format: 'wishos-components/1', file: '/system/components.json' },
  };
  device.resourceHandler = (c) => native.call(c);
  native.files.set(
    '/system/components.json',
    Buffer.from(
      JSON.stringify({
        format: 'wishos-components/1',
        components: [{ id: 'deployment-fixture', layer: 'driver', kind: 'device' }],
      }),
    ),
  );
  const finish = async (id: string) =>
    eventually(async () => {
      const j = await call('read_resource_job', { id });
      lastJob = { id, state: j.state, error: j.error, result_state: j.result?.state };
      const t = native?.transfer;
      const snapshot = {
        id,
        state: j.state,
        transfer_state: t?.state,
        files_complete: t?.files_complete,
        current_file: t?.current?.path,
        file_offset: t?.current?.bytes.length,
      };
      if (JSON.stringify(progress.at(-1)?.snapshot) !== JSON.stringify(snapshot)) {
        progress.push({ elapsed_ms: Date.now() - started, snapshot });
        if (progress.length > 128) progress.shift();
      }
      if (['failed', 'unknown'].includes(j.state)) throw Error(JSON.stringify(j));
      return j.state === 'completed' ? j.result : false;
    }, jobTimeoutMs);
  const stage = async (path: string, text: string) => ({
    path,
    artifact_id: (await finish((await call('stage_resource', { text })).id)).id,
  });
  const offlineUi = await stage(
    'offline-ui.json',
    JSON.stringify({
      version: '0.1.1',
      assets: [
        {
          type: 'viewScreen',
          layout: { type: 'flex', mainAlign: 'center', crossAlign: 'end' },
          children: [{ type: 'label', labelProps: { text: 'Offline grammar' } }],
        },
      ],
    }),
  );
  const offlineChecked = await finish((await call('preflight_bundle', { files: [offlineUi] })).id);
  assert.equal(offlineChecked.validator_version, '4');
  assert.equal(offlineChecked.target_boot_id, undefined);
  const fonts = [{ id: 'system', scalable: true, minimum_size: 8, maximum_size: 96 }];
  const uiCaps = {
    methods: 'read,capabilities,fonts,font_check',
    read_methods: 'read,capabilities,fonts,font_check',
    format: 'brookesia-json-ui-0.1.x-subset',
    nodes: 'viewScreen,label',
    styles: 'font,fontSize',
    fonts,
    max_nodes: 32,
    max_depth: 8,
    max_document_bytes: 16384,
    font_check: { method: 'font_check', max_codepoints: 2 },
  };
  device.descriptions['/sys/ui'] = uiCaps;
  device.resourceHandler = (c) => {
    if (c.path !== '/sys/ui') return native.call(c);
    if (c.method === 'capabilities') return uiCaps;
    if (c.method === 'fonts') return { fonts };
    assert.equal(c.method, 'font_check');
    assert(c.args.codepoints.length <= uiCaps.font_check.max_codepoints);
    const missing = c.args.codepoints.filter((cp: number) => cp === 0x2212);
    return { missing_codepoints: missing, covered: missing.length === 0 };
  };
  for (const [text, valid] of [
    ['−5分钟', false],
    ['-5分钟', true],
  ] as const) {
    const file = await stage(
      'ui.json',
      JSON.stringify({
        version: '0.1.1',
        assets: [
          {
            type: 'viewScreen',
            style: { fontSize: 19 },
            children: [{ type: 'label', labelProps: { text } }],
          },
        ],
      }),
    );
    const submitted = await call('preflight_bundle', {
      files: [file],
      device_id: 'test-device',
      expected_boot_id: device.boot,
    });
    if (valid) assert.equal((await finish(submitted.id)).validator_version, '4');
    else {
      const rejected = await eventually(async () => {
        const job = await call('read_resource_job', { id: submitted.id });
        return job.state === 'failed' ? job : false;
      }, jobTimeoutMs);
      assert.equal(rejected.diagnostics[0].code, 'ui_font_missing_glyph');
    }
  }
  const index = await call('get_device_components', {
    device_id: 'test-device',
    expected_boot_id: device.boot,
  });
  assert.equal(index.components[0].id, 'deployment-fixture');
  const bad = await stage('bad.lua', 'local = 1');
  const badJob = await call('preflight_bundle', {
    files: [bad],
    device_id: 'test-device',
    expected_boot_id: device.boot,
  });
  const rejected = await eventually(async () => {
    const j = await call('read_resource_job', { id: badJob.id });
    return j.state === 'failed' ? j : false;
  }, 20000);
  assert.equal(rejected.diagnostics[0].code, 'lua_syntax');
  assert(!native.calls.some((c) => c.method === 'begin'));
  const files = [
    await stage(
      'app.json',
      JSON.stringify({
        format: 'wishos-app/1',
        id: 'live-check',
        title: 'Live check',
        entry: 'main.lua',
      }),
    ),
    await stage('main.lua', 'local x <const> = 1; return {version=x}'),
    await stage('image.bin', 'unchanged asset'),
  ];
  const p = await finish(
    (
      await call('prepare_package', {
        device_id: 'test-device',
        expected_boot_id: device.boot,
        files,
      })
    ).id,
  );
  assert.equal(p.preflight.lua.native_call_depth_limit, 32);
  assert.deepEqual(p.preflight.limits.application_install_providers, ['card']);
  const failed = async (id: string) =>
    eventually(async () => {
      const job = await call('read_resource_job', { id });
      assert.notEqual(job.state, 'unknown', JSON.stringify(job));
      return job.state === 'failed' ? job : false;
    }, jobTimeoutMs);
  native.descriptions['/sys/apps'].install_providers = [];
  const emptyPolicy = await call('preflight_bundle', {
    device_id: 'test-device',
    expected_boot_id: device.boot,
    files: p.files,
  });
  assert.equal((await failed(emptyPolicy.id)).diagnostics[0].code, 'application_storage_disabled');
  native.descriptions['/sys/apps'].install_providers = ['card'];
  native.pendingApplication = 'boot-launcher';
  const pendingRequest = await call('deploy_package', {
    device_id: 'test-device',
    expected_boot_id: device.boot,
    files: p.files,
    activate: true,
    stop_current_before_transfer: true,
  });
  assert.match((await failed(pendingRequest.id)).error, /application_transition_pending/);
  assert.equal(native.active, 'original');
  assert(!native.calls.some((c) => ['stop', 'mount', 'begin'].includes(c.method)));
  native.pendingApplication = undefined;
  device.beforeRespond = (c) => {
    if (c.path === '/sys/runtime' && c.method === 'stop')
      native.pendingApplication = 'late-selection';
  };
  const refusalRequest = await call('deploy_package', {
    device_id: 'test-device',
    expected_boot_id: device.boot,
    files: p.files,
    activate: true,
    stop_current_before_transfer: true,
  });
  const refusal = await failed(refusalRequest.id);
  assert.equal(refusal.error, 'application_transition_pending');
  assert.equal(refusal.receipts.runtime_stop.ok, false);
  assert.equal(refusal.receipts.runtime_stop.error, 'application_transition_pending');
  assert.equal(native.active, 'original');
  assert.equal(native.pendingApplication, 'late-selection');
  assert.equal(
    native.calls.filter((c) => c.path === '/sys/runtime' && c.method === 'stop').length,
    1,
  );
  assert(!native.calls.some((c) => c.method === 'mount' || c.method === 'begin'));
  device.beforeRespond = undefined;
  native.pendingApplication = undefined;
  const installed = await finish(
    (
      await call('deploy_package', {
        device_id: 'test-device',
        expected_boot_id: device.boot,
        files: p.files,
        activate: true,
      })
    ).id,
  );
  assert.equal(installed.state, 'activated');
  assert(
    native.calls.some((c) => c.path === '/fs' && c.method === 'mounts' && c.args.cursor === 4),
  );
  assert(!native.calls.some((c) => c.path === '/dev/media' && c.method === 'mount'));
  let readReconnect = false,
    reconnectFailure: unknown;
  device.beforeRespond = async (c) => {
    if (
      !readReconnect &&
      native.revision === 1 &&
      native.ticket?.state === 'validated' &&
      c.path === '/sys/capabilities' &&
      c.args.path === '/sys/apps'
    ) {
      readReconnect = true;
      device.socket.terminate();
      try {
        await device.connect(relay.toString(), profile.token);
      } catch (error) {
        reconnectFailure = error;
      }
      return false;
    }
  };
  const replacement = await stage('main.lua', 'return {version=2}');
  const updated = await finish(
    (
      await call('update_package', {
        device_id: 'test-device',
        expected_boot_id: device.boot,
        application_id: 'live-check',
        expected_revision: 1,
        replacements: [replacement],
      })
    ).id,
  );
  assert.equal(updated.state, 'installed');
  if (reconnectFailure) throw reconnectFailure;
  assert(readReconnect);
  assert.equal(
    native.calls.filter((c) => c.path === '/sys/apps' && c.method === 'install').length,
    2,
  );
  assert.equal(native.revision, 2);
  assert.equal(native.files.get('/card/revisions/2/main.lua')!.toString(), 'return {version=2}');
  assert(!native.reads.has('/card/revisions/1/image.bin'));
  const tool = (await client.listTools()).tools.find((t) => t.name === 'update_package');
  assert.equal((tool!.inputSchema as any).properties.stop_current_before_transfer.default, false);
  native.preparationNeedsIdle = true;
  native.preparationReady = false;
  const explicitReplacement = await stage('main.lua', 'return {version=3}');
  const explicit = await finish(
    (
      await call('update_package', {
        device_id: 'test-device',
        expected_boot_id: device.boot,
        application_id: 'live-check',
        expected_revision: 2,
        replacements: [explicitReplacement],
        activate: true,
        stop_current_before_transfer: true,
      })
    ).id,
  );
  assert.equal(explicit.state, 'activated');
  assert.equal(explicit.receipts.runtime_stop.loaded, false);
  assert.equal(native.revision, 3);
  assert.equal(
    native.calls.filter((c) => c.path === '/sys/runtime' && c.method === 'stop').length,
    2,
  );

  report = {
    ok: true,
    origin: base,
    protocol: client.getNegotiatedProtocolVersion(),
    checks: [
      'https',
      'metadata',
      'paired-wss',
      'mcp-device-rpc',
      'mutation-receipt-no-replay',
      'temporary-assets',
      'streamed-bundle-sha256',
      'mcp-layer-guidance',
      'boot-scoped-components',
      'actual-lua-wasm-profile',
      'bad-code-no-device-write',
      'offline-ui-grammar-without-target-assumptions',
      'live-cloud-declared-font-check',
      'package-native-ticket-install-activate',
      'whole-file-update-local-copy',
      'explicit-stop-after-preflight-before-preparation',
      'same-boot-read-recovery-before-single-install',
      'paginated-storage-target-and-ready-volume-no-remount',
      'application-transition-admission',
      'empty-install-policy-denial',
      'native-stop-refusal-receipt-no-replay',
    ],
    physical_device: false,
    vendor_account: false,
    at: new Date().toISOString(),
    job_timeout_ms: jobTimeoutMs,
    job_timeout_source: jobTimeoutSource,
  };
} catch (error) {
  failure = error;
  const native = diagnosticNative;
  report = {
    ok: false,
    origin: base,
    physical_device: false,
    vendor_account: false,
    error: error instanceof Error ? error.message : String(error),
    last_job: lastJob,
    elapsed_ms: Date.now() - started,
    job_timeout_ms: jobTimeoutMs,
    job_timeout_source: jobTimeoutSource,
    progress,
    wire_method_counts: Object.fromEntries(
      [...new Set(device.calls.map((c) => c.path + ':' + c.method))].map((key) => [
        key,
        device.calls.filter((c) => c.path + ':' + c.method === key).length,
      ]),
    ),
    native_state: native
      ? {
          revision: native.revision,
          active: native.active,
          transfer_state: native.transfer?.state,
          files_complete: native.transfer?.files_complete,
          current_file: native.transfer?.current?.path,
          file_offset: native.transfer?.current?.bytes.length,
        }
      : undefined,
  };
} finally {
  await client?.close();
  await device.close();
  if (owner) {
    const r = await fetch(base + '/v1/installations', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + owner },
      signal: AbortSignal.timeout(20000),
    });
    assert(r.ok, 'Synthetic installation cleanup failed');
  }
}

console.log(JSON.stringify({ ...report, cleanup: true }, null, 2));
if (failure) throw failure;
