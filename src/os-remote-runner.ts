import { DatabaseSync } from 'node:sqlite';
import { SqlRemoteJournal } from './os-journal.js';
import { voiceRoute, httpAudioApi } from './os-voice-route.js';
import { deviceRpc, harnessRoute, OsRemoteBridge, type RemoteHandler } from './os-remote.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const device = process.env.NOTES_OS_URL;
if (!device) throw Error('Set NOTES_OS_URL to the device HTTP address');
const rpc = deviceRpc(device);
const handlers: Record<string, RemoteHandler> = {};
if (process.env.NOTES_HUB_URL && process.env.NOTES_DEVICE_ID) {
  handlers.voice = voiceRoute(
    rpc,
    httpAudioApi(
      process.env.NOTES_HUB_URL,
      process.env.NOTES_DEVICE_ID,
      process.env.NOTES_HUB_TOKEN,
    ),
  );
  handlers.agent = harnessRoute(
    process.env.NOTES_HUB_URL,
    process.env.NOTES_DEVICE_ID,
    process.env.NOTES_HUB_TOKEN,
  );
  handlers.agent_status = async (request, signal) => {
    const id = request.payload.run_id;
    if (typeof id !== 'string') throw Error('run_id_required');
    const response = await fetch(
      new URL(`/api/runs/${encodeURIComponent(id)}`, process.env.NOTES_HUB_URL),
      {
        signal,
        headers: process.env.NOTES_HUB_TOKEN
          ? { Authorization: `Bearer ${process.env.NOTES_HUB_TOKEN}` }
          : {},
      },
    );
    if (!response.ok) throw Error(`run_status_failed:${response.status}`);
    const run = await response.json();
    return {
      run_id: id,
      status: run.status,
      result_url: new URL(`/api/runs/${encodeURIComponent(id)}`, process.env.NOTES_HUB_URL).href,
    };
  };
}
if (process.env.NOTES_SERVICE_MODULE) {
  const module = await import(pathToFileURL(resolve(process.env.NOTES_SERVICE_MODULE)).href);
  for (const [key, value] of Object.entries(module.handlers ?? {})) {
    if (typeof value !== 'function') throw Error(`Invalid service handler ${key}`);
    handlers[key] = value as RemoteHandler;
  }
}
if (!Object.keys(handlers).length)
  throw Error('Configure NOTES_HUB_URL/NOTES_DEVICE_ID or NOTES_SERVICE_MODULE');
const control = new AbortController();
process.once('SIGINT', () => control.abort());
process.once('SIGTERM', () => control.abort());
const journalDb = new DatabaseSync(process.env.NOTES_OS_JOURNAL ?? 'wishos-delivery.sqlite');
const bridge = new OsRemoteBridge(rpc, handlers, {
  journal: new SqlRemoteJournal(journalDb, process.env.NOTES_DEVICE_ID ?? device),
});
while (!control.signal.aborted) {
  try {
    await bridge.poll(control.signal);
  } catch (error) {
    if (!control.signal.aborted)
      console.error(error instanceof Error ? error.message : String(error));
  }
  if (!control.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 250));
}

bridge.close();
journalDb.close();
