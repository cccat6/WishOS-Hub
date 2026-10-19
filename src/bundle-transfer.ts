import { readMounts } from './device-storage.js';
import { ResourceReplyError } from './resource-reply-error.js';
import { TransportFailure } from './transport-failure.js';
import { Buffer } from 'node:buffer';
import type { DeviceRpc } from './os-remote.js';
import { resolveFiles, type BundleSource } from './bundle-files.js';
import { preflightBundle, checkApplicationStorage, type PreflightOptions } from './preflight.js';
export type { BundleArtifact, BundleReader, BundleSource } from './bundle-files.js';
export async function deliverBundle(
  transport: DeviceRpc,
  files: { path: string; artifact_id: string }[],
  signal: AbortSignal,
  expectedBoot: string | undefined,
  remoteRequestId: number | undefined,
  source: BundleSource,
  options: Pick<PreflightOptions, 'compiler' | 'controlFiles'> & {
    provider?: string;
    lifetime?: 'request';
  } = {},
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
  const resolved = resolveFiles(source, files),
    releaseSources = source.pin?.(resolved);
  try {
    const preflight = await preflightBundle(source, files, {
      ...options,
      rpc,
      expectedBoot,
      signal,
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
        throw new ResourceReplyError(r);
      }
    };
    const total = resolved.reduce((n, f) => n + f.size, 0),
      key = Buffer.from(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(
            JSON.stringify(
              options.provider || options.lifetime
                ? {
                    files: resolved.map((f) => [f.destination, f.sha256, f.size]),
                    provider: options.provider,
                    lifetime: options.lifetime,
                  }
                : resolved.map((f) => [f.destination, f.sha256, f.size]),
            ),
          ),
        ),
      ).toString('hex');
    const prepare = async (p: any) => {
      signal.throwIfAborted();
      const description = await rpc('/sys/capabilities', 'describe', { path: p.path });
      if (!description.ok) throw new ResourceReplyError(description);
      signal.throwIfAborted();
      const async = description.result?.async?.[p.method];
      let completionId: unknown;
      try {
        let result = await rpc(
          async ? '/sys/operations' : p.path,
          async ? 'request' : p.method,
          async ? { path: p.path, method: p.method, args: p.args ?? {} } : (p.args ?? {}),
        );
        if (result.ok && result.result.completion_id) {
          const id = result.result.completion_id;
          completionId = id;
          try {
            for (;;) {
              signal.throwIfAborted();
              const r = await rpc('/sys/operations', 'read', { id });
              if (!r.ok) throw new ResourceReplyError(r);
              if (r.result.ready) {
                const ok = async?.success_events?.includes(r.result.event) === true;
                result = {
                  ...r,
                  ok,
                  ...(!ok ? { error: r.result.data?.error ?? 'storage_preparation_failed' } : {}),
                };
                break;
              }
              await new Promise((r) => setTimeout(r, 25));
            }
          } finally {
            const released = await rpc('/sys/operations', 'release', { id });
            if (!released.ok) throw new ResourceReplyError(released);
          }
        }
        return result;
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : Error(String(error)), {
          transfer_receipt: {
            request_id: key,
            state: 'not_dispatched',
            expected_boot_id: boot,
            preparation: {
              path: p.path,
              method: p.method,
              completion_id: completionId,
              state:
                error instanceof ResourceReplyError
                  ? 'failed'
                  : error instanceof TransportFailure && !error.dispatched
                    ? 'not_dispatched'
                    : 'outcome_unknown',
            },
          },
        });
      }
    };
    // Follow policy order; preparation and capacity scanning occur only for an
    // explicit delivery, never discovery. Re-read the selection after each change.
    const storageSnapshot = async () => {
      const policy = (await call('read', {})).policy ?? {};
      if (options.provider) {
        const targets = policy.targets?.filter((t: any) => t.provider === options.provider);
        if (!targets?.length) throw Error('transfer_target_not_allowed');
        return { policy: { ...policy, targets }, volumes: await readMounts(rpc, signal) };
      }
      return { policy, volumes: await readMounts(rpc, signal) };
    };
    const capacityStale = (volume: any) =>
      volume.free_needs_refresh === true ||
      (Object.hasOwn(volume, 'volume_capacity_bytes') &&
        (volume.volume_capacity_bytes == null || volume.free_bytes == null));
    const prepareStorage = async (forceRefresh = false) => {
      let snapshot = await storageSnapshot();
      const mounted = new Set<string>(),
        refreshed = new Set<string>();
      for (;;) {
        signal.throwIfAborted();
        let selected: any, pending: any;
        for (const target of snapshot.policy.targets ?? []) {
          if (!options.provider && target.explicit_only) continue;
          const volume = snapshot.volumes.find((p: any) => p.id === target.provider);
          if (!volume) continue;
          if (volume.available) {
            selected = volume;
            break;
          }
          if (volume.prepare && !mounted.has(volume.id)) {
            pending = volume;
            break;
          }
        }
        if (pending) {
          mounted.add(pending.id);
          const result = await prepare(pending.prepare);
          if (!result.ok) {
            const error =
              result.error ?? result.result?.data?.error ?? 'storage_preparation_failed';
            if (/memory|budget|busy|active|timeout|cancel/.test(error))
              throw new ResourceReplyError({ ...result, error });
            const state = await rpc(pending.prepare.path, 'read', {});
            if (!state.ok) throw new ResourceReplyError(state);
            if (state.result.link_ready !== false)
              throw new ResourceReplyError({
                ...result,
                error: state.result.link_ready === true ? 'storage_volume_unavailable' : error,
              });
          }
          snapshot = await storageSnapshot();
          continue;
        }
        if (selected && (forceRefresh || capacityStale(selected))) {
          if (!selected.capacity_refresh || refreshed.has(selected.id))
            throw new ResourceReplyError({
              boot_id: boot!,
              ok: false,
              error: 'storage_space_refresh_required',
              result: {},
            });
          refreshed.add(selected.id);
          const result = await prepare(selected.capacity_refresh);
          if (!result.ok)
            throw new ResourceReplyError({
              ...result,
              error: result.error ?? result.result?.data?.error ?? 'storage_capacity_unavailable',
            });
          forceRefresh = false;
          snapshot = await storageSnapshot();
          continue;
        }
        return snapshot;
      }
    };
    const checkPackageStorage = async () => {
      if (!preflight.packages.length) return;
      const apps = await rpc('/sys/capabilities', 'describe', { path: '/sys/apps' });
      if (!apps.ok) throw new ResourceReplyError(apps);
      if (apps.result.install_providers !== undefined) {
        const snapshot = await storageSnapshot();
        checkApplicationStorage(apps.result, snapshot.policy, snapshot.volumes, false);
      }
    };
    if (options.provider || options.lifetime) {
      const cap = await rpc('/sys/capabilities', 'describe', { path: '/sys/transfers' });
      if (
        !cap.ok ||
        cap.result.begin_options?.provider?.selection !== 'declared_policy_target' ||
        !cap.result.begin_options?.lifetime?.choices?.includes(options.lifetime ?? 'retained')
      )
        throw Error('transfer_options_unavailable');
      if (options.lifetime === 'request' && !remoteRequestId)
        throw Error('transfer_request_lifetime_identity');
    }
    await prepareStorage();
    await checkPackageStorage();
    const beginArgs = {
      request_id: key,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.lifetime ? { lifetime: options.lifetime } : {}),
      ...(remoteRequestId ? { remote_request_id: remoteRequestId } : {}),
      bytes: String(total),
      files: files.length,
    };
    let beginState = 'not_dispatched';
    const begin = async () => {
      try {
        return await call('begin', beginArgs);
      } catch (error) {
        beginState =
          error instanceof ResourceReplyError
            ? 'rejected'
            : error instanceof TransportFailure && !error.dispatched
              ? 'not_dispatched'
              : 'begin_outcome_unknown';
        throw error;
      }
    };
    let start;
    try {
      try {
        start = await begin();
      } catch (error) {
        // These native begin refusals precede transaction/media changes. Never
        // infer this permission from a transport exception or a similar message.
        if (
          !(error instanceof ResourceReplyError) ||
          !['storage_space_refresh_required', 'storage_preparation_required'].includes(
            error.reply.error ?? '',
          )
        )
          throw error;
        await prepareStorage(error.reply.error === 'storage_space_refresh_required');
        await checkPackageStorage();
        start = await begin();
      }
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : Error(String(error)), {
        transfer_receipt: {
          ...((error as any)?.transfer_receipt ?? {}),
          request_id: key,
          state: beginState,
          expected_boot_id: boot,
        },
      });
    }
    let committed = start.state === 'committed';
    if (committed) return { transfer_id: start.id, root: start.root, preflight };
    try {
      for (const item of resolved.slice(start.files_complete ?? 0)) {
        if (item.copy_from) {
          await call('copy_file', {
            id: start.id,
            path: item.destination,
            source: item.copy_from,
            bytes: String(item.size),
            sha256: item.sha256,
          });
          for (;;) {
            const state = await call('read', {});
            if (state.id !== start.id) throw Error('transfer_identity_changed');
            if (state.state === 'aborted') throw Error(state.error ?? 'local_copy_failed');
            if (state.state !== 'copying') {
              if (
                state.state !== 'receiving' ||
                state.files_complete !== resolved.indexOf(item) + 1
              )
                throw Error('local_copy_completion');
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          continue;
        }
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
      return { transfer_id: start.id, root: receipt.root, preflight };
    } catch (error) {
      if (
        error instanceof Error &&
        !/disconnected|transport|outcome_unknown|timeout/i.test(error.message)
      )
        await rpc('/sys/transfers', 'abort', { id: start.id }).catch(() => {});
      throw Object.assign(error instanceof Error ? error : Error(String(error)), {
        transfer_receipt: {
          request_id: key,
          transfer_id: start.id,
          root: start.root,
          committed,
          expected_boot_id: boot,
        },
      });
    }
  } finally {
    releaseSources?.();
  }
}
