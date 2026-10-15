import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
export type BundleArtifact = {
  id: string;
  size: number;
  sha256: string;
  path: string;
  copy_from?: string;
};
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
  pin?(artifacts: BundleArtifact[]): () => void;
}
export type DeliveryFile = { path: string; artifact_id: string; kind?: 'json' | 'lua' | 'asset' };
export type ResolvedFile = DeliveryFile & BundleArtifact & { destination: string };
export function canonicalRelative(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    !!path &&
    path !== '.' &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/[\x00-\x1f\x7f]/.test(path) &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..')
  );
}
export function resolveReference(file: string, reference: string) {
  if (
    typeof reference !== 'string' ||
    !reference ||
    reference.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(reference)
  )
    throw Error('invalid_resource_reference');
  if (reference.startsWith('/')) return reference;
  const result = posix.normalize(posix.join(posix.dirname(file), reference));
  if (!canonicalRelative(result)) throw Error('resource_reference_escapes_revision');
  return result;
}
export const utf8Compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export function resolveFiles(source: BundleSource, files: DeliveryFile[]): ResolvedFile[] {
  if (!Array.isArray(files) || !files.length || files.length > 512)
    throw Error('artifact_file_count');
  const names = new Set<string>();
  const result = files.map((f) => {
    if (
      !f ||
      (f.kind !== undefined && !['json', 'lua', 'asset'].includes(f.kind)) ||
      !canonicalRelative(f.path) ||
      typeof f.artifact_id !== 'string' ||
      names.has(f.path)
    )
      throw Error('artifact_path');
    names.add(f.path);
    const a = source.get(f.artifact_id);
    if (!Number.isSafeInteger(a.size) || a.size < 0 || !/^[a-f0-9]{64}$/.test(a.sha256))
      throw Error('artifact_identity');
    return { ...f, ...a, destination: f.path };
  });
  for (const name of names) {
    let base = posix.dirname(name);
    while (base !== '.') {
      if (names.has(base)) throw Error('artifact_file_directory_collision');
      base = posix.dirname(base);
    }
  }
  return result;
}
export async function* artifactChunks(
  source: BundleSource,
  file: BundleArtifact,
  signal: AbortSignal,
  chunkBytes = 16384,
): AsyncGenerator<Uint8Array> {
  const reader = await source.open(file),
    buffer = new Uint8Array(chunkBytes);
  let offset = 0;
  try {
    while (offset < file.size) {
      signal.throwIfAborted();
      const { bytesRead } = await reader.read(
        buffer,
        0,
        Math.min(buffer.length, file.size - offset),
        offset,
      );
      if (!bytesRead || bytesRead > Math.min(buffer.length, file.size - offset))
        throw Error('artifact_short_read');
      offset += bytesRead;
      yield buffer.slice(0, bytesRead);
    }
  } finally {
    await reader.close();
  }
}
export async function readArtifact(
  source: BundleSource,
  file: BundleArtifact,
  limit: number,
  signal: AbortSignal,
) {
  if (file.size > limit) throw Error('preflight_text_limit');
  const chunks: Uint8Array[] = [];
  for await (const chunk of artifactChunks(source, file, signal)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
export async function verifyArtifact(
  source: BundleSource,
  file: BundleArtifact,
  signal: AbortSignal,
) {
  const hash = createHash('sha256');
  for await (const chunk of artifactChunks(source, file, signal)) hash.update(chunk);
  if (hash.digest('hex') !== file.sha256) throw Error('artifact_digest_mismatch');
}
export const contentIdentity = (files: ResolvedFile[]) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        [...files]
          .sort((a, b) => utf8Compare(a.destination, b.destination))
          .map((f) => [f.destination, String(f.size), f.sha256, f.kind ?? null]),
      ),
    )
    .digest('hex');
