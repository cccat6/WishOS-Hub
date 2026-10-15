import { execFileSync } from 'node:child_process';
import { readFile, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const git = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
  ? '/Library/Developer/CommandLineTools/usr/bin/git'
  : 'git';
const commit = execFileSync(git, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit)
  throw Error('Guidance source commit mismatch');
const pkg = JSON.parse(await readFile('package.json', 'utf8')),
  snapshot = JSON.parse(await readFile('vendor/os-reference/snapshot.json', 'utf8'));
const name = `wishos-guidance-${pkg.version}`,
  parent = resolve('build/guidance'),
  root = join(parent, name);
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const names = execFileSync(
  git,
  ['ls-tree', '-r', '--name-only', commit, '--', 'skills', 'vendor/os-reference', 'LICENSE'],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .filter(Boolean)
  .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const hash = (b) => createHash('sha256').update(b).digest('hex'),
  files = [];
for (const path of names) {
  const bytes = await readFile(path),
    pinned = execFileSync(git, ['show', `${commit}:${path}`], { maxBuffer: 4 * 1024 * 1024 });
  if (hash(bytes) !== hash(pinned)) throw Error('Uncommitted guidance differs: ' + path);
  await cp(path, join(root, path), { recursive: true });
  files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
const manifest = {
  format: 'wishos-guidance/1',
  version: pkg.version,
  source_commit: commit,
  os_reference_commit: snapshot.commit,
  files,
};
await writeFile(join(root, 'guidance.json'), JSON.stringify(manifest, null, 2) + '\n');
const archive = join(parent, name + '.zip');
await rm(archive, { force: true });
execFileSync('zip', ['-q', '-r', archive, name], { cwd: parent });
const bytes = await readFile(archive),
  sha256 = hash(bytes);
await writeFile(archive + '.sha256', sha256 + '  ' + name + '.zip\n');
await writeFile(
  join(parent, 'guidance-publication.json'),
  JSON.stringify(
    {
      ...manifest,
      archive: { name: name + '.zip', bytes: bytes.length, sha256 },
      build: {
        id: process.env.GITHUB_RUN_ID ?? null,
        url: process.env.GITHUB_RUN_ID
          ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : null,
      },
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    source_commit: commit,
    os_reference_commit: snapshot.commit,
    archive,
    sha256,
    files: files.length,
  }),
);
