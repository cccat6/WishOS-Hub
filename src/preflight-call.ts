import { Buffer } from 'node:buffer';
import type { DeviceRpc } from './os-remote.js';
import type { LuaCompilerFactory } from './lua-compiler.js';
import { PreflightError } from './preflight.js';
import { bootRpc, readDeviceFile } from './device-files.js';
/** Gate executable/admission calls, including their generic tracked-operation
 * wrapper. Ordinary file writes are data storage, not application admission. */
export async function preflightInvocation(
  rpc: DeviceRpc,
  compiler: LuaCompilerFactory,
  path: string,
  method: string,
  args: Record<string, any>,
  signal: AbortSignal,
  depth = 0,
): Promise<void> {
  if (path === '/sys/operations' && method === 'request') {
    if (
      depth > 8 ||
      typeof args.path !== 'string' ||
      typeof args.method !== 'string' ||
      !args.args ||
      typeof args.args !== 'object'
    )
      throw new PreflightError('operation_request');
    return preflightInvocation(rpc, compiler, args.path, args.method, args.args, signal, depth + 1);
  }
  const read = async (p: string, m: string, a: Record<string, unknown> = {}) => {
    const r = await rpc(p, m, a);
    if (!r.ok) throw new PreflightError('target_preparation', { detail: p + ':' + r.error });
    return r.result;
  };
  if (path === '/sys/runtime' && ['load', 'restart', 'validate'].includes(method)) {
    const metadata = await read('/sys/capabilities', 'describe', { path }),
      state = await read(path, 'read');
    for (const key of ['memory_bytes', 'instruction_budget', 'system_call_budget'])
      if (args[key] !== undefined && args[key] !== null) {
        const b = metadata.budgets?.[key],
          n = args[key];
        if (
          !Number.isInteger(n) ||
          n <= 0 ||
          (b?.minimum !== undefined && n < b.minimum) ||
          (b?.maximum !== undefined && n > b.maximum)
        )
          throw new PreflightError('runtime_budget', { detail: key });
      }
    let source = args.source,
      file = args.file;
    if (source !== undefined && file !== undefined) throw new PreflightError('one_runtime_source');
    if (source === undefined) {
      if (!file && method === 'restart') file = state.file;
      if (typeof file !== 'string' || !file) throw new PreflightError('runtime_file_required');
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await readDeviceFile(
          rpc,
          file,
          metadata.entry_source_limit_bytes ?? state.source_limit_bytes ?? 1024 * 1024,
          signal,
        ),
      );
    }
    if (typeof source !== 'string' || !source || source.includes('\0'))
      throw new PreflightError('runtime_source');
    const max = metadata.entry_source_limit_bytes ?? state.source_limit_bytes;
    if (typeof max === 'number' && Buffer.byteLength(source) > max)
      throw new PreflightError('lua_source_limit', { file });
    const parser = await compiler(),
      depth = metadata.native_call_depth_limit ?? state.native_call_depth_limit;
    if (typeof depth === 'number' && depth !== parser.profile.native_call_depth_limit)
      throw new PreflightError('lua_parser_profile_mismatch');
    const result = parser.check(source, file ?? 'application.lua');
    if (!result.ok)
      throw new PreflightError('lua_syntax', { file, line: result.line, detail: result.error });
  }
  if (path === '/sys/apps' && method === 'install') {
    const metadata = await read('/sys/capabilities', 'describe', { path });
    if (metadata.package_install?.validation_required) {
      if (
        typeof args.manifest !== 'string' ||
        typeof args.package !== 'string' ||
        !Number.isSafeInteger(args.validation_id) ||
        !Number.isSafeInteger(args.expected_revision)
      )
        throw new PreflightError('package_validation_ticket_required');
      const statusMethod = metadata.package_validation?.status_method;
      if (typeof statusMethod !== 'string') throw new PreflightError('package_validation_schema');
      const status = await read(path, statusMethod, { operation_id: args.validation_id });
      if (
        status.state !== 'validated' ||
        status.manifest !== args.manifest ||
        status.package !== args.package ||
        status.revision !== args.expected_revision
      )
        throw new PreflightError('package_validation_ticket_mismatch');
    }
  }
  if (path === '/sys/ui' && ['open', 'app_load'].includes(method)) {
    const metadata = await read('/sys/capabilities', 'describe', { path });
    const check = method === 'app_load' ? 'validate_app' : 'validate';
    if (
      String(metadata.methods ?? '')
        .split(',')
        .includes(check)
    ) {
      const parameters =
        method === 'app_load'
          ? { file: args.file }
          : Object.fromEntries(
              ['path', 'rotation', 'values', 'focus', 'hidden', 'driver']
                .filter((k) => args[k] !== undefined)
                .map((k) => [k, args[k]]),
            );
      await read(path, check, parameters);
    }
  }
}

/** Rejections precede the requested mutation and retain a known not-dispatched receipt. */
export async function guardedInvocation(
  rpc: DeviceRpc,
  compiler: LuaCompilerFactory,
  path: string,
  method: string,
  args: Record<string, any>,
  signal: AbortSignal,
  boot: string,
) {
  const checked = bootRpc(
    rpc,
    typeof args.expected_boot_id === 'string' ? args.expected_boot_id : boot,
  );
  try {
    await preflightInvocation(checked, compiler, path, method, args, signal);
  } catch (error) {
    return {
      ok: false,
      boot_id: boot,
      error: error instanceof Error ? error.message : 'preflight_unavailable',
      result: {
        not_dispatched: true,
        ...(error instanceof PreflightError ? { diagnostics: error.diagnostics } : {}),
      },
    };
  }
  return rpc(path, method, args);
}
