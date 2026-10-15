import { z } from 'zod';
import { resolveFiles, type BundleSource } from './bundle-files.js';
import type { DeviceRpc } from './os-remote.js';
import type { LuaCompilerFactory } from './lua-compiler.js';
import { preflightBundle, PreflightError } from './preflight.js';
import { preparePackage, prepareUpdate, deployPackage, type StageText } from './packages.js';
const file = z
  .object({
    path: z.string(),
    artifact_id: z.string(),
    kind: z.enum(['json', 'lua', 'asset']).optional(),
  })
  .strict();
const target = { device_id: z.string().optional(), expected_boot_id: z.string().optional() };
const schemas = {
  preflight: z.object({ ...target, files: z.array(file).min(1) }).strict(),
  package_prepare: z
    .object({ ...target, files: z.array(file).min(1), manifest: z.string().default('app.json') })
    .strict(),
  package_deploy: z
    .object({
      device_id: z.string(),
      expected_boot_id: z.string(),
      files: z.array(file).min(1),
      package: z.string().optional(),
      expected_revision: z.number().int().nonnegative().optional(),
      persist: z.boolean().default(true),
      activate: z.boolean().default(false),
    })
    .strict(),
  package_update: z
    .object({
      device_id: z.string(),
      expected_boot_id: z.string(),
      application_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      replacements: z.array(file),
      delete: z.array(z.string()).default([]),
      persist: z.boolean().default(true),
      activate: z.boolean().default(false),
    })
    .strict(),
};
export const packageJobKinds = Object.keys(schemas);
export async function runPackageJob(
  kind: string,
  raw: unknown,
  context: {
    source: BundleSource;
    stage: StageText;
    compiler: LuaCompilerFactory;
    rpc?: (id: string) => DeviceRpc;
    signal: AbortSignal;
  },
) {
  const schema = (schemas as Record<string, z.ZodTypeAny>)[kind];
  if (!schema) throw Error('package_job_kind');
  const input = schema.parse(raw);
  if (input.device_id && !input.expected_boot_id) throw new PreflightError('target_boot_required');
  const rpc = input.device_id ? context.rpc?.(input.device_id) : undefined,
    options = {
      compiler: context.compiler,
      signal: context.signal,
      rpc,
      expectedBoot: input.expected_boot_id,
    };
  if (input.device_id && !rpc) throw new PreflightError('target_unavailable');
  if (kind === 'preflight') return preflightBundle(context.source, input.files, options);
  if (kind === 'package_prepare')
    return preparePackage(context.source, context.stage, input.files, input.manifest, options);
  if (kind === 'package_deploy')
    return deployPackage(context.source, input.files, rpc!, input.expected_boot_id, {
      ...options,
      ...input,
    });
  const release = context.source.pin?.(
    input.replacements.length ? resolveFiles(context.source, input.replacements) : [],
  );
  try {
    const prepared = await prepareUpdate(
      context.source,
      context.stage,
      rpc!,
      input.expected_boot_id,
      input,
      options,
    );
    const result = await deployPackage(
      prepared.source,
      prepared.files,
      rpc!,
      input.expected_boot_id,
      { ...options, ...input, expected_revision: prepared.base.revision },
    );
    return {
      ...result,
      base: prepared.base,
      changed_files: prepared.changed_files,
      copied_files: prepared.copied_files,
      deleted_files: prepared.deleted_files,
    };
  } finally {
    release?.();
  }
}
