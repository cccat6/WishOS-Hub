export function packBatch(chunks: { sample_start: string; adpcm_b64: string }[]) {
  const header = Buffer.alloc(6);
  header.write('WAB1');
  header.writeUInt16LE(chunks.length, 4);
  return Buffer.concat([
    header,
    ...chunks.flatMap((c) => {
      const packet = Buffer.from(c.adpcm_b64, 'base64'),
        record = Buffer.alloc(10);
      record.writeBigUInt64LE(BigInt(c.sample_start));
      record.writeUInt16LE(packet.length, 8);
      return [record, packet];
    }),
  ]).toString('base64');
}
