import type { Action } from './actions.js';
import type { BundleSource, DeliveryFile } from './bundle-files.js';
import { readArtifact, resolveFiles } from './bundle-files.js';
import { PreflightError, type PreflightReport } from './preflight.js';
import { preflightInvocation } from './preflight-call.js';
import type { LuaCompilerFactory } from './lua-compiler.js';
import type { DeviceRpc } from './os-remote.js';
const reference = (value: any, key: string) =>
  value &&
  typeof value === 'object' &&
  Object.keys(value).length === 1 &&
  typeof value[key] === 'string';
const hasPrevious = (value: any): boolean =>
  Array.isArray(value)
    ? value.some(hasPrevious)
    : value && typeof value === 'object'
      ? reference(value, '$previous') || Object.values(value).some(hasPrevious)
      : false;
/** Checks statically knowable executable actions without applying their effects
 * or rewriting an ordered plan. Native validation owns future result references. */
export async function preflightAction(
  action: Action,
  context: {
    source: BundleSource;
    files: DeliveryFile[];
    report?: PreflightReport;
    rpc: DeviceRpc;
    compiler: LuaCompilerFactory;
    signal: AbortSignal;
  },
) {
  if (action.type !== 'system') return;
  let { path, method, args } = action;
  if (path === '/sys/operations' && method === 'request') {
    if (
      typeof args.path !== 'string' ||
      typeof args.method !== 'string' ||
      (args.args != null && (typeof args.args !== 'object' || Array.isArray(args.args)))
    )
      throw new PreflightError('operation_request');
    return preflightAction(
      {
        type: 'system',
        path: args.path,
        method: args.method,
        args: (args.args ?? {}) as Record<string, unknown>,
      },
      context,
    );
  }
  if (path === '/sys/apps' && ['validate', 'install'].includes(method)) {
    if (reference(args.package, '$asset')) {
      const pkg = context.report?.packages.find((p) => p.header === (args.package as any).$asset);
      if (
        !pkg ||
        !reference(args.manifest, '$asset') ||
        pkg.manifest !== (args.manifest as any).$asset
      )
        throw new PreflightError('managed_package_reference');
    }
    if (method === 'install') {
      const descriptor = await context.rpc('/sys/capabilities', 'describe', { path });
      if (!descriptor.ok) throw new PreflightError('target_capability');
      if (
        descriptor.result.package_install?.validation_required &&
        (!args.package ||
          (!Number.isSafeInteger(args.validation_id) &&
            !reference(args.validation_id, '$previous')) ||
          (!Number.isSafeInteger(args.expected_revision) &&
            !reference(args.expected_revision, '$previous')))
      )
        throw new PreflightError('package_validation_ticket_required');
    }
  }
  if (path === '/sys/runtime' && ['load', 'restart', 'validate'].includes(method)) {
    if (reference(args.file, '$asset')) {
      const file = resolveFiles(context.source, context.files).find(
        (f) => f.destination === (args.file as any).$asset,
      );
      if (!file) throw new PreflightError('runtime_asset_missing');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await readArtifact(context.source, file, 1024 * 1024, context.signal),
      );
      const { file: _, ...parameters } = args;
      args = { ...parameters, source: text };
    }
    if (!hasPrevious(args))
      await preflightInvocation(context.rpc, context.compiler, path, method, args, context.signal);
  }
}
