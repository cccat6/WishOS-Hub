import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import type { DeviceRpc } from './os-remote.js';
export type BundleArtifact = { id: string; size: number; sha256: string; path: string };
export interface BundleReader {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface BundleSource {
  get(id: string): BundleArtifact;
  open(artifact: BundleArtifact): Promise<BundleReader>;
}
export async function deliverBundle(
  transport: DeviceRpc,
  files: { path: string; artifact_id: string }[],
  signal: AbortSignal,
  expectedBoot: string | undefined,
  remoteRequestId: number | undefined,
  source: BundleSource,
) {
  let boot = expectedBoot;
  const rpc: DeviceRpc = async (path, method, args) => {
    const reply = await transport(path, method, {
      ...args,
      ...(boot ? { expected_boot_id: boot } : {}),
    });
    if (boot && reply.boot_id !== boot) throw Error('device_boot_changed');
    boot = reply.boot_id;
    return reply;
  };
  if (!files.length || files.length > 512) throw Error('artifact_file_count');
  const names = new Set<string>();
  const resolved = files.map((f) => {
    if (
      !f.path ||
      f.path.startsWith('/') ||
      posix.normalize(f.path) !== f.path ||
      f.path.split('/').includes('..') ||
      f.path.includes('\\') ||
      names.has(f.path)
    )
      throw Error('artifact_path');
    names.add(f.path);
    return { ...f, ...source.get(f.artifact_id), destination: f.path };
  });
  const call = async (method: string, args: any) => {
    signal.throwIfAborted();
    for (;;) {
      signal.throwIfAborted();
      const r = await rpc('/sys/transfers', method, args);
      if (r.ok) return r.result;
      if (['spi_busy', 'resource_busy', 'operation_active'].includes(r.error ?? '')) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      throw Error(r.error ?? 'transfer_failed');
    }
  };
  const total = resolved.reduce((n, f) => n + f.size, 0),
    key = Buffer.from(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify(resolved.map((f) => [f.destination, f.sha256, f.size])),
        ),
      ),
    ).toString('hex');
  const prepare = async (p: any) => {
    const description = await rpc('/sys/capabilities', 'describe', { path: p.path });
    if (!description.ok) throw Error(description.error);
    const async = description.result?.async?.[p.method];
    let result = await rpc(
      async ? '/sys/operations' : p.path,
      async ? 'request' : p.method,
      async ? { path: p.path, method: p.method, args: p.args ?? {} } : (p.args ?? {}),
    );
    if (result.ok && result.result.completion_id) {
      const id = result.result.completion_id;
      try {
        for (;;) {
          signal.throwIfAborted();
          const r = await rpc('/sys/operations', 'read', { id });
          if (!r.ok) throw Error(r.error);
          if (r.result.ready) {
            result = { ...r, ok: async.success_events.includes(r.result.event) };
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      } finally {
        await rpc('/sys/operations', 'release', { id });
      }
    }
    return result;
  };
  // Explicit delivery can prepare/refresh storage; discovery remains read-only.
  const policy = await call('read', {});
  let volumes = await rpc('/fs', 'mounts', {});
  if (volumes.ok)
    for (const target of policy.policy?.targets ?? []) {
      let volume = volumes.result.providers.find((p: any) => p.id === target.provider);
      if (!volume) continue;
      if (!volume.available) {
        if (!volume.prepare) continue;
        const result = await prepare(volume.prepare);
        if (!result.ok) {
          const error = result.error ?? result.result?.data?.error ?? 'storage_preparation_failed';
          if (/memory|budget|busy|active|timeout|cancel/.test(error)) throw Error(error);
          const state = await rpc(volume.prepare.path, 'read', {});
          if (state.ok && state.result.link_ready) throw Error('storage_volume_unavailable');
          continue;
        }
        volumes = await rpc('/fs', 'mounts', {});
        volume = volumes.result.providers.find((p: any) => p.id === target.provider);
      }
      if (volume.capacity_refresh && (volume.free_needs_refresh || volume.free_bytes == null)) {
        const r = await prepare(volume.capacity_refresh);
        if (!r.ok) throw Error('storage_capacity_unavailable');
      }
      break;
    }
  const start = await call('begin', {
    request_id: key,
    ...(remoteRequestId ? { remote_request_id: remoteRequestId } : {}),
    bytes: String(total),
    files: files.length,
  });
  let committed = start.state === 'committed';
  if (committed) return { transfer_id: start.id, root: start.root };
  try {
    for (const item of resolved.slice(start.files_complete ?? 0)) {
      const file = await source.open(item);
      try {
        const opened = await call('file', {
          id: start.id,
          path: item.destination,
          bytes: String(item.size),
          sha256: item.sha256,
        });
        const bytes = Buffer.alloc(start.chunk_bytes);
        let offset = Number(opened.file_offset ?? 0);
        while (offset < item.size) {
          const { bytesRead } = await file.read(
            bytes,
            0,
            Math.min(bytes.length, item.size - offset),
            offset,
          );
          if (!bytesRead) throw Error('artifact_short_read');
          await call('chunk', {
            id: start.id,
            offset: String(offset),
            hex: bytes.subarray(0, bytesRead).toString('hex'),
          });
          offset += bytesRead;
        }
        await call('close_file', { id: start.id });
      } finally {
        await file.close();
      }
    }
    const receipt = await call('commit', { id: start.id });
    committed = true;
    return { transfer_id: start.id, root: receipt.root };
  } catch (error) {
    if (
      error instanceof Error &&
      !/disconnected|transport|outcome_unknown|timeout/i.test(error.message)
    )
      await rpc('/sys/transfers', 'abort', { id: start.id }).catch(() => {});
    throw error;
  }
}
