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
await mkdir('vendor/os-reference', { recursive: true });
const records = [];
for (const id of names) {
  const path = `skills/agentic-notes-hardware/references/${id}.md`,
    text = read('show', `${commit}:${path}`),
    sha256 = createHash('sha256').update(text).digest('hex');
  await writeFile(`vendor/os-reference/${id}.md`, text);
  records.push({ id, path, sha256 });
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
