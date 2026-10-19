import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseFiles, releaseSourceFiles } from '../scripts/release-files.mjs';
import { stat, readFile } from 'node:fs/promises';
test('release manifest includes product contracts/licenses and excludes local records and hardware test clients', async () => {
  assert(releaseFiles.includes('LICENSE'));
  assert(releaseFiles.includes('THIRD_PARTY_NOTICES.md'));
  assert(releaseFiles.includes('docs/reply-audio-contract.md'));
  for (const entry of releaseFiles) {
    assert(!['docs', 'build', 'tools', 'assets', 'test', 'scripts', 'data'].includes(entry));
    assert(
      !/engineering-corrections|s3-local|deployments|full-audit|native-cloud|p1-app/.test(entry),
    );
    if (entry !== 'dist')
      assert(
        (await stat(new URL('../' + entry, import.meta.url))).isFile() ||
          ['skills', 'vendor'].includes(entry),
      );
  }
  const script = await readFile(new URL('../scripts/package-release.mjs', import.meta.url), 'utf8');
  assert(script.includes('for (const file of releaseSourceFiles(tracked))'));
});

test('release tar contains product bytes and omits AppleDouble machine metadata', async () => {
  const { createTarArchive } = await import('../scripts/release-archive.mjs');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'wishos-export-'));
  try {
    await mkdir(join(dir, 'product'));
    const file = join(dir, 'product', 'hello.txt');
    await writeFile(file, 'public product');
    if (process.platform === 'darwin')
      execFileSync('/usr/bin/xattr', [
        '-w',
        'com.apple.metadata:WishOSTest',
        'local metadata fixture',
        file,
      ]);
    const archive = join(dir, 'product.tar.gz');
    createTarArchive(archive, dir, 'product');
    const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert(names.some((p) => p.endsWith('hello.txt')));
    assert(!names.some((p) => p.split('/').some((q) => q.startsWith('._'))));
    assert.equal(
      execFileSync('tar', ['-xOzf', archive, 'product/hello.txt'], { encoding: 'utf8' }),
      'public product',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('release source selection exports only public tracked paths, not nearby ignored evidence', () => {
  const tracked = [
    'README.md',
    'LICENSE',
    'skills/wishos/SKILL.md',
    'vendor/lua-parser/LICENSE',
    'docs/engineering-corrections.md',
    'docs/deployment-status.json',
    'test/fixture.ts',
    'connector.json',
  ];
  assert.deepEqual(releaseSourceFiles(tracked), [
    'README.md',
    'LICENSE',
    'skills/wishos/SKILL.md',
    'vendor/lua-parser/LICENSE',
  ]);
});
