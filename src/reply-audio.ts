import { randomUUID } from 'node:crypto';
import type { ManagedResult, ApplicationAction } from './actions.js';
import { TtsService, ReplyPreference } from './tts.js';
import type { ArtifactStore } from './os-artifacts.js';
import type { DeviceRpc } from './os-remote.js';
import { readMounts } from './device-storage.js';
export function replyAudioError(result: ManagedResult, code: string) {
  const messages = (result.actions ?? []).filter(message);
  for (const a of messages) delete a.data.audio;
  if (messages[0]) messages[0].data.audio_error = { code };
}
export type AudioDelivery = { provider: string; lifetime: 'request' };
const message = (a: any): a is ApplicationAction =>
  a.type === 'application' &&
  (a.topic === undefined || a.topic === 'message') &&
  typeof a.data?.text === 'string';
/** Optional presentation enrichment. Does not change actions or synthesize a model reply. */
export async function prepareReplyAudio(
  result: ManagedResult,
  input: Record<string, unknown>,
  tts: TtsService,
  rpc: DeviceRpc,
  store: ArtifactStore,
  signal: AbortSignal,
  limits = { actionBytes: 2048, inlineBytes: 1536 },
): Promise<{ delivery?: AudioDelivery; release: () => void }> {
  const pref = ReplyPreference.parse(input.reply ?? {});
  const release: (() => void)[] = [];
  if (pref.mode !== 'speech') return { release() {} };
  const messages = result.actions?.filter(message) ?? [];
  if (!messages.length) return { release() {} };
  const error = (code: string) => {
    if (messages[0]) messages[0].data.audio_error = { code };
  };
  if (result.sequence || result.files?.length || result.actions?.some((a) => !message(a))) {
    error('tts_mixed_resource_delivery_unsupported');
    return { release() {} };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > limits.inlineBytes - 160) {
    error('tts_control_envelope_limit');
    return { release() {} };
  }
  if (!tts.describe().available) {
    error('tts_unavailable');
    return { release() {} };
  }
  try {
    const speaker = await rpc('/sys/capabilities', 'describe', { path: '/dev/speaker' });
    if (
      !speaker.ok ||
      !String(speaker.result.encodings ?? '')
        .split(',')
        .includes('ima-adpcm-block') ||
      !speaker.result.sample_rates_hz?.includes(16000)
    )
      throw Error('tts_speaker_format_unavailable');
    const transfer = await rpc('/sys/capabilities', 'describe', { path: '/sys/transfers' });
    if (
      !transfer.ok ||
      transfer.result.begin_options?.provider?.selection !== 'declared_policy_target' ||
      !transfer.result.begin_options?.lifetime?.choices?.includes('request')
    )
      throw Error('tts_ephemeral_delivery_unavailable');
    const state = await rpc('/sys/transfers', 'read', {});
    if (!state.ok) throw Error('tts_storage_unavailable');
    const volumes = await readMounts(rpc, signal);
    const selected = state.result.policy?.targets?.find((t: any) =>
      volumes.some(
        (v) =>
          v.id === t.provider &&
          v.available &&
          v.persistent === false &&
          v.medium !== 'internal_flash',
      ),
    );
    if (!selected) throw Error('tts_RAM_target_unavailable');
    const volume = volumes.find((v) => v.id === selected.provider)!;
    const capacity = BigInt(volume.quota_bytes ?? volume.volume_capacity_bytes ?? '0'),
      free = BigInt(volume.quota_free_bytes ?? volume.free_bytes ?? '0'),
      quota = BigInt(selected.quota_bytes),
      used = capacity - free;
    if (!free || used > quota) throw Error('tts_RAM_capacity');
    const files: NonNullable<ManagedResult['files']> = [];
    let total = 0,
      textBytes = 0;
    for (const a of messages) {
      signal.throwIfAborted();
      textBytes += Buffer.byteLength(a.data.text as string);
      if (textBytes > tts.config.maxTextBytes) throw Error('tts_text_limit');
      const audio = await tts.synthesize(a.data.text as string, pref.voice, signal);
      total += audio.bytes.length;
      if (BigInt(total) > free || BigInt(total) > quota - used) throw Error('tts_RAM_capacity');
      const artifact = await store.stageStream(
        (async function* () {
          yield audio.bytes;
        })(),
        audio.bytes.length,
        signal,
      );
      release.push(store.pin([artifact]));
      const path = 'reply-' + randomUUID() + '.adpcm';
      files.push({ path, artifact_id: artifact.id, kind: 'asset' });
      a.data.audio = {
        format: 'wishos-audio/1',
        encoding: 'ima-adpcm-block',
        sample_rate_hz: audio.sample_rate_hz,
        channels: 1,
        packet_bytes: audio.packet_bytes,
        file: { $asset: path },
        bytes: String(audio.bytes.length),
        samples: String(audio.samples),
      };
      if (Buffer.byteLength(JSON.stringify(a)) > limits.actionBytes)
        throw Error('tts_control_envelope_limit');
    }
    result.files = files;
    return {
      delivery: { provider: selected.provider, lifetime: 'request' },
      release() {
        for (const f of release) f();
      },
    };
  } catch (e) {
    for (const a of messages) delete a.data.audio;
    for (const f of release) f();
    if (signal.aborted) throw e;
    const code =
      e instanceof Error && /^tts_[A-Za-z0-9_]+$/.test(e.message) ? e.message : 'tts_failed';
    error(code);
    return { release() {} };
  }
}
