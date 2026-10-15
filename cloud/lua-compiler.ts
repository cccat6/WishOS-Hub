import module from '../vendor/lua-parser/parser.wasm';
import { compilerFromModule, type LuaCompilerFactory } from '../src/lua-compiler';
export const cloudLuaCompiler: LuaCompilerFactory = async () => compilerFromModule(module);
