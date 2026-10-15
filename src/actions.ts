import { posix } from 'node:path';
export type ApplicationAction = {
  type: 'application';
  recipient?: 'origin' | 'foreground';
  topic?: string;
  data: Record<string, unknown>;
  wait?: 'processed' | 'queued';
};
export type SystemAction = {
  type: 'system';
  path: string;
  method: string;
  args: Record<string, unknown>;
};
export type Action = ApplicationAction | SystemAction;
export type ManagedResult = {
  format: 'wishos-result/2';
  operation_id?: string;
  actions?: Action[];
  sequence?: { path: string; format: 'jsonl' };
  files?: { path: string; artifact_id: string; kind?: 'json' | 'lua' | 'asset' }[];
  transfer_id?: number;
};
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function relativeResource(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    posix.normalize(value) === value &&
    !value.split('/').includes('..') &&
    value !== '.'
  );
}
export function validateAction(value: unknown): asserts value is Action {
  if (!object(value) || !['application', 'system'].includes(String(value.type)))
    throw Error('managed_action_type');
  const keys =
    value.type === 'system'
      ? ['type', 'path', 'method', 'args']
      : ['type', 'recipient', 'topic', 'data', 'wait'];
  if (Object.keys(value).some((k) => !keys.includes(k))) throw Error('managed_action_field');
  if (value.type === 'system') {
    if (
      typeof value.path !== 'string' ||
      !value.path.startsWith('/') ||
      typeof value.method !== 'string' ||
      !value.method ||
      !object(value.args)
    )
      throw Error('managed_system_action');
  } else if (
    !object(value.data) ||
    (value.recipient !== undefined &&
      !['origin', 'foreground'].includes(String(value.recipient))) ||
    (value.wait !== undefined && !['processed', 'queued'].includes(String(value.wait))) ||
    (value.topic !== undefined && typeof value.topic !== 'string')
  )
    throw Error('managed_application_action');
  validateReferences(value);
}
export function validateReferences(value: unknown, assets?: string[]) {
  if (Array.isArray(value)) {
    for (const x of value) validateReferences(x, assets);
    return;
  }
  if (!object(value)) return;
  if ('$asset' in value) {
    if (Object.keys(value).length !== 1 || !relativeResource(value.$asset))
      throw Error('managed_asset_reference');
    if (assets && !assets.some((p) => p === value.$asset || p.startsWith(value.$asset + '/')))
      throw Error('managed_asset_missing');
    return;
  }
  if ('$previous' in value) {
    if (Object.keys(value).length !== 1 || typeof value.$previous !== 'string')
      throw Error('managed_previous_reference');
    return;
  }
  for (const item of Object.values(value)) validateReferences(item, assets);
}
export function parseManagedResult(raw: string): ManagedResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      format: 'wishos-result/2',
      actions: [{ type: 'application', recipient: 'origin', data: { text: raw } }],
    };
  }
  if (!object(value) || value.format !== 'wishos-result/2') throw Error('managed_result_format');
  if (
    Object.keys(value).some(
      (k) => !['format', 'operation_id', 'actions', 'sequence', 'files'].includes(k),
    )
  )
    throw Error('managed_result_field');
  if ((value.actions === undefined) === (value.sequence === undefined))
    throw Error('managed_sequence_source');
  if (
    value.operation_id !== undefined &&
    (typeof value.operation_id !== 'string' || value.operation_id.length > 64)
  )
    throw Error('managed_operation_identity');
  const files = value.files;
  if (
    files !== undefined &&
    (!Array.isArray(files) ||
      files.some(
        (f) =>
          !object(f) ||
          Object.keys(f).some((k) => !['path', 'artifact_id', 'kind'].includes(k)) ||
          !relativeResource(f.path) ||
          typeof f.artifact_id !== 'string' ||
          (f.kind !== undefined && !['json', 'lua', 'asset'].includes(String(f.kind))),
      ))
  )
    throw Error('managed_files');
  const paths = (files as { path: string }[] | undefined)?.map((f) => f.path) ?? [];
  if (new Set(paths).size !== paths.length) throw Error('managed_file_duplicate');
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions)) throw Error('managed_actions');
    for (const a of value.actions) {
      validateAction(a);
      validateReferences(a, paths);
    }
  }
  if (value.sequence !== undefined) {
    const s = value.sequence;
    if (
      !object(s) ||
      Object.keys(s).some((k) => !['path', 'format'].includes(k)) ||
      s.format !== 'jsonl' ||
      !relativeResource(s.path) ||
      !paths.includes(s.path)
    )
      throw Error('managed_sequence_artifact');
  }
  return value as ManagedResult;
}
