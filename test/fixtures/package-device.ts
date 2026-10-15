import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { nodeLuaCompiler } from '../../src/node-lua-compiler.js';
import type { DeviceRpc } from '../../src/os-remote.js';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Protocol fixture with real content hashes and Lua parser, not physical media. */
export class PackageDevice {
  boot = 'package-boot';
  revision = 0;
  validationId = 0;
  active = 'original';
  calls: any[] = [];
  files = new Map<string, Buffer>();
  reads = new Map<string, number>();
  uploaded = 0;
  copied = 0;
  released = 0;
  failValidation = false;
  failActivation = false;
  preparationNeedsIdle = false;
  preparationReady = false;
  failPreparationAfterStop = false;
  activationCompletionError?: string;
  pendingApplication?: string;
  installed?: { manifest: string; package: string; inventory_sha256: string; application: any };
  ticket?: {
    manifest: string;
    package: string;
    revision: number;
    operation_id: number;
    state: string;
    error?: string;
  };
  transfer?: {
    id: number;
    root: string;
    state: string;
    files_complete: number;
    expected: number;
    request_id?: string;
    current?: { path: string; size: number; sha256: string; bytes: Buffer };
    copy?: {
      source: string;
      bytes: Buffer;
      at: number;
      path: string;
      size: number;
      sha256: string;
    };
  };
  descriptions: Record<string, any> = {
    '/sys/runtime': {
      methods: 'read,load,validate,stop',
      read_methods: 'read',
      engine: 'lua-5.4.8',
      memory_budget_semantics: 'elastic_limit_with_checked_actual_growth',
      entry_source_limit_bytes: 65536,
      budgets: { memory_bytes: { minimum: 16384, maximum: 260000 } },
    },
    '/sys/apps': {
      methods: 'read,inspect,validate,validation,release_validation,install,launch',
      read_methods: 'read,inspect,validation',
      manifest_limit_bytes: 4096,
      package_validation: {
        method: 'validate',
        status_method: 'validation',
        release_method: 'release_validation',
        file_kinds: 'lua,json,asset',
        header_limit_bytes: 512,
        inventory_line_limit_bytes: 512,
        json_limit_bytes: 16384,
        lua_source_limit_bytes: 65536,
      },
      package_install: { validation_required: true },
      async: { launch: { success_events: ['launched', 'failed'] } },
    },
    '/sys/transfers': {
      methods: 'read,begin,file,chunk,close_file,copy_file,commit,abort,release',
      read_methods: 'read',
    },
    '/sys/operations': { methods: 'read,request,release', read_methods: 'read' },
    '/fs': { methods: 'read,stat,mounts', read_methods: 'read,stat,mounts' },
    '/sys/board': { methods: 'read', read_methods: 'read' },
    '/dev/media': { methods: 'read,mount', read_methods: 'read' },
  };
  rpc: DeviceRpc = async (path, method, args) => {
    try {
      return { ok: true, boot_id: this.boot, result: await this.call({ path, method, args }) };
    } catch (e) {
      return {
        ok: false,
        boot_id: this.boot,
        error: e instanceof Error ? e.message : 'fixture_failure',
        result: {},
      };
    }
  };
  async call(c: any): Promise<any> {
    this.calls.push(c);
    const { path, method, args: a } = c;
    if (a.expected_boot_id && a.expected_boot_id !== this.boot) throw Error('boot_changed');
    if (path === '/sys/capabilities') {
      if (method === 'describe') {
        if (!this.descriptions[a.path]) throw Error('not_found');
        return this.descriptions[a.path];
      }
      return { devices: Object.keys(this.descriptions).map((path) => ({ path })), more: false };
    }
    if (path === '/sys/board')
      return {
        component_index: { format: 'wishos-components/1', file: '/system/components.json' },
      };
    if (path === '/sys/runtime') {
      if (method === 'read')
        return { source_limit_bytes: 65536, memory_policy_limit_bytes: 260000 };
      if (method === 'stop') {
        this.active = '';
        return { loaded: false };
      }
      if (method === 'load') {
        this.active = 'raw';
        return { loaded: true };
      }
    }
    if (path === '/fs') {
      if (method === 'mounts')
        return {
          providers: this.preparationNeedsIdle
            ? [
                {
                  id: 'card',
                  available: this.preparationReady,
                  prepare: { path: '/dev/media', method: 'mount', args: {} },
                },
              ]
            : [],
        };
      const bytes = this.files.get(a.file);
      if (!bytes) throw Error('file_not_found');
      if (method === 'stat') return { directory: false, size: String(bytes.length) };
      if (method === 'read') {
        const start = Number(a.offset),
          part = bytes.subarray(start, start + a.length);
        this.reads.set(a.file, (this.reads.get(a.file) ?? 0) + part.length);
        return { hex: part.toString('hex'), next_offset: String(start + part.length) };
      }
    }
    if (path === '/dev/media') {
      if (method === 'read') return { link_ready: false };
      if (this.active || this.failPreparationAfterStop)
        throw Error('native_operation_memory_budget');
      this.preparationReady = true;
      return { available: true };
    }
    if (path === '/sys/transfers') {
      if (method === 'begin') {
        if (this.transfer?.state === 'committed') {
          if (a.request_id === this.transfer.request_id)
            return { ...this.transfer, chunk_bytes: 128 };
          throw Error('transfer_active');
        }
        const id = (this.transfer?.id ?? 0) + 1;
        this.transfer = {
          id,
          root: '/card/revisions/' + id,
          state: 'receiving',
          files_complete: 0,
          expected: a.files,
          request_id: a.request_id,
        };
        return { ...this.transfer, chunk_bytes: 128 };
      }
      const t = this.transfer;
      if (method === 'read') {
        if (t?.copy) {
          const cp = t.copy,
            n = Math.min(128, cp.bytes.length - cp.at);
          cp.at += n;
          this.copied += n;
          if (cp.at === cp.bytes.length) {
            if (cp.size !== cp.bytes.length || digest(cp.bytes) !== cp.sha256) {
              t.state = 'aborted';
              delete t.copy;
              return { ...t, error: 'copy_digest' };
            }
            this.files.set(posix.join(t.root, cp.path), Buffer.from(cp.bytes));
            delete t.copy;
            t.state = 'receiving';
            t.files_complete++;
          }
        }
        return {
          state: t?.state ?? 'idle',
          id: t?.id,
          files_complete: t?.files_complete,
          policy: { targets: this.preparationNeedsIdle ? [{ provider: 'card' }] : [] },
        };
      }
      if (!t || a.id !== t.id) throw Error('transfer_id');
      if (method === 'file') {
        if (t.copy || t.current) throw Error('operation_active');
        t.current = {
          path: a.path,
          size: Number(a.bytes),
          sha256: a.sha256,
          bytes: Buffer.alloc(0),
        };
        return { file_offset: '0' };
      }
      if (method === 'chunk') {
        if (!t.current || t.current.bytes.length !== Number(a.offset)) throw Error('chunk_offset');
        const bytes = Buffer.from(a.hex, 'hex');
        this.uploaded += bytes.length;
        t.current.bytes = Buffer.concat([t.current.bytes, bytes]);
        return {};
      }
      if (method === 'close_file') {
        const f = t.current;
        if (!f || f.bytes.length !== f.size || digest(f.bytes) !== f.sha256)
          throw Error('file_digest');
        this.files.set(posix.join(t.root, f.path), f.bytes);
        delete t.current;
        t.files_complete++;
        return {};
      }
      if (method === 'copy_file') {
        if (t.copy || t.current) throw Error('operation_active');
        const bytes = this.files.get(a.source);
        if (!bytes) throw Error('file_not_found');
        t.copy = {
          source: a.source,
          bytes,
          at: 0,
          path: a.path,
          size: Number(a.bytes),
          sha256: a.sha256,
        };
        t.state = 'copying';
        return { state: 'copying' };
      }
      if (method === 'commit') {
        if (t.copy || t.current || t.files_complete !== t.expected)
          throw Error('transfer_incomplete');
        t.state = 'committed';
        return { root: t.root };
      }
      if (method === 'release') {
        if (t.state !== 'committed') throw Error('transfer_not_committed');
        t.state = 'idle';
        return { state: 'idle' };
      }
      if (method === 'abort') {
        t.state = 'aborted';
        delete t.copy;
        delete t.current;
        return {};
      }
    }
    if (path === '/sys/apps') {
      if (method === 'read') return { revision: this.revision, foreground: this.active };
      if (method === 'inspect') {
        if (!this.installed) throw Error('application_not_installed');
        return this.installed;
      }
      if (method === 'validate') {
        this.ticket = {
          manifest: a.manifest,
          package: a.package,
          revision: this.revision,
          operation_id: ++this.validationId,
          state: 'validating',
        };
        return { operation_id: this.validationId, revision: this.revision };
      }
      if (method === 'validation') {
        if (!this.ticket || a.operation_id !== this.ticket.operation_id)
          throw Error('validation_missing');
        if (this.ticket.state === 'validating') {
          try {
            if (this.failValidation) throw Error('injected_native_rejection');
            const header = JSON.parse(this.files.get(this.ticket.package)!.toString()),
              root = posix.dirname(this.ticket.package),
              inv = this.files.get(posix.join(root, header.inventory))!;
            if (digest(inv) !== header.inventory_sha256) throw Error('inventory_digest');
            for (const line of inv.toString().trim().split('\n')) {
              const row = JSON.parse(line),
                bytes = this.files.get(posix.join(root, row.path));
              if (!bytes || String(bytes.length) !== row.bytes || digest(bytes) !== row.sha256)
                throw Error('payload_digest');
              if (
                row.path.endsWith('.lua') &&
                !(await nodeLuaCompiler()).check(bytes.toString(), row.path).ok
              )
                throw Error('lua_syntax');
            }
            this.ticket.state = 'validated';
          } catch (e) {
            this.ticket.state = 'failed';
            this.ticket.error = (e as Error).message;
          }
        }
        return { ...this.ticket };
      }
      if (method === 'release_validation') {
        if (this.ticket?.operation_id === a.operation_id) {
          this.ticket = undefined;
          this.released++;
        }
        return {};
      }
      if (method === 'install') {
        const t = this.ticket;
        if (
          !t ||
          t.state !== 'validated' ||
          t.operation_id !== a.validation_id ||
          t.manifest !== a.manifest ||
          t.package !== a.package ||
          a.expected_revision !== this.revision
        )
          throw Error('validation_required');
        const application = JSON.parse(this.files.get(a.manifest)!.toString()),
          header = JSON.parse(this.files.get(a.package)!.toString());
        this.installed = {
          manifest: a.manifest,
          package: a.package,
          application,
          inventory_sha256: header.inventory_sha256,
        };
        this.ticket = undefined;
        return { application_id: application.id, revision: ++this.revision };
      }
    }
    if (path === '/sys/operations') {
      if (method === 'request') {
        if (this.failActivation) throw Error('injected_activation_rejection');
        this.pendingApplication = a.args.id;
        return { completion_id: 100 };
      }
      if (method === 'read') {
        if (this.activationCompletionError)
          return { ready: true, event: 'failed', data: { error: this.activationCompletionError } };
        this.active = this.pendingApplication ?? this.active;
        return { ready: true, event: 'launched', data: { application_id: this.active } };
      }
      if (method === 'release') return { released: true };
    }
    throw Error('fixture_resource:' + path + ':' + method);
  }
}
