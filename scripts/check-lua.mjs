#!/usr/bin/env node
import { nodeLuaCompiler } from '../dist/node-lua-compiler.js';
if (process.argv.includes('--help')) {
  console.log(
    'stdin JSON: {files:[{path,source}]} or {source,name?}; stdout JSON wishos-lua-check/1. Compile only, never execute.',
  );
  process.exit(0);
}
try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw Error('compiler_input_limit');
    chunks.push(chunk);
  }
  const input = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
    ),
    files = input.files ?? [{ path: input.name ?? 'application.lua', source: input.source }];
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.some((f) => !f || typeof f.path !== 'string' || typeof f.source !== 'string')
  )
    throw Error('compiler_input');
  const compiler = await nodeLuaCompiler(),
    results = files.map((f) => ({ path: f.path, ...compiler.check(f.source, f.path) }));
  console.log(
    JSON.stringify({
      format: 'wishos-lua-check/1',
      ok: results.every((r) => r.ok),
      parser: {
        version: '5.4.8',
        implementation: 'stock-lua-c-wasm',
        ...compiler.profile,
        source_sha256: '4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae',
      },
      files: results,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      format: 'wishos-lua-check/1',
      ok: false,
      error: error instanceof Error ? error.message : 'compiler_input',
    }),
  );
  process.exitCode = 2;
}
