import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalRelative,
  resolveFiles,
  resolveReference,
  utf8Compare,
  type BundleSource,
  type DeliveryFile,
  type BundleArtifact,
} from './bundle-files.js';
import { preflightBundle, PreflightError, type PreflightOptions } from './preflight.js';
import { deliverBundle } from './bundle-transfer.js';
import { bootRpc, deviceFileReader, readDeviceFile, absoluteReference } from './device-files.js';
import type { DeviceRpc } from './os-remote.js';
import type { LuaCompilerFactory } from './lua-compiler.js';
export type StageText = (
  text: string,
  signal: AbortSignal,
) => Promise<{ id: string; size: number; sha256: string }>;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const parse = (bytes: Uint8Array) =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
export async function preparePackage(
  source: BundleSource,
  stage: StageText,
  files: DeliveryFile[],
  manifest: string,
  options: PreflightOptions,
) {
  if (
    !canonicalRelative(manifest) ||
    files.some((f) => ['package.json', 'files.jsonl'].includes(f.path))
  )
    throw new PreflightError('package_metadata_paths');
  files = files.map((file) => (file.path === manifest ? { ...file, kind: 'json' as const } : file));
  const resolved = resolveFiles(source, files),
    release = source.pin?.(resolved);
  const leases: (() => void)[] = [];
  try {
    const inventory = [...resolved]
      .sort((a, b) => utf8Compare(a.destination, b.destination))
      .map(
        (f) =>
          JSON.stringify({
            path: f.destination,
            bytes: String(f.size),
            sha256: f.sha256,
            ...(f.kind ? { kind: f.kind } : {}),
          }) + '\n',
      )
      .join('');
    const inv = await stage(inventory, options.signal);
    const invRelease = source.pin?.([source.get(inv.id)]);
    if (invRelease) leases.push(invRelease);
    const header = await stage(
      JSON.stringify({
        format: 'wishos-package/1',
        entry: manifest,
        inventory: 'files.jsonl',
        inventory_sha256: hash(inventory),
      }),
      options.signal,
    );
    const headerRelease = source.pin?.([source.get(header.id)]);
    if (headerRelease) leases.push(headerRelease);
    const complete = [
      ...files,
      { path: 'files.jsonl', artifact_id: inv.id },
      { path: 'package.json', artifact_id: header.id, kind: 'json' as const },
    ];
    const preflight = await preflightBundle(source, complete, options);
    if (preflight.packages.length !== 1)
      throw new PreflightError('one_application_package_required');
    return { files: complete, package: 'package.json', manifest, preflight };
  } finally {
    for (const release of leases.reverse()) release();
    release?.();
  }
}
async function checked(
  rpc: DeviceRpc,
  path: string,
  method: string,
  args: Record<string, unknown> = {},
) {
  const r = await rpc(path, method, args);
  if (!r.ok) throw Error(r.error ?? 'device_operation_failed');
  return r.result;
}
function methods(metadata: any) {
  return String(metadata.methods ?? '').split(',');
}
export class PackageOutcomeUnknown extends Error {
  constructor(
    message: string,
    readonly receipts: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PackageOutcomeUnknown';
  }
}
export async function deployPackage(
  source: BundleSource,
  files: DeliveryFile[],
  rpcInput: DeviceRpc,
  boot: string,
  options: {
    compiler: LuaCompilerFactory;
    signal: AbortSignal;
    package?: string;
    expected_revision?: number;
    persist?: boolean;
    activate?: boolean;
  },
) {
  const release = source.pin?.(resolveFiles(source, files));
  try {
    return await deployPinned(source, files, rpcInput, boot, options);
  } finally {
    release?.();
  }
}
async function deployPinned(
  source: BundleSource,
  files: DeliveryFile[],
  rpcInput: DeviceRpc,
  boot: string,
  options: {
    compiler: LuaCompilerFactory;
    signal: AbortSignal;
    package?: string;
    expected_revision?: number;
    persist?: boolean;
    activate?: boolean;
  },
) {
  const rpc = bootRpc(rpcInput, boot),
    signal = options.signal,
    preflight = await preflightBundle(source, files, { ...options, rpc, expectedBoot: boot });
  const pkg = options.package
    ? preflight.packages.find((p) => p.header === options.package)
    : preflight.packages.length === 1
      ? preflight.packages[0]
      : undefined;
  if (!pkg) throw new PreflightError('select_application_package');
  const metadata = await checked(rpc, '/sys/capabilities', 'describe', { path: '/sys/apps' }),
    validation = metadata.package_validation;
  if (
    !validation ||
    !methods(metadata).includes(validation.method) ||
    !methods(metadata).includes(validation.status_method) ||
    !methods(metadata).includes(validation.release_method) ||
    !methods(metadata).includes('install')
  )
    throw new PreflightError('native_package_validation_unavailable');
  if (options.activate && !metadata.async?.launch)
    throw new PreflightError('activation_completion_unavailable');
  const catalog = await checked(rpc, '/sys/apps', 'read'),
    revision = options.expected_revision ?? catalog.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new PreflightError('catalog_revision');
  if (catalog.revision !== revision) throw new PreflightError('base_revision_changed');
  if (resolveFiles(source, files).some((f) => f.copy_from)) {
    const transfer = await checked(rpc, '/sys/capabilities', 'describe', {
      path: '/sys/transfers',
    });
    if (!methods(transfer).includes('copy_file'))
      throw new PreflightError('native_copy_unavailable');
  }
  let validationId: number | undefined,
    committed = false;
  const receipts: Record<string, unknown> = { preflight };
  const record = async (
    key: string,
    path: string,
    method: string,
    args: Record<string, unknown>,
  ) => {
    receipts[key] = { path, method, args, state: 'requesting' };
    const reply = await rpc(path, method, args);
    receipts[key] = reply.ok
      ? reply.result
      : { ok: false, error: reply.error, result: reply.result, boot_id: reply.boot_id };
    if (!reply.ok) throw Error(reply.error ?? 'device_operation_failed');
    return reply.result;
  };
  try {
    const delivered = await deliverBundle(rpc, files, signal, boot, undefined, source, {
      compiler: options.compiler,
    });
    receipts.transfer = delivered;
    const manifestPath = posix.join(delivered.root, pkg.manifest),
      packagePath = posix.join(delivered.root, pkg.header);
    const admission = await record('validation_admission', '/sys/apps', validation.method, {
      manifest: manifestPath,
      package: packagePath,
    });
    receipts.validation_admission = admission;
    validationId = admission.operation_id;
    if (!Number.isSafeInteger(validationId))
      throw new PackageOutcomeUnknown('validation_identity_missing', receipts);
    for (;;) {
      signal.throwIfAborted();
      const status = await checked(rpc, '/sys/apps', validation.status_method, {
        operation_id: validationId,
      });
      receipts.validation = status;
      if (status.state === 'failed') throw Error('native_package_validation:' + status.error);
      if (status.state === 'validated') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if ((receipts.validation as any).revision !== revision) throw Error('base_revision_changed');
    const installed = await record('install', '/sys/apps', 'install', {
      manifest: manifestPath,
      package: packagePath,
      validation_id: validationId,
      expected_revision: revision,
      persist: options.persist ?? true,
    });
    committed = true;
    receipts.install = installed;
    if (options.activate) {
      const async = metadata.async?.launch;
      if (!async) throw Error('activation_completion_unavailable');
      const admission = await record('activation_admission', '/sys/operations', 'request', {
        path: '/sys/apps',
        method: 'launch',
        args: { id: installed.application_id },
      });
      receipts.activation_admission = admission;
      try {
        for (;;) {
          signal.throwIfAborted();
          const status = await checked(rpc, '/sys/operations', 'read', {
            id: admission.completion_id,
          });
          if (status.ready) {
            receipts.activation = status;
            if (!async.success_events.includes(status.event) || status.event === 'failed')
              throw Error('application_activation_failed');
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        await checked(rpc, '/sys/operations', 'release', { id: admission.completion_id }).catch(
          () => {},
        );
      }
    }
    return {
      state: options.activate ? 'activated' : 'installed',
      application_id: installed.application_id,
      package: packagePath,
      manifest: manifestPath,
      revision: installed.revision,
      receipts,
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'transfer_receipt' in error)
      receipts.transfer = error.transfer_receipt;
    if (error instanceof PackageOutcomeUnknown) throw error;
    if (
      error instanceof Error &&
      /disconnected|transport|outcome_unknown|timeout/.test(error.message)
    )
      throw new PackageOutcomeUnknown(error.message, receipts);
    throw Object.assign(error instanceof Error ? error : Error(String(error)), { receipts });
  } finally {
    if (validationId !== undefined && !committed)
      await checked(rpc, '/sys/apps', validation.release_method, {
        operation_id: validationId,
      }).catch(() => {});
  }
}
/** Read the selected immutable base; unchanged text is parsed upstream and only
 * copy_file writes it into the candidate revision. Image bytes stay on device. */
export async function prepareUpdate(
  source: BundleSource,
  stage: StageText,
  rpcInput: DeviceRpc,
  boot: string,
  input: {
    application_id: string;
    replacements: DeliveryFile[];
    delete?: string[];
    expected_revision?: number;
  },
  options: PreflightOptions,
) {
  const rpc = bootRpc(rpcInput, boot),
    catalog = await checked(rpc, '/sys/apps', 'read'),
    inspect = await checked(rpc, '/sys/apps', 'inspect', { id: input.application_id });
  if (!inspect.package) throw new PreflightError('base_has_no_package');
  if (input.expected_revision !== undefined && input.expected_revision !== catalog.revision)
    throw new PreflightError('base_revision_changed');
  const header = parse(await readDeviceFile(rpc, inspect.package, 1024 * 1024, options.signal));
  if (
    header.format !== 'wishos-package/1' ||
    typeof header.inventory !== 'string' ||
    typeof header.entry !== 'string'
  )
    throw new PreflightError('base_package_header');
  for (const ref of [header.entry, header.inventory])
    if (resolveReference('package.json', ref).startsWith('/'))
      throw new PreflightError('base_package_reference');
  const inventoryPath = absoluteReference(inspect.package, header.inventory),
    inventoryBytes = await readDeviceFile(rpc, inventoryPath, 1024 * 1024, options.signal);
  if (
    hash(inventoryBytes) !== header.inventory_sha256 ||
    inspect.inventory_sha256 !== header.inventory_sha256
  )
    throw new PreflightError('base_inventory_identity');
  const base = new Map<string, BundleArtifact & { kind?: DeliveryFile['kind'] }>(),
    root = posix.dirname(inspect.package);
  let previous = '';
  for (const line of new TextDecoder().decode(inventoryBytes).split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (
      !canonicalRelative(row.path) ||
      typeof row.bytes !== 'string' ||
      !row.bytes.match(/^(0|[1-9][0-9]*)$/) ||
      !/^[a-f0-9]{64}$/.test(row.sha256 ?? '') ||
      (previous && utf8Compare(previous, row.path) >= 0)
    )
      throw new PreflightError('base_inventory');
    previous = row.path;
    const size = Number(row.bytes);
    if (!Number.isSafeInteger(size)) throw new PreflightError('base_file_size');
    base.set(row.path, {
      id: 'base:' + randomUUID(),
      path: posix.join(root, row.path),
      copy_from: posix.join(root, row.path),
      size,
      sha256: row.sha256,
      ...(row.kind ? { kind: row.kind } : {}),
    });
  }
  const replaced = input.replacements.length ? resolveFiles(source, input.replacements) : [];
  const deleted = input.delete ?? [];
  if (
    new Set(deleted).size !== deleted.length ||
    deleted.some(
      (p) => !canonicalRelative(p) || !base.has(p) || input.replacements.some((f) => f.path === p),
    )
  )
    throw new PreflightError('update_deletions');
  for (const p of deleted) base.delete(p);
  for (const r of replaced) base.delete(r.destination);
  const byId = new Map([...base.values()].map((f) => [f.id, f]));
  const combined: BundleSource = {
    get: (id) => byId.get(id) ?? source.get(id),
    open: async (file) =>
      byId.has(file.id) ? deviceFileReader(rpc, file.copy_from!, file.size) : source.open(file),
    pin: (artifacts) => source.pin?.(artifacts.filter((f) => !byId.has(f.id))) ?? (() => {}),
  };
  const unchanged = [...base].map(([path, f]) => ({
      path,
      artifact_id: f.id,
      ...(f.kind ? { kind: f.kind } : {}),
    })),
    files = [...unchanged, ...input.replacements];
  const prepared = await preparePackage(combined, stage, files, header.entry, {
    ...options,
    rpc,
    expectedBoot: boot,
  });
  const current = await checked(rpc, '/sys/apps', 'read');
  if (current.revision !== catalog.revision) throw new PreflightError('base_revision_changed');
  return {
    ...prepared,
    source: combined,
    base: {
      application_id: input.application_id,
      package: inspect.package,
      inventory_sha256: header.inventory_sha256,
      revision: catalog.revision,
    },
    changed_files: input.replacements.map((f) => f.path),
    copied_files: [...base.keys()],
    deleted_files: deleted,
  };
}
