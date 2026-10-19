# Third-party notices

WishOS Hub source is MIT licensed. Distribution archives also contain dependencies
under their own licenses; retain their LICENSE/NOTICE files when redistributing.

- Node.js: pinned runtime version; its upstream LICENSE is included in runtime/.
- Lua 5.4.8: compile-only parser and WASM build; see vendor/lua-parser/LICENSE and its build provenance.
- WishOS reference documentation: MIT source snapshot under vendor/os-reference; digests identify the included files.
- Sharp, libvips, MCP SDK, WebSocket, Zod and service-discovery dependencies: package-lock.json pins exact versions;
  installed production packages retain their license files and notices.

GitHub source archives do not include your local configuration, provider keys,
recordings or runtime databases. Release packaging uses an explicit product-file
manifest rather than copying development evidence directories.
