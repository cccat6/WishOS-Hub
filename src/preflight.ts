import { readMounts } from './device-storage.js';
import { preflightUi } from './preflight-ui.js';
import { readDeviceFile } from './device-files.js';
import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import {
  resolveFiles,
  readArtifact,
  verifyArtifact,
  resolveReference,
  canonicalRelative,
  utf8Compare,
  contentIdentity,
  type DeliveryFile,
  type BundleSource,
  type ResolvedFile,
} from './bundle-files.js';
import type { LuaCompilerFactory } from './lua-compiler.js';
import { luaReferences } from './lua-references.js';
import type { DeviceRpc } from './os-remote.js';
export type Diagnostic = { code: string; file?: string; line?: number; detail?: string };
export class PreflightError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(code: string, diagnostic: Omit<Diagnostic, 'code'> = {}) {
    super('preflight_rejected:' + code);
    this.name = 'PreflightError';
    this.diagnostics = [{ code, ...diagnostic }];
  }
}
/** Mirrors the device's ordered transfer target selection without mounting or
 * changing policy. Package placement is separate from ordinary data delivery. */
export function checkApplicationStorage(
  metadata: any,
  policy: any,
  providers: any[],
  includePreparation: boolean,
) {
  const declared = metadata.install_providers;
  if (declared === undefined) return;
  const allowed = Array.isArray(declared)
    ? declared
    : typeof declared === 'string'
      ? declared.split(',').filter(Boolean)
      : null;
  if (!allowed || allowed.some((id) => typeof id !== 'string'))
    throw new PreflightError('application_storage_policy');
  if (!allowed.length) throw new PreflightError('application_storage_disabled');
  for (const target of policy.targets ?? []) {
    const volume = providers.find((p) => p.id === target.provider);
    if (!volume || (!volume.available && !(includePreparation && volume.prepare))) continue;
    if (!allowed.includes(target.provider))
      throw new PreflightError('application_storage_provider', { detail: target.provider });
    return target.provider as string;
  }
  throw new PreflightError('application_storage_unavailable');
}
export type PreflightOptions = {
  compiler?: LuaCompilerFactory;
  rpc?: DeviceRpc;
  expectedBoot?: string;
  controlFiles?: string[];
  signal: AbortSignal;
};
export type PackageRecord = {
  header: string;
  manifest: string;
  inventory: string;
  inventory_sha256: string;
  id: string;
  files: string[];
};
export type PreflightReport = {
  format: 'wishos-preflight/1';
  ok: true;
  validator_version: string;
  content_sha256: string;
  bytes: string;
  files: { path: string; bytes: string; sha256: string }[];
  packages: PackageRecord[];
  lua: { parser: 'Lua 5.4.8'; files: number; native_call_depth_limit?: number };
  target_boot_id?: string;
  warnings: Diagnostic[];
  limits: Record<string, unknown>;
  scope: string;
};
const object = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sha = (x: Uint8Array) => createHash('sha256').update(x).digest('hex');
export async function preflightBundle(
  source: BundleSource,
  files: DeliveryFile[],
  options: PreflightOptions,
): Promise<PreflightReport> {
  let resolved: ResolvedFile[];
  try {
    resolved = resolveFiles(source, files);
  } catch (e) {
    throw new PreflightError('file_list', { detail: e instanceof Error ? e.message : undefined });
  }
  const release = source.pin?.(resolved);
  try {
    return await checkResolved(source, resolved, options);
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    throw new PreflightError('validation_unavailable', {
      detail: error instanceof Error ? error.message : undefined,
    });
  } finally {
    release?.();
  }
}
async function checkResolved(
  source: BundleSource,
  files: ResolvedFile[],
  options: PreflightOptions,
): Promise<PreflightReport> {
  const textErrors = new Map<string, string>();
  const signal = options.signal,
    map = new Map(files.map((f) => [f.destination, f])),
    texts = new Map<string, string>(),
    json = new Map<string, any>(),
    warnings: Diagnostic[] = [],
    packages: PackageRecord[] = [];
  let textBytes = 0;
  for (const file of files) {
    const isLua = file.kind === 'lua' || file.destination.toLowerCase().endsWith('.lua');
    const isText =
      isLua ||
      (file.kind !== 'asset' &&
        !options.controlFiles?.includes(file.destination) &&
        (file.kind === 'json' ||
          /\.json$/i.test(file.destination) ||
          file.destination === 'files.jsonl'));
    try {
      if (file.copy_from && !isText)
        warnings.push({ code: 'native_copy_digest_required', file: file.destination });
      else await verifyArtifact(source, file, signal);
    } catch (e) {
      throw new PreflightError('source_digest', {
        file: file.destination,
        detail: e instanceof Error ? e.message : undefined,
      });
    }
    if (!isText) continue;
    if (file.size > 1024 * 1024) {
      if (isLua || file.kind === 'json')
        throw new PreflightError('host_text_budget', { file: file.destination });
      textErrors.set(file.destination, 'host_text_budget');
      continue;
    }
    try {
      const text = decoder.decode(await readArtifact(source, file, 1024 * 1024, signal));
      if (isLua || file.destination === 'files.jsonl') {
        texts.set(file.destination, text);
        textBytes += file.size;
      } else {
        const value = JSON.parse(text);
        if (
          file.kind === 'json' ||
          ['wishos-app/1', 'wishos-package/1', 'notes-app/1'].includes(value?.format) ||
          Array.isArray(value?.assets) ||
          value?.type === 'viewScreen'
        ) {
          json.set(file.destination, value);
          texts.set(file.destination, text);
          textBytes += file.size;
        }
      }
      if (textBytes > 16 * 1024 * 1024)
        throw new PreflightError('host_text_budget', { file: file.destination });
    } catch (e) {
      if (isLua || file.kind === 'json')
        throw new PreflightError('text_or_json', {
          file: file.destination,
          detail: e instanceof Error ? e.message : undefined,
        });
      textErrors.set(file.destination, e instanceof Error ? e.message : 'invalid_json');
    }
  }

  const lua = [...texts].filter(
    ([p]) => map.get(p)!.kind === 'lua' || p.toLowerCase().endsWith('.lua'),
  );
  if (lua.length && !options.compiler) throw new PreflightError('lua_compiler_unavailable');
  const compiler = lua.length ? await options.compiler!() : undefined;
  for (const [file, text] of lua) {
    if (!text.length || text.includes('\0')) throw new PreflightError('lua_source', { file });
    const parsed = compiler!.check(text, file);
    if (!parsed.ok)
      throw new PreflightError('lua_syntax', { file, line: parsed.line, detail: parsed.error });
  }
  let boot = options.expectedBoot;
  const read = async (path: string, method: string, args: Record<string, unknown> = {}) => {
    if (!options.rpc) throw new PreflightError('target_discovery_required', { detail: path });
    const r = await options.rpc(path, method, {
      ...args,
      ...(boot ? { expected_boot_id: boot } : {}),
    });
    if (boot && r.boot_id !== boot) throw new PreflightError('device_boot_changed');
    boot = r.boot_id;
    if (!r.ok) throw new PreflightError('target_capability', { detail: path + ':' + r.error });
    return r.result;
  };
  const descriptors = new Map<string, any>();
  const describe = async (path: string) => {
    if (!descriptors.has(path))
      descriptors.set(path, await read('/sys/capabilities', 'describe', { path }));
    return descriptors.get(path);
  };
  const manifests = [...json].filter(([, v]) => object(v) && v.format === 'wishos-app/1');
  const headers = [...json].filter(([, v]) => object(v) && v.format === 'wishos-package/1');
  const ui = [...json].filter(
    ([, v]) =>
      object(v) &&
      (v.format === 'notes-app/1' || (typeof v.version === 'string' && Array.isArray(v.assets))),
  );
  let runtime: any = {},
    apps: any = {},
    uiCaps: any = {};
  if (options.rpc && lua.length) {
    runtime = { ...(await describe('/sys/runtime')), ...(await read('/sys/runtime', 'read')) };
    if (!String(runtime.engine ?? runtime.validation?.parser ?? '').includes('5.4'))
      throw new PreflightError('runtime_language_mismatch');
  }
  if (options.rpc && (headers.length || manifests.length)) {
    apps = await describe('/sys/apps');
    if (apps.install_providers !== undefined) {
      const transfer = await read('/sys/transfers', 'read'),
        volumes = await readMounts(async (path, method, args) => {
          const result = await read(path, method, args);
          return { ok: true, boot_id: boot!, result };
        }, signal);
      checkApplicationStorage(apps, transfer.policy ?? {}, volumes, true);
    }
  }
  if (options.rpc && ui.length) {
    uiCaps = { ...(await describe('/sys/ui')), ...(await read('/sys/ui', 'capabilities')) };
    if (
      String(uiCaps.methods ?? '')
        .split(',')
        .includes('fonts')
    )
      uiCaps.fonts = (await read('/sys/ui', 'fonts')).fonts;
  }
  const positive = (v: any) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const bounds = (file: string, size: number, max: unknown, code: string) => {
    if (positive(max) && size > (max as number)) throw new PreflightError(code, { file });
  };
  if (
    compiler &&
    typeof runtime.native_call_depth_limit === 'number' &&
    runtime.native_call_depth_limit !== compiler.profile.native_call_depth_limit
  )
    throw new PreflightError('lua_parser_profile_mismatch');
  const runtimeLimit =
    runtime.entry_source_limit_bytes ??
    runtime.source_limit_bytes ??
    apps.package_validation?.lua_source_limit_bytes;
  for (const [file] of lua) bounds(file, map.get(file)!.size, runtimeLimit, 'lua_source_limit');
  const reference = async (file: string, path: string, scope?: string) => {
    let result;
    try {
      result = resolveReference(file, path);
    } catch (e) {
      throw new PreflightError('reference_path', { file, detail: String(e) });
    }
    if (
      scope !== undefined &&
      !result.startsWith('/') &&
      (scope ? !(result === scope || result.startsWith(scope + '/')) : false)
    )
      throw new PreflightError('reference_escapes_package', { file, detail: path });
    if (map.has(result)) return result;
    if (result.startsWith('/system/') && options.rpc) {
      const info = await read('/fs', 'stat', { file: result });
      if (info.directory) throw new PreflightError('reference_directory', { file, detail: path });
      return result;
    }
    throw new PreflightError('reference_missing', { file, detail: path });
  };
  const manifestByPath = new Map<string, any>();
  for (const [file, value] of manifests) {
    if (
      typeof value.id !== 'string' ||
      !value.id.match(/^[A-Za-z0-9_.-]{1,48}$/) ||
      typeof value.title !== 'string' ||
      !value.title ||
      typeof value.entry !== 'string'
    )
      throw new PreflightError('application_manifest', { file });
    if (options.rpc && !positive(apps.manifest_limit_bytes))
      warnings.push({ code: 'native_manifest_limit_not_advertised', file });
    bounds(
      file,
      map.get(file)!.size,
      apps.manifest_limit_bytes ?? apps.package_validation?.json_limit_bytes,
      'application_manifest_limit',
    );
    const entry = await reference(file, value.entry);
    if (!entry.toLowerCase().endsWith('.lua'))
      throw new PreflightError('application_entry_language', { file });
    if (value.requires !== undefined) {
      if (!Array.isArray(value.requires))
        throw new PreflightError('application_requirements', { file });
      for (const r of value.requires) {
        if (
          !object(r) ||
          typeof r.path !== 'string' ||
          !r.path.startsWith('/') ||
          !Array.isArray(r.methods) ||
          r.methods.some((m: unknown) => typeof m !== 'string')
        )
          throw new PreflightError('application_requirements', { file });
        if (options.rpc) {
          const metadata = await describe(r.path),
            methods = String(metadata.methods ?? '').split(',');
          for (const method of r.methods)
            if (!methods.includes(method))
              throw new PreflightError('required_method_missing', {
                file,
                detail: r.path + ':' + method,
              });
        }
      }
    }
    for (const key of ['memory_bytes', 'instruction_budget', 'system_call_budget'])
      if (value[key] !== undefined && value[key] !== null) {
        const n = value[key],
          b = runtime.budgets?.[key];
        if (
          !Number.isInteger(n) ||
          n <= 0 ||
          (positive(b?.minimum) && n < b.minimum) ||
          (positive(b?.maximum) && n > b.maximum) ||
          (key === 'memory_bytes' &&
            positive(runtime.memory_policy_limit_bytes) &&
            n > runtime.memory_policy_limit_bytes)
        )
          throw new PreflightError('application_budget', { file, detail: key });
      }
    manifestByPath.set(file, value);
  }
  for (const [file, header] of headers) {
    if (
      Object.keys(header).some(
        (k) => !['format', 'entry', 'inventory', 'inventory_sha256'].includes(k),
      ) ||
      typeof header.entry !== 'string' ||
      typeof header.inventory !== 'string' ||
      !/^[a-f0-9]{64}$/.test(header.inventory_sha256 ?? '')
    )
      throw new PreflightError('package_header', { file });
    bounds(
      file,
      map.get(file)!.size,
      apps.package_validation?.header_limit_bytes,
      'package_header_limit',
    );
    const root = posix.dirname(file) === '.' ? '' : posix.dirname(file),
      entry = await reference(file, header.entry, root),
      inventory = await reference(file, header.inventory, root);
    if (!manifestByPath.has(entry) || inventory === file || entry === file)
      throw new PreflightError('package_entry', { file });
    if (!texts.has(inventory)) {
      const inv = map.get(inventory)!;
      const bytes = await readArtifact(source, inv, 1024 * 1024, signal);
      if (sha(bytes) !== inv.sha256) throw new PreflightError('source_digest', { file: inventory });
      texts.set(inventory, decoder.decode(bytes));
    }
    const invFile = map.get(inventory)!;
    if (invFile.sha256 !== header.inventory_sha256)
      throw new PreflightError('inventory_digest', { file: inventory });
    if (!texts.has(inventory)) throw new PreflightError('inventory_not_text', { file: inventory });
    const listed = new Set<string>();
    let previous = '';
    for (const line of texts.get(inventory)!.split('\n')) {
      if (!line.trim()) continue;
      bounds(
        inventory,
        Buffer.byteLength(line),
        apps.package_validation?.inventory_line_limit_bytes,
        'inventory_line_limit',
      );
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw new PreflightError('inventory_json', { file: inventory });
      }
      if (
        !object(row) ||
        Object.keys(row).some((k) => !['path', 'bytes', 'sha256', 'kind'].includes(k)) ||
        !canonicalRelative(row.path) ||
        typeof row.bytes !== 'string' ||
        !row.bytes.match(/^(0|[1-9][0-9]*)$/) ||
        !/^[a-f0-9]{64}$/.test(row.sha256 ?? '')
      )
        throw new PreflightError('inventory_record', { file: inventory });
      if (row.kind !== undefined && !['json', 'lua', 'asset'].includes(row.kind))
        throw new PreflightError('inventory_kind', { file: inventory });
      if (
        options.rpc &&
        row.kind !== undefined &&
        !String(apps.package_validation?.file_kinds ?? '')
          .split(',')
          .includes(row.kind)
      )
        throw new PreflightError('target_inventory_kind', { file: inventory, detail: row.kind });
      if (previous && utf8Compare(previous, row.path) >= 0)
        throw new PreflightError('inventory_order', { file: inventory });
      previous = row.path;
      const destination = root ? root + '/' + row.path : row.path,
        actual = map.get(destination);
      if (
        destination === file ||
        destination === inventory ||
        !actual ||
        String(actual.size) !== row.bytes ||
        actual.sha256 !== row.sha256 ||
        (row.kind ?? null) !== (actual.kind ?? null)
      )
        throw new PreflightError('inventory_file_identity', { file: destination });
      listed.add(destination);
    }
    const payload = files.filter(
      (f) =>
        (!root || f.destination.startsWith(root + '/')) &&
        f.destination !== file &&
        f.destination !== inventory &&
        !options.controlFiles?.includes(f.destination),
    );
    if (payload.some((f) => !listed.has(f.destination)) || !listed.has(entry))
      throw new PreflightError('inventory_incomplete', { file: inventory });
    for (const item of payload)
      if (item.kind !== 'asset' && /\.json$/i.test(item.destination)) {
        if (textErrors.has(item.destination))
          throw new PreflightError('package_json', {
            file: item.destination,
            detail: textErrors.get(item.destination),
          });
        bounds(
          item.destination,
          item.size,
          apps.package_validation?.json_limit_bytes,
          'package_json_limit',
        );
      }
    await reference(entry, manifestByPath.get(entry).entry, root);
    packages.push({
      header: file,
      manifest: entry,
      inventory,
      inventory_sha256: header.inventory_sha256,
      id: manifestByPath.get(entry).id,
      files: [...listed],
    });
  }
  if (manifests.length && !headers.length) throw new PreflightError('package_header_required');
  if (headers.length && manifests.some(([p]) => !packages.some((pkg) => pkg.manifest === p)))
    throw new PreflightError('application_not_packaged');
  for (const [file, text] of lua) {
    let refs;
    try {
      refs = luaReferences(text);
    } catch (e) {
      throw new PreflightError('lua_reference_lexer', { file, detail: String(e) });
    }
    const pkg = packages.find((p) => p.files.includes(file)),
      root = pkg ? (posix.dirname(pkg.header) === '.' ? '' : posix.dirname(pkg.header)) : undefined;
    for (const ref of refs.modules) {
      if (ref.path) await reference(file, ref.path, root);
      else warnings.push({ code: 'dynamic_module_reference', file, line: ref.line });
    }
  }
  for (const [file, doc] of ui) {
    const pkg = packages.find((p) => p.files.includes(file)),
      scope = pkg
        ? posix.dirname(pkg.header) === '.'
          ? ''
          : posix.dirname(pkg.header)
        : undefined;
    bounds(
      file,
      map.get(file)!.size,
      uiCaps.max_document_bytes ?? apps.package_validation?.json_limit_bytes,
      'ui_document_limit',
    );
    if (doc.format === 'notes-app/1') {
      if (
        typeof doc.entry !== 'string' ||
        (doc.bindings !== undefined && !Array.isArray(doc.bindings))
      )
        throw new PreflightError('ui_application', { file });
      await reference(file, doc.entry, scope);
      continue;
    }
    await preflightUi(file, doc, {
      capabilities: uiCaps,
      reference: (file, path) => reference(file, path, scope),
      document: async (path) => {
        if (json.has(path)) return json.get(path);
        if (!options.rpc || !path.startsWith('/system/'))
          throw new PreflightError('ui_external_json', { file: path });
        const bytes = await readDeviceFile(
          async (p, m, a) => {
            const result = await read(p, m, a);
            return { ok: true, boot_id: boot!, result };
          },
          path,
          typeof uiCaps.max_document_bytes === 'number' ? uiCaps.max_document_bytes : 1024 * 1024,
          signal,
        );
        return JSON.parse(decoder.decode(bytes));
      },
      fileBytes: (path) => map.get(path)?.size,
    });
  }
  return {
    format: 'wishos-preflight/1',
    ok: true,
    validator_version: '2',
    content_sha256: contentIdentity(files),
    bytes: String(files.reduce((n, f) => n + f.size, 0)),
    files: files.map((f) => ({ path: f.destination, bytes: String(f.size), sha256: f.sha256 })),
    packages,
    lua: { parser: 'Lua 5.4.8', files: lua.length, ...(compiler ? compiler.profile : {}) },
    ...(boot ? { target_boot_id: boot } : {}),
    warnings,
    limits: {
      runtime_source_bytes: runtimeLimit ?? null,
      ...(runtime.budgets ? { runtime_budgets: runtime.budgets } : {}),
      ...(typeof runtime.memory_budget_semantics === 'string'
        ? { runtime_memory_budget_semantics: runtime.memory_budget_semantics }
        : {}),
      package: apps.package_validation ?? null,
      ...(apps.install_providers !== undefined
        ? {
            application_install_providers: apps.install_providers,
            factory_launcher: apps.factory_launcher,
          }
        : {}),
      ui_document_bytes: uiCaps.max_document_bytes ?? null,
    },
    scope:
      'Declared control files, recognized runtime/UI formats and Lua are checked; ordinary data assets use streamed integrity checks. Content/declared references and advertised requirements only; not arbitrary program semantics, execution peak memory, a heap reservation or successful future native activation',
  };
}
