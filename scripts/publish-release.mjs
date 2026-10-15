import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, appendFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const platforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];
const planPath = 'publication-source.json';
const gh = (...args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
const api = (repo, path) => JSON.parse(gh('api', `repos/${repo}/${path}`));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fileDigest(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}
export function validateSource(run, artifacts, tagCommit) {
  if (run.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== tagCommit)
    throw Error('Build is not a successful run of the exact release commit');
  if (!['.github/workflows/release.yml', '.github/workflows/build.yml'].includes(run.path))
    throw Error('Source must be the build workflow, not an arbitrary artifact uploader');
  const selected = artifacts.filter((a) => a.name.startsWith('wishos-hub-'));
  const names = platforms.map((p) => `wishos-hub-${p}`).sort();
  if (JSON.stringify(selected.map((a) => a.name).sort()) !== JSON.stringify(names))
    throw Error('The selected build does not contain exactly the four platform artifacts');
  if (
    selected.some(
      (a) =>
        a.expired ||
        a.workflow_run?.head_sha !== tagCommit ||
        !/^sha256:[a-f0-9]{64}$/.test(a.digest),
    )
  )
    throw Error('Artifact provenance or transport digest is invalid');
  return selected;
}
export function verifyArchiveManifest(text, archive) {
  const fields = text.trim().match(/^([a-f0-9]{64})\s+([^\r\n]+)$/);
  if (!fields || fields[2] !== archive.name || fields[1] !== archive.sha256)
    throw Error(`Archive differs from its source artifact manifest: ${archive.name}`);
}
export function verifyRemoteAssets(release, files) {
  for (const file of files) {
    const matches = release.assets.filter((a) => a.name === file.name);
    if (
      matches.length !== 1 ||
      matches[0].size !== file.size ||
      matches[0].digest !== `sha256:${file.sha256}`
    )
      throw Error(`Uploaded release asset differs from the selected source: ${file.name}`);
  }
}
async function tagCommit(repo, tag) {
  let object = api(repo, `git/ref/tags/${encodeURIComponent(tag)}`).object;
  for (let depth = 0; object.type === 'tag' && depth < 10; depth++)
    object = api(repo, `git/tags/${object.sha}`).object;
  if (object.type !== 'commit') throw Error('Release tag must resolve to a commit');
  return object.sha;
}
async function prepare() {
  const repo = process.env.GITHUB_REPOSITORY,
    tag = process.env.RELEASE_TAG,
    runId = process.env.RUN_ID;
  if (
    !repo?.match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) ||
    !tag?.match(/^[A-Za-z0-9_.-]+$/) ||
    !runId?.match(/^\d+$/)
  )
    throw Error('Invalid release coordinates');
  const commit = await tagCommit(repo, tag),
    run = api(repo, `actions/runs/${runId}`);
  const listing = api(repo, `actions/runs/${runId}/artifacts?per_page=100`);
  const artifacts = validateSource(run, listing.artifacts, commit);
  const release = api(repo, `releases/tags/${encodeURIComponent(tag)}`);
  if (!release.prerelease) throw Error('This publisher only manages preview releases');
  const raw = api(repo, `contents/package.json?ref=${commit}`);
  const version = JSON.parse(Buffer.from(raw.content, 'base64').toString()).version;
  if (tag !== `v${version}`)
    throw Error('Release version differs from the selected source package');
  const plan = {
    format: 'wishos-publication/1',
    repository: repo,
    tag,
    version,
    source_commit: commit,
    build: { id: run.id, attempt: run.run_attempt, url: run.html_url, workflow: run.path },
    artifacts: artifacts.map((a) => ({
      id: a.id,
      name: a.name,
      digest: a.digest,
      created_at: a.created_at,
    })),
    publisher: { run_id: process.env.GITHUB_RUN_ID, source_commit: process.env.GITHUB_SHA },
  };
  await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `artifact_ids=${artifacts.map((a) => a.id).join(',')}\n`,
    );
  console.log(
    JSON.stringify({
      prepared: true,
      build: plan.build,
      source_commit: commit,
      artifact_ids: artifacts.map((a) => a.id),
    }),
  );
}
async function publish(directory) {
  const plan = JSON.parse(await readFile(planPath, 'utf8')),
    root = resolve(directory);
  const currentRun = api(plan.repository, `actions/runs/${plan.build.id}`);
  const artifacts = api(
    plan.repository,
    `actions/runs/${plan.build.id}/artifacts?per_page=100`,
  ).artifacts;
  const current = validateSource(currentRun, artifacts, await tagCommit(plan.repository, plan.tag));
  if (
    JSON.stringify(current.map((a) => [a.id, a.digest]).sort()) !==
    JSON.stringify(plan.artifacts.map((a) => [a.id, a.digest]).sort())
  )
    throw Error('The selected artifact set changed after preparation');
  const expectedNames = platforms
    .flatMap((p) => {
      const file = `wishos-hub-${plan.version}-${p}${p.startsWith('win32') ? '.zip' : '.tar.gz'}`;
      return [file, `${file}.sha256`];
    })
    .sort();
  const names = (await readdir(root)).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames))
    throw Error('Downloaded artifact contents do not match the source package set');
  const files = [];
  for (const name of names) files.push({ name, ...(await fileDigest(join(root, name))) });
  const archives = files.filter((f) => !f.name.endsWith('.sha256'));
  for (const archive of archives)
    verifyArchiveManifest(await readFile(join(root, `${archive.name}.sha256`), 'utf8'), archive);
  const release = api(plan.repository, `releases/tags/${encodeURIComponent(plan.tag)}`);
  if (!release.prerelease) throw Error('Refusing to replace a non-preview release');
  // Existing populated releases require an explicit owner-requested replacement.
  if (
    release.assets.some((a) => /\.(zip|tar\.gz)$/.test(a.name)) &&
    process.env.REPLACE_EXISTING !== 'true'
  )
    throw Error('Release already has packages; explicit replace_existing is required');
  const provenance = {
    ...plan,
    published_at: new Date().toISOString(),
    archives,
    replaced_assets: release.assets
      .filter((a) => expectedNames.includes(a.name) || a.name === 'SHA256SUMS')
      .map((a) => ({ name: a.name, digest: a.digest, updated_at: a.updated_at })),
  };
  await writeFile(
    join(root, 'SHA256SUMS'),
    archives.map((a) => `${a.sha256}  ${a.name}\n`).join(''),
  );
  await writeFile(join(root, 'publication.json'), JSON.stringify(provenance, null, 2) + '\n');
  for (const name of ['SHA256SUMS', 'publication.json'])
    files.push({ name, ...(await fileDigest(join(root, name))) });
  // Hide the preview while GitHub's per-asset API is being updated. Failure leaves
  // a draft; only a fully checked generation is made visible again.
  gh('release', 'edit', plan.tag, '--repo', plan.repository, '--draft');
  gh(
    'release',
    'upload',
    plan.tag,
    '--repo',
    plan.repository,
    '--clobber',
    ...files.map((f) => join(root, f.name)),
  );
  verifyRemoteAssets(api(plan.repository, `releases/tags/${encodeURIComponent(plan.tag)}`), files);
  gh('release', 'edit', plan.tag, '--repo', plan.repository, '--draft=false', '--prerelease');
  const final = api(plan.repository, `releases/tags/${encodeURIComponent(plan.tag)}`);
  verifyRemoteAssets(final, files);
  if (final.draft) throw Error('Release did not leave draft state');
  console.log(
    JSON.stringify(
      {
        published: true,
        url: final.html_url,
        source_build: plan.build,
        source_commit: plan.source_commit,
        archives,
        uploaded_files_verified: files.length,
      },
      null,
      2,
    ),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'prepare') await prepare();
  else if (process.argv[2] === 'publish') await publish(process.argv[3] ?? 'release-assets');
  else throw Error('Usage: publish-release.mjs prepare | publish DIR');
}
