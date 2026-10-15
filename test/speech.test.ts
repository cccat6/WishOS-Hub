import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SpeechSettings, SpeechUnavailable } from '../src/speech.js';
import { HttpAsr, pcmWav } from '../src/voice.js';
const wav = () => pcmWav(Buffer.alloc(640), 16000);
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
test('native selection, explicit third-party, fallback and in-flight configuration pinning', async () => {
  const f = await fixture();
  let settings = new SpeechSettings();
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
    settings = new SpeechSettings({ source: 'harness', fallbackToThirdParty: true, thirdParty });
    assert.equal(await settings.capture(native, 'selected', signal)!.transcribe(wav()), 'native');
    assert.equal(f.requests.length, 0);
    const unavailable = { name: 'no-native' };
    const captured = settings.capture(unavailable, 'selected', signal)!;
    settings = new SpeechSettings({
      source: 'third-party',
      thirdParty: { ...thirdParty, url: f.url + '/two' },
    });
    assert.equal(await captured.transcribe(wav()), 'recognized');
    assert.equal(await settings.capture(native, 'selected', signal)!.transcribe(wav()), 'second');
    assert.equal(nativeCalls, 1);
    settings = new SpeechSettings({ source: 'harness', fallbackToThirdParty: false, thirdParty });
    assert.equal(settings.capture(unavailable, null, signal), undefined);
    settings = new SpeechSettings({ source: 'harness', fallbackToThirdParty: true, thirdParty });
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
    await f.close();
  }
});
