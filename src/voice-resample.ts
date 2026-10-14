/** Convert an upstream speech adapter's PCM input requirement, not the device's
 * recording format. Work yields regularly so other uploads remain responsive. */
export async function speechWavRate(
  wav: Buffer,
  rate: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.toString('ascii', 36, 40) !== 'data' ||
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(22) !== 1 ||
    wav.readUInt16LE(34) !== 16
  )
    throw Error('speech_wav_format');
  const sourceRate = wav.readUInt32LE(24),
    bytes = wav.readUInt32LE(40);
  if (
    !sourceRate ||
    bytes % 2 ||
    bytes + 44 !== wav.length ||
    !Number.isInteger(rate) ||
    rate < 8000 ||
    rate > 192000
  )
    throw Error('speech_wav_format');
  if (rate === sourceRate) return wav;
  const frames = bytes / 2,
    count = Math.round((frames * rate) / sourceRate),
    out = Buffer.alloc(44 + count * 2);
  wav.copy(out, 0, 0, 44);
  out.writeUInt32LE(36 + count * 2, 4);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt32LE(count * 2, 40);
  const scale = sourceRate / rate,
    cutoff = Math.min(1, 1 / scale) * 0.94,
    radius = Math.ceil(16 * Math.max(1, scale)),
    phases = 64;
  const coefficients = Array.from({ length: phases }, (_, phase) => {
    const weights = new Float64Array(radius * 2 + 1),
      fraction = phase / phases;
    for (let j = -radius; j <= radius; j++) {
      const x = j - fraction,
        t = Math.PI * cutoff * x;
      weights[j + radius] =
        (Math.abs(t) < 1e-12 ? cutoff : (cutoff * Math.sin(t)) / t) *
        (0.5 + 0.5 * Math.cos((Math.PI * x) / (radius + 1)));
    }
    return weights;
  });
  for (let i = 0; i < count; i++) {
    if (i % 4096 === 0) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const position = i * scale,
      center = Math.floor(position),
      phase = Math.min(phases - 1, Math.round((position - center) * phases)),
      weights = coefficients[phase]!;
    let sum = 0,
      total = 0;
    for (let j = -radius; j <= radius; j++) {
      const sample = center + j;
      if (sample < 0 || sample >= frames) continue;
      const weight = weights[j + radius]!;
      sum += wav.readInt16LE(44 + sample * 2) * weight;
      total += weight;
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / total))), 44 + i * 2);
  }
  return out;
}
