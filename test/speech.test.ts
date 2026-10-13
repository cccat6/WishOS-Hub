import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { SpeechSettings, SpeechUnavailable } from '../src/speech.js';
import { HttpAsr, AudioStream } from '../src/voice.js';
import { Store } from '../src/store.js';
import { Hub } from '../src/hub.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { speechPage } from '../src/speech-page.js';
function wav() {
  const stream = new AudioStream('fixture');
  const b = Buffer.alloc(7);
  b[0] = 0x41;
  b.writeInt16LE(100, 5);
  stream.append(b);
  return stream.finish(1, true);
}
async function fixture() {
  const requests: { url: string; headers: any; body: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const p of req) parts.push(p);
    requests.push({ url: req.url!, headers: req.headers, body: Buffer.concat(parts) });
    res.setHeader('Content-Type', 'application/json');
    res.end(
      req.url === '/bad'
        ? '{}'
        : JSON.stringify({ text: req.url === '/two' ? 'second' : 'recognized' }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as any;
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
test('third-party WAV and compatible multipart preserve audio and optional credentials', async () => {
  const f = await fixture();
  try {
    const data = wav();
    assert.equal(await new HttpAsr(f.url + '/one').transcribe(data), 'recognized');
    assert.equal(f.requests[0]!.body.compare(data), 0);
    assert.equal(f.requests[0]!.headers.authorization, undefined);
    await new HttpAsr(f.url + '/two', 'test-credential', {
      protocol: 'openai-compatible',
      model: 'asr-fixture',
      language: 'zh',
    }).transcribe(data);
    const req = f.requests[1]!;
    assert.equal(req.headers.authorization, 'Bearer test-credential');
    const form = await new Request(f.url, {
      method: 'POST',
      headers: { 'Content-Type': req.headers['content-type'] },
      body: req.body,
    }).formData();
    assert.equal(form.get('model'), 'asr-fixture');
    assert.equal(form.get('language'), 'zh');
    assert.equal(Buffer.from(await (form.get('file') as File).arrayBuffer()).compare(data), 0);
    await assert.rejects(new HttpAsr(f.url + '/bad').transcribe(data), /invalid text/);
  } finally {
    await f.close();
  }
});
test('native selection, explicit third-party, fallback, persistence and in-flight configuration pinning', async () => {
  const f = await fixture(),
    store = new Store(':memory:');
  const settings = new SpeechSettings(store);
  const signal = new AbortController().signal;
  let nativeCalls = 0;
  const native = {
    name: 'fixture',
    nativeSpeech: {
      available: true,
      transcribe: async () => {
        nativeCalls++;
        return 'native';
      },
    },
  };
  const thirdParty = { url: f.url + '/one', protocol: 'wav-json', token: '' };
  try {
    settings.update({ source: 'harness', fallbackToThirdParty: true, thirdParty });
    assert.equal(await settings.capture(native, 'selected', signal)!.transcribe(wav()), 'native');
    assert.equal(f.requests.length, 0);
    const unavailable = { name: 'no-native' };
    const captured = settings.capture(unavailable, 'selected', signal)!;
    settings.update({ source: 'third-party', thirdParty: { ...thirdParty, url: f.url + '/two' } });
    assert.equal(await captured.transcribe(wav()), 'recognized');
    assert.equal(await settings.capture(native, 'selected', signal)!.transcribe(wav()), 'second');
    assert.equal(nativeCalls, 1);
    assert.equal(new SpeechSettings(store).get().thirdParty?.url, f.url + '/two');
    settings.update({ source: 'harness', fallbackToThirdParty: false, thirdParty });
    assert.equal(settings.capture(unavailable, null, signal), undefined);
    settings.update({ source: 'harness', fallbackToThirdParty: true, thirdParty });
    const offline = {
      name: 'native-offline',
      nativeSpeech: {
        available: true,
        transcribe: async () => {
          throw new SpeechUnavailable('not available');
        },
      },
    };
    assert.equal(await settings.capture(offline, null, signal)!.transcribe(wav()), 'recognized');
    const failure = {
      name: 'native-error',
      nativeSpeech: {
        available: true,
        transcribe: async () => {
          throw Error('invalid recording');
        },
      },
    };
    const count = f.requests.length;
    await assert.rejects(
      settings.capture(failure, null, signal)!.transcribe(wav()),
      /invalid recording/,
    );
    assert.equal(f.requests.length, count);
  } finally {
    store.close();
    await f.close();
  }
});
test('speech settings HTTP persists blanks, refreshes device voice availability and validates same-origin UI', async () => {
  const store = new Store(':memory:');
  const hub = new Hub({
    store,
    adminToken: '',
    devices: [{ id: 'board', token: '', adapter: new MockAdapter() }],
  });
  const addr = (await hub.listen(0, '127.0.0.1')) as any,
    base = `http://127.0.0.1:${addr.port}`;
  const ws = new WebSocket(base.replace('http', 'ws') + '/device?id=board');
  const messages: any[] = [];
  try {
    ws.on('message', (b) => messages.push(JSON.parse(b.toString())));
    await once(ws, 'open');
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol: 2,
        device_id: 'board',
        boot_id: 'one',
        capabilities: { display: true, audio: true, sleep: false, max_scene_bytes: 8192 },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(messages[0].voice_available, false);
    const url = base + '/api/speech';
    const config = {
      source: 'harness',
      fallbackToThirdParty: true,
      thirdParty: { protocol: 'wav-json', url: 'http://127.0.0.1:9/asr', token: 'old-token' },
    };
    const save = async (value: any, origin = base) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify(value),
      });
    assert.equal((await save(config, 'http://unrelated.example')).status, 403);
    assert.equal((await save(config)).status, 200);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(messages.at(-1).voice_available, true);
    config.thirdParty.token = '';
    const response = await save(config);
    const d = await response.json();
    assert.equal(d.config.thirdParty.token, '');
    assert.equal(d.devices[0].fallback_active, true);
    assert.equal(d.devices[0].harness_available, false);
    assert.equal(
      (
        await save({
          ...config,
          thirdParty: { ...config.thirdParty, protocol: 'openai-compatible', model: '' },
        })
      ).status,
      400,
    );
    assert.equal(
      (await save({ ...config, thirdParty: { ...config.thirdParty, url: 'file:///tmp/audio' } }))
        .status,
      400,
    );
    new vm.Script(speechPage.match(/<script>([\s\S]*)<\/script>/)![1]!);
    assert.equal((await fetch(base + '/speech')).status, 200);
  } finally {
    ws.terminate();
    await hub.close();
    store.close();
  }
});
