import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The publisher is a dependency-free Node CLI, shared with CI.
import {
  validateSource,
  verifyArchiveManifest,
  verifyRemoteAssets,
  sha256,
  validatePreviewIdentity,
  verifyPublication,
  uploadAsset,
} from '../scripts/publish-release.mjs';
const commit = 'a'.repeat(40);
function source() {
  return ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'].map((p, i) => ({
    id: i + 1,
    name: 'wishos-hub-' + p,
    expired: false,
    digest: 'sha256:' + 'b'.repeat(64),
    workflow_run: { head_sha: commit },
  }));
}
const run = {
  status: 'completed',
  conclusion: 'success',
  head_sha: commit,
  path: '.github/workflows/build.yml',
};
test('publication pins a successful source commit and exactly the complete platform set', () => {
  assert.equal(validateSource(run, source(), commit).length, 4);
  assert.throws(
    () => validateSource({ ...run, conclusion: 'failure' }, source(), commit),
    /successful/,
  );
  assert.throws(() => validateSource(run, source(), 'c'.repeat(40)), /exact release commit/);
  assert.throws(() => validateSource(run, source().slice(1), commit), /four platform/);
  assert.throws(() => validateSource(run, [...source(), source()[0]], commit), /four platform/);
  assert.throws(
    () =>
      validateSource(
        run,
        source().map((a, i) => (i ? a : { ...a, workflow_run: { head_sha: 'old' } })),
        commit,
      ),
    /provenance/,
  );
});
test('a stale per-file manifest or aggregate generation cannot be accepted by changing remote checks alone', () => {
  const name = 'wishos-hub-test-darwin-arm64.tar.gz',
    archive = { name, sha256: sha256('original CI bytes'), size: 17 };
  verifyArchiveManifest(archive.sha256 + '  ' + name + '\n', archive);
  assert.throws(
    () => verifyArchiveManifest(sha256('different batch') + '  ' + name + '\n', archive),
    /source artifact manifest/,
  );
  assert.throws(
    () => verifyArchiveManifest(archive.sha256 + '  ../different.tar.gz\n', archive),
    /source artifact manifest/,
  );
  const files = [archive, { name: 'SHA256SUMS', sha256: sha256('source manifest'), size: 100 }];
  const remote = { assets: files.map((f) => ({ ...f, digest: 'sha256:' + f.sha256 })) };
  verifyRemoteAssets(remote, files);
  assert.throws(
    () =>
      verifyRemoteAssets(
        {
          assets: remote.assets.map((a) =>
            a.name === name ? { ...a, digest: 'sha256:' + sha256('later overwrite') } : a,
          ),
        },
        files,
      ),
    /Uploaded release asset differs/,
  );
  assert.throws(
    () => verifyRemoteAssets({ assets: [...remote.assets, remote.assets[0]] }, files),
    /Uploaded release asset differs/,
  );
  assert.throws(
    () =>
      verifyRemoteAssets({ assets: remote.assets.filter((a) => a.name !== 'SHA256SUMS') }, files),
    /Uploaded release asset differs/,
  );
});

test('owner publication checks complete source lineage and rejects unverified or altered draft assets', () => {
  const artifacts = source(),
    archives = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'].map((p) => ({
      name: 'wishos-hub-test-' + p + (p.startsWith('win32') ? '.zip' : '.tar.gz'),
      sha256: sha256(p),
      size: 100,
    }));
  const files = archives
    .flatMap((a) => [a, { name: a.name + '.sha256', sha256: sha256(a.sha256), size: 100 }])
    .concat({ name: 'SHA256SUMS', sha256: sha256('manifest'), size: 100 });
  const manifest = {
    release_id: 414006214,
    tag: 'vtest',
    source_commit: commit,
    artifacts,
    archives,
    files,
    publisher: { run_id: 99, source_commit: 'publisher-sha' },
  };
  const release = {
    id: manifest.release_id,
    tag_name: manifest.tag,
    prerelease: true,
    draft: true,
    assets: files.map((f) => ({ ...f, digest: 'sha256:' + f.sha256 })),
  };
  const verification = {
    id: 99,
    status: 'completed',
    conclusion: 'success',
    head_sha: 'publisher-sha',
    path: '.github/workflows/publish-existing.yml',
  };
  verifyPublication(manifest, release, verification, run, artifacts, commit);
  verifyPublication(manifest, { ...release, draft: false }, verification, run, artifacts, commit);
  assert.throws(
    () =>
      verifyPublication(
        manifest,
        release,
        { ...verification, conclusion: 'failure' },
        run,
        artifacts,
        commit,
      ),
    /not successful/,
  );
  assert.throws(
    () =>
      verifyPublication(
        manifest,
        { ...release, assets: release.assets.slice(1) },
        verification,
        run,
        artifacts,
        commit,
      ),
    /Uploaded release asset differs/,
  );
  assert.throws(
    () =>
      verifyPublication(
        manifest,
        { ...release, tag_name: 'untagged' },
        verification,
        run,
        artifacts,
        commit,
      ),
    /identity/,
  );
  assert.throws(
    () =>
      verifyPublication(
        manifest,
        release,
        verification,
        run,
        artifacts.map((a, i) => (i ? a : { ...a, id: 999 })),
        commit,
      ),
    /source changed/,
  );
});
test('draft asset upload uses its release ID, streams original bytes and validates the upload receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wishos-release-upload-')),
    bytes = Buffer.from([0, 255, 128, 64, 1, 2, 3]),
    path = join(root, 'package.zip');
  const file = { name: 'package.zip', size: bytes.length, sha256: sha256(bytes) };
  const release = {
    id: 414006214,
    upload_url:
      'https://uploads.github.com/repos/cccat6/WishOS-Hub/releases/414006214/assets{?name,label}',
  };
  try {
    await writeFile(path, bytes);
    await uploadAsset('cccat6/WishOS-Hub', release, file, path, {
      token: 'fixture-only',
      fetcher: async (url: any, init: any) => {
        assert.equal(url.pathname, '/repos/cccat6/WishOS-Hub/releases/414006214/assets');
        assert.equal(url.searchParams.get('name'), file.name);
        assert.equal(init.headers.Authorization, 'Bearer fixture-only');
        assert.equal(init.redirect, 'error');
        assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()), bytes);
        return Response.json({ ...file, digest: 'sha256:' + file.sha256 }, { status: 201 });
      },
    });
    await assert.rejects(
      uploadAsset('cccat6/WishOS-Hub', release, file, path, {
        token: 'fixture-only',
        fetcher: async () =>
          Response.json({ ...file, digest: 'sha256:' + sha256('wrong') }, { status: 201 }),
      }),
      /Uploaded release asset differs/,
    );
    await assert.rejects(
      uploadAsset(
        'cccat6/WishOS-Hub',
        { ...release, upload_url: 'https://unrelated.invalid/upload' },
        file,
        path,
        { token: 'fixture-only' },
      ),
      /Unexpected GitHub asset upload destination/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
