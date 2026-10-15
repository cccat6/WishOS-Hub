import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The publisher is a dependency-free Node CLI, shared with CI.
import {
  validateSource,
  verifyArchiveManifest,
  verifyRemoteAssets,
  sha256,
  selectReleaseId,
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

test('draft and published release lookup retains one immutable release identity', () => {
  assert.equal(selectReleaseId([414006214]), 414006214);
  assert.throws(() => selectReleaseId([]), /exactly one release/);
  assert.throws(() => selectReleaseId([414006214, 414006215]), /exactly one release/);
});
