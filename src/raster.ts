import { z } from 'zod';
export const MAX_RLE_BYTES = 6000;
export const MAX_RASTER_BYTES = 8000;
export const MAX_STREAM_RASTER_BYTES = 180000;
export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const palette = [0, 1, 2, 3, 5, 6];
function lz4Valid(p: Buffer, expected: number, bits: number, count: number) {
  let at = 0,
    used = 0;
  while (at < p.length) {
    const token = p[at++]!;
    let literals = token >>> 4;
    if (literals === 15) {
      let v: number;
      do {
        if (at >= p.length) return false;
        v = p[at++]!;
        literals += v;
        if (literals > expected) return false;
      } while (v === 255);
    }
    if (literals > p.length - at || literals > expected - used) return false;
    for (let j = 0; j < literals; j++)
      for (let shift = 8 - bits; shift >= 0; shift -= bits)
        if (((p[at + j]! >>> shift) & ((1 << bits) - 1)) >= count) return false;
    at += literals;
    used += literals;
    if (at === p.length) return used === expected;
    if (at + 2 > p.length) return false;
    const offset = p.readUInt16LE(at);
    at += 2;
    if (!offset || offset > used) return false;
    let match = (token & 15) + 4;
    if ((token & 15) === 15) {
      let v: number;
      do {
        if (at >= p.length) return false;
        v = p[at++]!;
        match += v;
        if (match > expected) return false;
      } while (v === 255);
    }
    if (match > expected - used) return false;
    used += match;
  }
  return false;
}
export function rasterFormat(data: string): 'nmr1' | 'nmp1' {
  return Buffer.from(data, 'base64').toString('ascii', 0, 4) === 'NMP1' ? 'nmp1' : 'nmr1';
}
export function validRaster(encoded: string, maximum = MAX_RASTER_BYTES): boolean {
  if (
    encoded.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  )
    return false;
  const b = Buffer.from(encoded, 'base64');
  if (
    b.length < 15 ||
    b.length > maximum ||
    b.toString('base64') !== encoded ||
    b.readUInt16LE(4) !== 480 ||
    b.readUInt16LE(6) !== 720 ||
    crc32(b.subarray(12)) !== b.readUInt32LE(8)
  )
    return false;
  const magic = b.toString('ascii', 0, 4);
  if (magic === 'NMR1') {
    if (b.length > MAX_RLE_BYTES || (b.length - 12) % 3) return false;
    let pixels = 0;
    for (let at = 12; at < b.length; at += 3) {
      const n = b.readUInt16LE(at);
      if (!n || !palette.includes(b[at + 2]!)) return false;
      pixels += n;
      if (pixels > 345600) return false;
    }
    return pixels === 345600;
  }
  if (magic !== 'NMP1' || b.length < 18) return false;
  const bits = b[12]!,
    count = b[13]!;
  if (
    ![1, 2, 4].includes(bits) ||
    count < 1 ||
    count > 6 ||
    count > 1 << bits ||
    14 + count > b.length
  )
    return false;
  const colors = [...b.subarray(14, 14 + count)];
  if (new Set(colors).size !== count || colors.some((c) => !palette.includes(c))) return false;
  let at = 14 + count;
  for (let band = 0; band < 30; band++) {
    if (at + 2 > b.length) return false;
    const size = b.readUInt16LE(at);
    at += 2;
    if (
      !size ||
      at + size > b.length ||
      !lz4Valid(b.subarray(at, at + size), (16 * 720 * bits) / 8, bits, count)
    )
      return false;
    at += size;
  }
  return at === b.length;
}
export const Raster = z
  .string()
  .max(10668)
  .refine(validRaster, 'invalid or oversized native raster');

export const StreamRaster = z
  .string()
  .max(240000)
  .refine(
    (value) => validRaster(value, MAX_STREAM_RASTER_BYTES),
    'invalid or oversized streaming raster',
  );
