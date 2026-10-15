export type LuaSyntaxResult = { ok: boolean; version: '5.4.8'; error?: string; line?: number };
export interface LuaCompiler {
  profile: { native_call_depth_limit: number };
  check(source: string, name: string): LuaSyntaxResult;
}
export type LuaCompilerFactory = () => Promise<LuaCompiler>;
type Exports = {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
  __wasm_call_ctors: () => void;
  malloc: (n: number) => number;
  free: (p: number) => void;
  wishos_lua_check: (p: number, size: number, name: number, limit: number) => number;
  wishos_lua_error: () => number;
  wishos_lua_version: () => number;
  wishos_lua_depth_limit: () => number;
  emscripten_stack_get_current: () => number;
  _emscripten_stack_restore: (p: number) => void;
  setThrew: (a: number, b: number) => void;
};
/** Actual stock Lua 5.4.8 parser. Only luaL_loadbufferx(...,"t") is reachable
 * through the adapter; the compiled chunk is discarded without execution. */
export function compilerFromModule(
  module: WebAssembly.Module,
  compilerMemoryBytes = 8 * 1024 * 1024,
): LuaCompiler {
  let e: Exports;
  const env = {
    invoke_vii: (index: number, a: number, b: number) => {
      const stack = e.emscripten_stack_get_current();
      try {
        (e.__indirect_function_table.get(index) as (a: number, b: number) => void)(a, b);
      } catch (error) {
        e._emscripten_stack_restore(stack);
        if (typeof error !== 'number') throw error;
        e.setThrew(1, 0);
      }
    },
    _emscripten_throw_longjmp: () => {
      throw Infinity;
    },
    _abort_js: () => {
      throw Error('lua_compiler_abort');
    },
    _emscripten_memcpy_js: (to: number, from: number, n: number) => {
      new Uint8Array(e.memory.buffer).copyWithin(to, from, from + n);
      return to;
    },
    emscripten_date_now: () => Date.now(),
    emscripten_resize_heap: (bytes: number) => {
      if (bytes > 64 * 1024 * 1024) return 0;
      try {
        e.memory.grow(Math.ceil((bytes - e.memory.buffer.byteLength) / 65536));
        return 1;
      } catch {
        return 0;
      }
    },
    fd_write: () => 8,
    fd_close: () => 8,
    fd_seek: () => 8,
  };
  e = new WebAssembly.Instance(module, { env, wasi_snapshot_preview1: env })
    .exports as unknown as Exports;
  e.__wasm_call_ctors();
  if (e.wishos_lua_version() !== 50408) throw Error('lua_compiler_version');
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  const copy = (text: string) => {
    const bytes = encoder.encode(text),
      p = e.malloc(bytes.length + 1);
    if (!p) throw Error('lua_compiler_memory');
    const memory = new Uint8Array(e.memory.buffer);
    memory.set(bytes, p);
    memory[p + bytes.length] = 0;
    return { p, n: bytes.length };
  };
  return {
    profile: { native_call_depth_limit: e.wishos_lua_depth_limit() },
    check(source, name) {
      if (source.includes('\0') || name.includes('\0'))
        return { ok: false, version: '5.4.8', error: 'Lua source and paths must be NUL-free text' };
      const src = copy(source),
        file = copy('@' + name);
      try {
        const status = e.wishos_lua_check(src.p, src.n, file.p, compilerMemoryBytes);
        if (!status) return { ok: true, version: '5.4.8' };
        const p = e.wishos_lua_error(),
          memory = new Uint8Array(e.memory.buffer);
        let end = p;
        while (end < memory.length && memory[end]) end++;
        const error = decoder.decode(memory.subarray(p, end)),
          line = Number(error.match(/:(\d+):/)?.[1]);
        return { ok: false, version: '5.4.8', error, ...(line ? { line } : {}) };
      } finally {
        e.free(src.p);
        e.free(file.p);
      }
    },
  };
}
