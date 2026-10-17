import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import type { DeviceRpc } from './os-remote.js';
import type { BundleReader } from './bundle-files.js';
export function bootRpc(rpc: DeviceRpc, boot?: string): DeviceRpc {
  return async (path, method, args, scheduling) => {
    const r = await rpc(
      path,
      method,
      { ...args, ...(boot ? { expected_boot_id: boot } : {}) },
      scheduling,
    );
    if (boot && r.boot_id !== boot) throw Error('device_boot_changed');
    return r;
  };
}
export async function deviceFileReader(
  rpc: DeviceRpc,
  file: string,
  expectedSize?: number,
): Promise<BundleReader & { size: number }> {
  if (typeof file !== 'string' || !file.startsWith('/') || file.includes('\0'))
    throw Error('device_path');
  const stat = await rpc('/fs', 'stat', { file });
  if (!stat.ok || stat.result.directory) throw Error(stat.error ?? 'not_a_file');
  const size = Number(stat.result.size);
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    (expectedSize !== undefined && size !== expectedSize)
  )
    throw Error('device_file_identity');
  return {
    size,
    read: async (buffer, offset, length, position) => {
      const r = await rpc('/fs', 'read', {
        file,
        offset: String(position),
        length: Math.min(length, 128),
      });
      if (!r.ok) throw Error(r.error ?? 'device_file_read');
      if (
        typeof r.result.hex !== 'string' ||
        r.result.hex.length % 2 ||
        !/^[a-f0-9]*$/i.test(r.result.hex)
      )
        throw Error('device_file_hex');
      const data = Buffer.from(r.result.hex, 'hex');
      if (data.length > length || Number(r.result.next_offset) !== position + data.length)
        throw Error('device_file_offset');
      buffer.set(data, offset);
      return { bytesRead: data.length };
    },
    close: async () => {},
  };
}
export async function readDeviceFile(
  rpc: DeviceRpc,
  file: string,
  limit: number,
  signal: AbortSignal,
) {
  const reader = await deviceFileReader(rpc, file);
  try {
    if (reader.size > limit) throw Error('device_file_limit');
    const bytes = Buffer.alloc(reader.size);
    let at = 0;
    while (at < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await reader.read(bytes, at, bytes.length - at, at);
      if (!bytesRead) throw Error('device_file_short_read');
      at += bytesRead;
    }
    return bytes;
  } finally {
    await reader.close();
  }
}
export function absoluteReference(file: string, ref: string) {
  const result = posix.resolve(posix.dirname(file), ref);
  if (!result.startsWith('/')) throw Error('device_path');
  return result;
}
