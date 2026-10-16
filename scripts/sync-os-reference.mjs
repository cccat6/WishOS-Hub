import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2] ?? '..'),
  ref = process.argv[3];
if (!ref?.match(/^[a-f0-9]{40}$/)) throw Error('Pass an explicit immutable OS commit');
const git = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
  ? '/Library/Developer/CommandLineTools/usr/bin/git'
  : 'git';
const read = (...args) =>
  execFileSync(git, ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const commit = read('rev-parse', ref + '^{commit}').trim();
if (commit !== ref) throw Error('Commit mismatch');
const names = [
  'resource-model',
  'runtime-apps',
  'callbacks',
  'applications',
  'dynamic-ui',
  'display-interface',
  'managed-services',
  'audio',
  'interactions',
  'connectivity',
  'wireless-config',
  'nfs-service',
  'driver-guide',
  'packages',
];
const sources = [
  ...names.map((id) => ({
    id,
    path: `skills/agentic-notes-hardware/references/${id}.md`,
    file: id + '.md',
    mimeType: 'text/markdown',
  })),
  {
    id: 'system-runtime',
    path: 'docs/agent-os-runtime.md',
    file: 'system-runtime.md',
    mimeType: 'text/markdown',
  },
  {
    id: 'hardware-packages',
    path: 'hardware/agent-os/README.md',
    file: 'hardware-packages.md',
    mimeType: 'text/markdown',
  },
  {
    id: 'package-contract',
    path: 'docs/package-contract.md',
    file: 'package-contract.md',
    mimeType: 'text/markdown',
  },
  {
    id: 'input-library',
    path: 'firmware/WishOS/lib/input.lua',
    file: 'input.lua',
    mimeType: 'text/x-lua',
  },
  { id: 'ai-library', path: 'firmware/WishOS/lib/ai.lua', file: 'ai.lua', mimeType: 'text/x-lua' },
];
await mkdir('vendor/os-reference', { recursive: true });
const records = [];
for (const { id, path, file, mimeType } of sources) {
  const text = read('show', `${commit}:${path}`),
    sha256 = createHash('sha256').update(text).digest('hex');
  await writeFile(`vendor/os-reference/${file}`, text);
  records.push({ id, path, file, mimeType, sha256 });
}
await writeFile(
  'vendor/os-reference/snapshot.json',
  JSON.stringify(
    {
      format: 'wishos-source-snapshot/1',
      repository: 'https://github.com/cccat6/WishOS',
      commit,
      files: records,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ commit, files: records.length, working_tree_used: false }));
