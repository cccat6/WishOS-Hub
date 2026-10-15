import { smokePackage } from './smoke-package.mjs';
import { readFile, mkdir, cp, writeFile, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
if (process.version !== 'v24.22.0') throw Error('Release requires pinned Node v24.22.0');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const name = `wishos-hub-${pkg.version}-${process.platform}-${process.arch}`;
const root = resolve('build/release', name);
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
for (const file of [
  'dist',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'README.md',
  'docs',
  'skills',
])
  await cp(file, join(root, file), { recursive: true });
execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['ci', '--omit=dev', '--no-audit', '--no-fund'],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH },
  },
);
await mkdir(join(root, 'runtime'));
await cp(
  process.execPath,
  join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
);
// Keep the exact Node distribution license with the vendored runtime.
const nodeVersion = process.version;
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`);
if (!license.ok) throw Error('Node license download failed');
await writeFile(join(root, 'runtime', 'LICENSE'), await license.text());
const sh =
  '#!/bin/sh\nset -eu\nWISHOS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$WISHOS_DIR/runtime/node" --use-env-proxy "$WISHOS_DIR/dist/connect/cli.js" "$@"\n';
await writeFile(join(root, 'wishos-hub'), sh);
await chmod(join(root, 'wishos-hub'), 0o755);
await writeFile(
  join(root, 'WishOS Hub.command'),
  '#!/bin/sh\nWISHOS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$WISHOS_DIR/wishos-hub" setup\n',
);
await chmod(join(root, 'WishOS Hub.command'), 0o755);
await writeFile(
  join(root, 'WishOS Hub.cmd'),
  '@echo off\r\n"%~dp0runtime\\node.exe" --use-env-proxy "%~dp0dist\\connect\\cli.js" setup\r\npause\r\n',
);
execFileSync(
  join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  [join(root, 'dist/connect/cli.js'), '--help'],
  { stdio: 'inherit' },
);
await smokePackage(root);
const archive = resolve(
  'build/release',
  name + (process.platform === 'win32' ? '.zip' : '.tar.gz'),
);
if (process.platform === 'win32')
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${root.replaceAll("'", "''")}\\*' -DestinationPath '${archive.replaceAll("'", "''")}' -Force`,
    ],
    { stdio: 'inherit' },
  );
else
  execFileSync('tar', ['-czf', archive, '-C', resolve('build/release'), name], {
    stdio: 'inherit',
  });
const bytes = await readFile(archive);
await writeFile(
  archive + '.sha256',
  createHash('sha256').update(bytes).digest('hex') + '  ' + archive.split(/[\\/]/).at(-1) + '\n',
);
console.log(archive);
