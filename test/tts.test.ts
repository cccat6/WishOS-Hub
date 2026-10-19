import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TtsConfig, TtsService, ttsPcm } from '../src/tts.js';
import { encodeVoicePacket, decodeVoicePacket } from '../src/voice-codec.js';
import { pcmWav } from '../src/voice.js';
import { prepareReplyAudio } from '../src/reply-audio.js';
import { ArtifactStore } from '../src/os-artifacts.js';
import { setupScript, setupPage } from '../src/connect/setup-page.js';
function pcm(count = 1000) {
  const b = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) b.writeInt16LE(Math.round(7000 * Math.sin(i * 0.1)), i * 2);
  return b;
}
test('TTS output uses independently decoded blocks including a short final block', () => {
  const input = pcm(),
    state = { predictor: 0, index: 0 };
  const a = encodeVoicePacket(input.subarray(0, 1280), 0, state),
    b = encodeVoicePacket(input.subarray(1280), 1, state);
  assert.equal(a.length, 331);
  assert.equal(b.length, 191);
  const x = decodeVoicePacket(b);
  assert.equal(x.length, 720);
  const all = Buffer.concat([decodeVoicePacket(a), x]);
  assert.equal(all.length, input.length);
  let err = 0;
  for (let i = 0; i < input.length; i += 2) err += (input.readInt16LE(i) - all.readInt16LE(i)) ** 2;
  assert(Math.sqrt(err / (input.length / 2)) < 700);
  assert.throws(() => ttsPcm(Buffer.from('bad')), /tts_wav_format/);
});
test('online TTS uses configured WAV endpoint/voice and bounded output, keeps errors free of response bodies', async () => {
  let body: any, headers: any;
  const service = new TtsService(
    {
      source: 'openai-compatible',
      online: { url: 'https://example.test/speech', model: 'chosen', voice: 'v' },
    },
    'PRIVATE_KEY',
    async (_url, opts) => {
      body = JSON.parse(String(opts?.body));
      headers = opts?.headers;
      return new Response(pcmWav(pcm(), 16000));
    },
  );
  const r = await service.synthesize('你好', undefined, new AbortController().signal);
  assert.equal(body.model, 'chosen');
  assert.equal(body.response_format, 'wav');
  assert.equal(headers.Authorization, 'Bearer PRIVATE_KEY');
  assert.equal(r.samples, 1000);
  await assert.rejects(
    () =>
      new TtsService(
        {
          source: 'openai-compatible',
          online: { url: 'https://example.test', model: 'm', voice: 'v' },
        },
        '',
        async () => new Response('PRIVATE_BODY', { status: 403 }),
      ).synthesize('text', undefined, new AbortController().signal),
    (e) => String(e).includes('tts_HTTP_403') && !String(e).includes('PRIVATE_BODY'),
  );
  await assert.rejects(
    () =>
      new TtsService(
        {
          source: 'openai-compatible',
          maxAudioBytes: 1024,
          online: { url: 'https://example.test', model: 'm', voice: 'v' },
        },
        '',
        async () => new Response(Buffer.alloc(2048)),
      ).synthesize('x', undefined, new AbortController().signal),
    /tts_audio_limit/,
  );
  assert.equal(TtsConfig.parse({}).source, 'disabled');
  assert.throws(() => TtsConfig.parse({ source: 'openai-compatible' }));
  new Function(setupScript);
  assert(setupPage.includes('ttsSource'));
});
test('speech enrichment chooses only admitted volatile target, keeps text, and never sends a device write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wishos-tts-test-')),
    db = new DatabaseSync(':memory:');
  const store = new ArtifactStore(db, dir, 10000);
  let calls: any[] = [];
  const rpc = async (path: string, method: string, args: any) => {
    calls.push({ path, method, args });
    return {
      boot_id: 'b',
      ok: true,
      result:
        path === '/sys/capabilities'
          ? args.path === '/dev/speaker'
            ? { encodings: 'ima-adpcm-block', sample_rates_hz: [16000] }
            : {
                begin_options: {
                  provider: { selection: 'declared_policy_target' },
                  lifetime: { choices: ['retained', 'request'] },
                },
              }
          : method === 'mounts'
            ? {
                providers: [
                  {
                    id: 'ram',
                    available: true,
                    persistent: false,
                    medium: 'ram',
                    quota_bytes: '99999',
                    quota_free_bytes: '99999',
                  },
                ],
              }
            : {
                policy: {
                  targets: [
                    { provider: 'flash', quota_bytes: '99999' },
                    { provider: 'ram', quota_bytes: '99999' },
                  ],
                },
              },
    };
  };
  const tts = new TtsService(
    {
      source: 'openai-compatible',
      online: { url: 'https://example.test', model: 'm', voice: 'v' },
    },
    '',
    async () => new Response(pcmWav(pcm(), 16000)),
  );
  try {
    const result: any = {
      format: 'wishos-result/2',
      actions: [{ type: 'application', data: { text: '你好' } }],
    };
    const out = await prepareReplyAudio(
      result,
      { reply: { mode: 'speech' } },
      tts,
      rpc,
      store,
      new AbortController().signal,
    );
    assert.equal(out.delivery?.provider, 'ram');
    assert.equal(out.delivery?.lifetime, 'request');
    assert.equal(result.actions[0].data.text, '你好');
    assert.equal(result.actions[0].data.audio.packet_bytes, 331);
    assert(result.actions[0].data.audio.file.$asset);
    assert(calls.every((c) => ['describe', 'read', 'mounts'].includes(c.method)));
    out.release();
    const mixed: any = {
      format: 'wishos-result/2',
      actions: [
        { type: 'application', data: { text: '保留' } },
        { type: 'system', path: '/sys/apps', method: 'launch', args: { id: 'app' } },
      ],
    };
    calls = [];
    await prepareReplyAudio(
      mixed,
      { reply: { mode: 'speech' } },
      tts,
      rpc,
      store,
      new AbortController().signal,
    );
    assert.equal(mixed.actions[0].data.audio_error.code, 'tts_mixed_resource_delivery_unsupported');
    assert.equal(mixed.actions.length, 2);
    assert.equal(calls.length, 0);
    const unavailable: any = {
      format: 'wishos-result/2',
      actions: [{ type: 'application', data: { text: '保留' } }],
    };
    await prepareReplyAudio(
      unavailable,
      { reply: { mode: 'speech' } },
      new TtsService(),
      rpc,
      store,
      new AbortController().signal,
    );
    assert.equal(unavailable.actions[0].data.audio_error.code, 'tts_unavailable');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('per-transfer RAM choice is policy-bound, identity-bound and does not change default bundle routing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wishos-tts-transfer-')),
    db = new DatabaseSync(':memory:'),
    store = new ArtifactStore(db, dir, 10000);
  const a = await store.stage({ text: 'audio fixture' });
  const begins: any[] = [];
  let quota = false,
    allowed = true;
  const rpc = async (path: string, method: string, args: any) => {
    if (path === '/sys/capabilities')
      return {
        ok: true,
        boot_id: 'b',
        result: {
          begin_options: {
            provider: { selection: 'declared_policy_target' },
            lifetime: { choices: ['retained', 'request'] },
          },
        },
      };
    if (method === 'mounts')
      return {
        ok: true,
        boot_id: 'b',
        result: {
          providers: [
            { id: 'flash', available: true },
            { id: 'ram', available: true },
          ],
        },
      };
    if (method === 'read')
      return {
        ok: true,
        boot_id: 'b',
        result: {
          policy: {
            targets: [
              { provider: 'flash', quota_bytes: '10000' },
              ...(allowed ? [{ provider: 'ram', quota_bytes: '10000', explicit_only: true }] : []),
            ],
          },
        },
      };
    if (method === 'begin') {
      begins.push(args);
      if (quota) return { ok: false, boot_id: 'b', error: 'storage_quota_exceeded', result: {} };
      return {
        ok: true,
        boot_id: 'b',
        result: { id: 1, root: '/storage/ram/transient/b-1', chunk_bytes: 1024 },
      };
    }
    return {
      ok: true,
      boot_id: 'b',
      result: method === 'commit' ? { root: '/storage/ram/transient/b-1' } : {},
    };
  };
  try {
    const files = [{ path: 'reply.adpcm', artifact_id: a.id }],
      signal = new AbortController().signal;
    await store.deliver(rpc, files, signal, 'b', 7, undefined, {
      provider: 'ram',
      lifetime: 'request',
    });
    assert.equal(begins[0].provider, 'ram');
    assert.equal(begins[0].lifetime, 'request');
    assert.equal(begins[0].remote_request_id, 7);
    await store.deliver(rpc, files, signal, 'b', 7);
    assert(!('provider' in begins[1]));
    assert.notEqual(begins[0].request_id, begins[1].request_id);
    allowed = false;
    await assert.rejects(
      () =>
        store.deliver(rpc, files, signal, 'b', 7, undefined, {
          provider: 'ram',
          lifetime: 'request',
        }),
      /transfer_target_not_allowed/,
    );
    assert.equal(begins.length, 2);
    allowed = true;
    quota = true;
    await assert.rejects(
      () =>
        store.deliver(rpc, files, signal, 'b', 7, undefined, {
          provider: 'ram',
          lifetime: 'request',
        }),
      /storage_quota_exceeded/,
    );
    assert.equal(begins.length, 3);
    assert.equal(begins[2].provider, 'ram');
    await assert.rejects(
      () =>
        store.deliver(rpc, files, signal, 'b', undefined, undefined, {
          provider: 'ram',
          lifetime: 'request',
        }),
      /transfer_request_lifetime_identity/,
    );
    assert.equal(begins.length, 3);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('managed speech uses RAM transfer; quota and uncertain delivery preserve original text without fallback or replay', async () => {
  const { managedAgentRoute } = await import('../src/os-agent.js');
  for (const failure of ['none', 'quota', 'transport']) {
    const dir = await mkdtemp(join(tmpdir(), 'wishos-managed-tts-')),
      db = new DatabaseSync(':memory:'),
      store = new ArtifactStore(db, dir, 10000);
    let begins = 0;
    const written: string[] = [];
    const rpc = async (path: string, method: string, args: any) => {
      if (path === '/sys/capabilities') {
        const cap =
          args.path === '/services/ai'
            ? {
                result_format: 'wishos-result/2',
                action_limit_bytes: 2048,
                inline_result_limit_bytes: 1536,
              }
            : args.path === '/dev/speaker'
              ? { encodings: 'ima-adpcm-block', sample_rates_hz: [16000] }
              : {
                  begin_options: {
                    provider: { selection: 'declared_policy_target' },
                    lifetime: { choices: ['retained', 'request'] },
                  },
                };
        return { ok: true, boot_id: 'b', result: cap };
      }
      if (method === 'mounts')
        return {
          ok: true,
          boot_id: 'b',
          result: {
            providers: [
              {
                id: 'ram',
                available: true,
                persistent: false,
                medium: 'ram',
                quota_bytes: '99999',
                quota_free_bytes: '99999',
              },
            ],
          },
        };
      if (path === '/sys/transfers' && method === 'read')
        return {
          ok: true,
          boot_id: 'b',
          result: {
            policy: { targets: [{ provider: 'ram', quota_bytes: '99999', explicit_only: true }] },
          },
        };
      if (method === 'begin') {
        begins++;
        assert.equal(args.provider, 'ram');
        assert.equal(args.lifetime, 'request');
        assert.equal(args.remote_request_id, 7);
        if (failure === 'quota')
          return { ok: false, boot_id: 'b', error: 'storage_quota_exceeded', result: {} };
        return {
          ok: true,
          boot_id: 'b',
          result: { id: 9, chunk_bytes: 128, root: '/storage/ram/transient/b-9' },
        };
      }
      if (method === 'chunk') {
        written.push(args.hex);
        if (failure === 'transport') throw Error('transport_lost');
      }
      return {
        ok: true,
        boot_id: 'b',
        result: method === 'commit' ? { root: '/storage/ram/transient/b-9' } : {},
      };
    };
    const tts = new TtsService(
      {
        source: 'openai-compatible',
        online: { url: 'https://example.test', model: 'm', voice: 'v' },
      },
      '',
      async () => new Response(pcmWav(pcm(), 16000)),
    );
    const route = managedAgentRoute({
      rpc,
      artifacts: store,
      tts,
      start: () => ({ id: 'own-run' }),
      status: () => ({
        status: 'completed',
        result: JSON.stringify({
          format: 'wishos-result/2',
          actions: [{ type: 'application', data: { text: '必须保留' } }],
        }),
      }),
    });
    try {
      const r: any = await route(
        {
          id: 7,
          request_id: 'speech-own',
          boot_id: 'b',
          route: 'wishos.ai',
          payload: {
            format: 'wishos-ai/2',
            input: { kind: 'text', text: 'hello', reply: { mode: 'speech' } },
          },
        },
        new AbortController().signal,
      );
      assert.equal(r.actions[0].data.text, '必须保留');
      assert.equal(begins, 1);
      if (failure === 'none') {
        assert.equal(r.transfer_id, 9);
        assert(r.actions[0].data.audio.file.$asset);
        assert(written.length > 1);
      } else {
        assert.equal(r.transfer_id, undefined);
        assert.equal(r.actions[0].data.audio, undefined);
        assert.equal(
          r.actions[0].data.audio_error.code,
          failure === 'quota' ? 'tts_delivery_failed' : 'tts_delivery_uncertain',
        );
      }
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('optional audio failure adds one bounded request notice rather than multiplying errors across replies', async () => {
  const { replyAudioError } = await import('../src/reply-audio.js');
  const r: any = {
    format: 'wishos-result/2',
    actions: Array.from({ length: 5 }, (_, i) => ({
      type: 'application',
      data: { text: 'reply' + i, audio: { file: 'owned' } },
    })),
  };
  replyAudioError(r, 'tts_delivery_uncertain');
  assert.equal(r.actions.filter((a: any) => a.data.audio_error).length, 1);
  assert(r.actions.every((a: any) => !a.data.audio));
  assert.deepEqual(
    r.actions.map((a: any) => a.data.text),
    ['reply0', 'reply1', 'reply2', 'reply3', 'reply4'],
  );
});

test('multiple replies skip media on control-envelope pressure while preserving every original text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wishos-tts-envelope-')),
    db = new DatabaseSync(':memory:'),
    store = new ArtifactStore(db, dir, 10000);
  const texts = ['第一条文字，必须完整保留。', '第二条文字，也不能截断。'];
  const result: any = {
    format: 'wishos-result/2',
    actions: texts.map((text) => ({ type: 'application', data: { text } })),
  };
  const rpc = async (path: string, method: string, args: any) => ({
    boot_id: 'b',
    ok: true,
    result:
      path === '/sys/capabilities'
        ? args.path === '/dev/speaker'
          ? { encodings: 'ima-adpcm-block', sample_rates_hz: [16000] }
          : {
              begin_options: {
                provider: { selection: 'declared_policy_target' },
                lifetime: { choices: ['request'] },
              },
            }
        : method === 'mounts'
          ? {
              providers: [
                {
                  id: 'ram',
                  available: true,
                  persistent: false,
                  medium: 'ram',
                  quota_bytes: '99999',
                  quota_free_bytes: '99999',
                },
              ],
            }
          : { policy: { targets: [{ provider: 'ram', quota_bytes: '99999' }] } },
  });
  const tts = new TtsService(
    {
      source: 'openai-compatible',
      online: { url: 'https://example.test', model: 'm', voice: 'v' },
    },
    '',
    async () => new Response(pcmWav(pcm(), 16000)),
  );
  try {
    const r = await prepareReplyAudio(
      result,
      { reply: { mode: 'speech', future_hint: { style: 'short' } } },
      tts,
      rpc,
      store,
      new AbortController().signal,
      { actionBytes: 180, inlineBytes: 1536 },
    );
    assert.equal(r.delivery, undefined);
    assert.equal(result.files, undefined);
    assert.deepEqual(
      result.actions.map((a: any) => a.data.text),
      texts,
    );
    assert(result.actions.every((a: any) => !a.data.audio));
    assert.equal(result.actions[0].data.audio_error.code, 'tts_control_envelope_limit');
    r.release();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
