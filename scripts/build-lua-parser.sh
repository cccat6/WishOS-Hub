#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
workspace="${RUNNER_TEMP:-$PWD/build}/wishos-lua-parser"
mkdir -p "$workspace" build/lua-parser
curl --fail --location --silent --show-error https://www.lua.org/ftp/lua-5.4.8.tar.gz -o "$workspace/lua.tar.gz"
printf '%s  %s\n' 4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae "$workspace/lua.tar.gz" | sha256sum -c -
tar -xzf "$workspace/lua.tar.gz" -C "$workspace"
lua_source="$workspace/lua-5.4.8/src"
sources=()
for file in "$lua_source"/*.c; do
  case "$(basename "$file")" in lua.c|luac.c) ;; *) sources+=("$file");; esac
done
emcc -O3 -I "$lua_source" vendor/lua-parser/parser.c "${sources[@]}" \
  --no-entry -s WASM=1 -s ENVIRONMENT=web,worker,node -s MODULARIZE=1 \
  -s ALLOW_MEMORY_GROWTH=1 -s ALLOW_TABLE_GROWTH=1 -s MALLOC=emmalloc \
  -s SUPPORT_LONGJMP=emscripten -s ASSERTIONS=1 -s STACK_SIZE=1048576 \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_wishos_lua_check","_wishos_lua_error","_wishos_lua_peak","_wishos_lua_version","_wishos_lua_version_string"]' \
  -s EXPORTED_RUNTIME_METHODS='["stackSave","stackRestore"]' \
  -o build/lua-parser/parser.js
cp "$workspace/lua-5.4.8/doc/readme.html" build/lua-parser/lua-readme.html
sha256sum build/lua-parser/parser.wasm > build/lua-parser/parser.wasm.sha256
