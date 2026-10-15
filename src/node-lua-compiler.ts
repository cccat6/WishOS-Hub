import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compilerFromModule, type LuaCompilerFactory } from './lua-compiler.js';
let compiled: Promise<WebAssembly.Module> | undefined;
export const nodeLuaCompiler: LuaCompilerFactory = async () => {
  compiled ??= (async () => {
    const bytes = await readFile(new URL('../vendor/lua-parser/parser.wasm', import.meta.url));
    if (
      createHash('sha256').update(bytes).digest('hex') !==
      '4ef17b40be73c13897ec698ca15fca9656d1aa1042d877ba855054eb9b0d05dc'
    )
      throw Error('lua_compiler_integrity');
    return new WebAssembly.Module(bytes);
  })();
  return compilerFromModule(await compiled);
};
