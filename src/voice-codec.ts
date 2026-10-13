const steps = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const indices = [-1, -1, -1, -1, 2, 4, 6, 8];
export function decodeVoicePacket(frame: Buffer) {
  if (frame.length < 12 || frame[0] !== 0x42 || frame[7]! > 88 || frame[8] !== 0)
    throw Error('invalid ADPCM packet');
  const count = frame.readUInt16LE(9);
  if (count < 1 || count > 1280 || frame.length !== 11 + Math.ceil(count / 2))
    throw Error('invalid ADPCM sample count');
  let predictor = frame.readInt16LE(5),
    index = frame[7]!;
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const code = (frame[11 + (i >> 1)]! >> ((i & 1) * 4)) & 15,
      step = steps[index]!;
    const diff = (step * (2 * (code & 7) + 1)) >> 3;
    predictor = Math.max(-32768, Math.min(32767, predictor + (code & 8 ? -diff : diff)));
    index = Math.max(0, Math.min(88, index + indices[code & 7]!));
    pcm.writeInt16LE(predictor, 2 * i);
  }
  return pcm;
}
