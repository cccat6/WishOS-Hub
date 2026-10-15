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
  releaseVisibility,
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

test('both visibility transitions retain the explicit release ID, tag and source commit', () => {
  const plan = { release_id: 414006214, tag: 'v0.4.0-preview.1', source_commit: commit };
  const original = { id: plan.release_id, tag_name: plan.tag, prerelease: true, draft: false };
  // GitHub can reset tag_name on draft edits when it is omitted from the patch.
  const patch = (state: any, fields: any) => ({
    ...state,
    tag_name: fields.tag_name ?? 'untagged',
    ...fields,
  });
  const draft = patch(original, releaseVisibility(plan, true));
  validatePreviewIdentity(draft, { id: plan.release_id, tag: plan.tag });
  assert.equal(draft.draft, true);
  assert.equal(draft.target_commitish, commit);
  assert.equal('target_commitish' in releaseVisibility(plan, true), false);
  const published = patch(draft, releaseVisibility(plan, false));
  validatePreviewIdentity(published, { id: plan.release_id, tag: plan.tag });
  assert.equal(published.draft, false);
  assert.throws(
    () =>
      validatePreviewIdentity(
        { ...draft, tag_name: 'untagged' },
        { id: plan.release_id, tag: plan.tag },
      ),
    /identity/,
  );
  assert.throws(() => validatePreviewIdentity(draft, { id: 999, tag: plan.tag }), /identity/);
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
