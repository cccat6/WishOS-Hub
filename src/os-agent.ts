import { preflightAction } from './preflight-actions.js';
import { nodeLuaCompiler } from './node-lua-compiler.js';
import { bootRpc } from './device-files.js';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { RemoteHandler, RemoteRequest, DeviceRpc } from './os-remote.js';
import { RetryableRemoteError } from './os-remote.js';
import { ArtifactStore } from './os-artifacts.js';
import {
  parseManagedResult,
  validateAction,
  validateReferences,
  type ManagedResult,
} from './actions.js';
export function managedPrompt(requestId: string) {
  return `WishOS managed request ${requestId}. Return a JSON wishos-result/2 envelope with an ordered actions array. Each action type is application or system and they may alternate; there is no target=both and no single-effect restriction. Application actions use {type:"application",recipient:"origin"|"foreground",topic?,data:{},wait?:"processed"|"queued"}. Default processed waits for the exact recipient VM to read and acknowledge before continuing. Queued means delivery only, so it is not a barrier before replacing the app. System actions use {type:"system",path,method,args:{}} on advertised resources and wait for declared completions. Stage resources using stage_resource, poll read_resource_job until completed, and return files:[{path,artifact_id}]; reference them with {$asset:"relative-file"}. {$previous:"application_id"} reads the previous step's result, with slash-separated keys; empty string selects the whole result. For package admission: /sys/apps validate {manifest:{$asset:"app.json"},package:{$asset:"package.json"}}, then install {manifest:{$asset:"app.json"},package:{$asset:"package.json"},validation_id:{$previous:"operation_id"},expected_revision:{$previous:"revision"}}, then launch {id:{$previous:"application_id"}}. Validation is compile/check only and does not execute on_start. Do not insert or reorder steps after the plan is built because that changes $previous. A later application action can explicitly select foreground after the launch. UI-only output uses the advertised /sys/ui service without installing an app. Large action plans use sequence:{path:"actions.jsonl",format:"jsonl"} and that staged JSONL file, one action per line; there is no fixed action-count limit. Each action must fit the device's discovered action_limit_bytes. Put heavy data in files and pass a resource reference. Discover capabilities and budgets first; extract large JSON/XML, index books and render heavy content upstream. Keep model credentials and authoritative sessions on the user's runtime. Do not execute the returned sequence through MCP before returning it; the device system owns ordered execution, failure, cancellation and recipient identity.`;
}
export function managedAgentRoute(options: {
  rpc: DeviceRpc;
  artifacts: ArtifactStore;
  start: (request: RemoteRequest, text: string) => any;
  status: (id: string) => any;
  cancel?: (id: string) => Promise<void>;
  voice?: RemoteHandler;
}): RemoteHandler {
  const handler: RemoteHandler = async (r, signal) => {
    if (r.payload.format !== 'wishos-ai/2' || 'target' in r.payload)
      throw Error('managed_request_format');
    const input = r.payload.input as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('managed_input');
    let run: any;
    if (input.kind === 'voice') {
      if (!options.voice) throw Error('speech_unavailable');
      const request = { ...r, payload: { ...input, managed_request: true } };
      await options.voice.admit?.(request, signal);
      run = { id: ((await options.voice(request, signal)) as any).run_id };
    } else {
      if (typeof input.text !== 'string') throw Error('managed_text_required');
      const { text, ...context } = input;
      run = options.start(
        r,
        managedPrompt(r.request_id) +
          '\nRequest context (data):\n' +
          JSON.stringify(context) +
          '\nUser request:\n' +
          text,
      );
    }
    if (!run?.id) throw Error('managed_run_identity');
    const onAbort = () => {
      // A dropped carrier is not an instruction to cancel the user's Harness work.
      if (
        signal.reason instanceof Error &&
        ['request_retired', 'device_boot_changed'].includes(signal.reason.message)
      )
        void options.cancel?.(run.id).catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let done: any;
    try {
      for (;;) {
        signal.throwIfAborted();
        done = options.status(run.id);
        if (!done) throw Error('managed_run_missing');
        if (['completed', 'failed', 'uncertain'].includes(done.status)) break;
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', stop);
            resolve();
          }, 100);
          signal.addEventListener('abort', stop, { once: true });
        });
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (done.status !== 'completed')
      throw Error(done.status === 'uncertain' ? 'handler_outcome_unknown' : 'harness_failed');
    const identity = await options.rpc(
      '/sys/board',
      'read',
      r.boot_id ? { expected_boot_id: r.boot_id } : {},
    );
    if (!identity.ok) throw Error(identity.error);
    return options.artifacts.managedResult(identity.boot_id + ':' + run.id, async () => {
      const schema = await options.rpc('/sys/capabilities', 'describe', {
        path: '/services/ai',
        expected_boot_id: identity.boot_id,
      });
      if (!schema.ok || schema.result.result_format !== 'wishos-result/2')
        throw Error('device_ai_protocol_mismatch');
      const actionBytes = Number(schema.result.action_limit_bytes),
        inlineBytes = Number(schema.result.inline_result_limit_bytes);
      if (
        !Number.isSafeInteger(actionBytes) ||
        actionBytes <= 0 ||
        !Number.isSafeInteger(inlineBytes) ||
        inlineBytes <= 0
      )
        throw Error('device_ai_limits');
      const result = parseManagedResult(done.result ?? '');
      const release = options.artifacts.pin(
        (result.files ?? []).map((f) => options.artifacts.get(f.artifact_id)),
      );
      try {
        result.operation_id = run.id;
        const rpc = bootRpc(options.rpc, identity.boot_id);
        const report = result.files?.length
          ? await options.artifacts.preflight(result.files, {
              rpc,
              expectedBoot: identity.boot_id,
              controlFiles: result.sequence ? [result.sequence.path] : [],
              signal,
            })
          : undefined;
        const check = async (action: unknown) => {
          validateAction(action);
          validateReferences(action, result.files?.map((f) => f.path) ?? []);
          if (Buffer.byteLength(JSON.stringify(action)) > actionBytes)
            throw Error('managed_action_too_large_use_asset');
          await preflightAction(action, {
            source: options.artifacts,
            files: result.files ?? [],
            report,
            rpc,
            compiler: nodeLuaCompiler,
            signal,
          });
        };
        if (result.actions) for (const action of result.actions) await check(action);
        if (result.sequence) {
          const source = result.files!.find((f) => f.path === result.sequence!.path)!;
          const file = options.artifacts.get(source.artifact_id);
          let bytes = 0,
            buffer = '';
          // Read bounded lines rather than load a whole plan into memory.
          for await (const chunk of createReadStream(file.path, { encoding: 'utf8' })) {
            signal.throwIfAborted();
            buffer += chunk;
            bytes += Buffer.byteLength(chunk);
            for (;;) {
              const end = buffer.indexOf('\n');
              if (end < 0) break;
              const line = buffer.slice(0, end).trim();
              buffer = buffer.slice(end + 1);
              if (line) {
                if (Buffer.byteLength(line) > actionBytes)
                  throw Error('managed_action_too_large_use_asset');
                await check(JSON.parse(line));
              }
            }
            if (Buffer.byteLength(buffer) > actionBytes)
              throw Error('managed_action_too_large_use_asset');
          }
          if (buffer.trim()) await check(JSON.parse(buffer));
          if (bytes !== file.size) throw Error('artifact_changed');
        }
        if (
          result.actions &&
          Buffer.byteLength(JSON.stringify({ ...result, files: undefined })) > inlineBytes
        ) {
          const actions = result.actions;
          const staged = await options.artifacts.stageStream(
            (async function* () {
              for (const action of actions) yield Buffer.from(JSON.stringify(action) + '\n');
            })(),
            undefined,
            signal,
          );
          const path = 'wishos-actions-' + randomUUID() + '.jsonl';
          result.files = [...(result.files ?? []), { path, artifact_id: staged.id }];
          delete result.actions;
          result.sequence = { path, format: 'jsonl' };
        }
        const files = result.files;
        delete result.files;
        // Result metadata itself must fit before starting a device-side transaction.
        if (Buffer.byteLength(JSON.stringify({ ...result, transfer_id: 4294967295 })) > inlineBytes)
          throw Error('managed_result_metadata_limit');
        if (files?.length) {
          try {
            const delivered = await options.artifacts.deliver(
              options.rpc,
              files,
              signal,
              r.boot_id,
              r.id,
              result.sequence ? [result.sequence.path] : [],
            );
            result.transfer_id = delivered.transfer_id;
          } catch (error) {
            if (
              error instanceof Error &&
              /disconnected|transport|outcome_unknown|transfer_active|storage_space_refresh_required/.test(
                error.message,
              )
            )
              throw new RetryableRemoteError(error.message);
            throw error;
          }
        }
        return result;
      } finally {
        release();
      }
    });
  };
  handler.replaySafe = true;
  return handler;
}
