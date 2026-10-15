import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readMounts } from '../src/device-storage.js';
import { deliverBundle } from '../src/bundle-transfer.js';
import type { BundleSource } from '../src/bundle-files.js';
import type { DeviceRpc } from '../src/os-remote.js';

test('mount enumeration follows returned cursors and keeps later-page providers without media operations', async () => {
  const calls: any[] = [];
  const rpc: DeviceRpc = async (path, method, args) => {
    calls.push({ path, method, args });
    return {
      ok: true,
      boot_id: 'boot',
      result:
        (args.cursor ?? 0) === 0
          ? { providers: [{ id: 'first', available: false }], next_cursor: 17, more: true }
          : { providers: [{ id: 'selected', available: true }], next_cursor: 18, more: false },
    };
  };
  const providers = await readMounts(rpc, AbortSignal.timeout(1000));
  assert.deepEqual(
    providers.map((p) => p.id),
    ['first', 'selected'],
  );
  assert.deepEqual(
    calls.map((c) => c.args.cursor ?? 0),
    [0, 17],
  );
  assert(calls.every((c) => c.path === '/fs' && c.method === 'mounts'));
  assert.equal(calls[1].args.expected_boot_id, 'boot');
});

test('an unpaginated legacy catalog ends when more is absent', async () => {
  let calls = 0;
  const providers = await readMounts(async (_path, _method, args) => {
    assert(!('cursor' in args) && !('limit' in args));
    calls++;
    return { ok: true, boot_id: 'old', result: { providers: [{ id: 'legacy' }] } };
  }, AbortSignal.timeout(1000));
  assert.deepEqual(providers, [{ id: 'legacy' }]);
  assert.equal(calls, 1);
});

test('boot changes, invalid continuations and cancellation never return a partial catalog', async () => {
  for (const next of [undefined, 0, 0x100000000]) {
    await assert.rejects(
      readMounts(
        async () => ({
          ok: true,
          boot_id: 'b',
          result: { providers: [{ id: 'partial' }], more: true, next_cursor: next },
        }),
        AbortSignal.timeout(1000),
      ),
      /storage_catalog_cursor/,
    );
  }
  let count = 0;
  await assert.rejects(
    readMounts(
      async () => ({
        ok: true,
        boot_id: ++count === 1 ? 'before' : 'after',
        result: { providers: [], more: count === 1, next_cursor: 4 },
      }),
      AbortSignal.timeout(1000),
    ),
    /device_boot_changed/,
  );
  const abort = new AbortController();
  count = 0;
  await assert.rejects(
    readMounts(async () => {
      count++;
      abort.abort(Error('cancelled'));
      return { ok: true, boot_id: 'b', result: { providers: [], more: true, next_cursor: 4 } };
    }, abort.signal),
    /cancelled/,
  );
  assert.equal(count, 1);
});

test('a later-page failure prevents media preparation and transfer begin rather than using a partial catalog', async () => {
  const bytes = Buffer.from('image'),
    calls: any[] = [],
    artifact = {
      id: 'a',
      path: 'host-only',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  const source: BundleSource = {
    get: () => artifact,
    open: async () => ({
      read: async (buffer, offset, length, position) => {
        const chunk = bytes.subarray(position, position + length);
        buffer.set(chunk, offset);
        return { bytesRead: chunk.length };
      },
      close: async () => {},
    }),
  };
  const rpc: DeviceRpc = async (path, method, args) => {
    calls.push({ path, method, args });
    if (path === '/sys/transfers' && method === 'read')
      return { ok: true, boot_id: 'b', result: { policy: { targets: [{ provider: 'partial' }] } } };
    if (path === '/fs' && method === 'mounts')
      return (args.cursor ?? 0) === 0
        ? {
            ok: true,
            boot_id: 'b',
            result: {
              providers: [
                {
                  id: 'partial',
                  available: false,
                  prepare: { path: '/dev/media', method: 'mount' },
                },
              ],
              more: true,
              next_cursor: 4,
            },
          }
        : { ok: false, boot_id: 'b', error: 'catalog_read_failed', result: {} };
    throw Error('unexpected_device_operation');
  };
  await assert.rejects(
    deliverBundle(
      rpc,
      [{ path: 'image.bin', artifact_id: 'a' }],
      AbortSignal.timeout(1000),
      'b',
      undefined,
      source,
    ),
    /catalog_read_failed/,
  );
  assert(!calls.some((c) => c.method === 'begin' || c.method === 'mount'));
});
