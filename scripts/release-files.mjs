// Product files only. Keep local run journals, audits and test tools outside releases.
export const releaseFiles = [
  'dist',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
  'skills',
  'vendor',
  ...[
    'audio-batch-contract.md',
    'cloud-deployment.md',
    'device-link-contract.md',
    'font-check-contract.md',
    'input-layout-authoring.md',
    'integration-architecture.md',
    'package-contract-proposal.md',
    'release-integrity.md',
    'release-notes.md',
    'reply-audio-contract.md',
    'request-progress-contract.md',
    'session-control-contract.md',
    'validation.md',
  ].map((p) => 'docs/' + p),
];

/** Select from the source tree, so ignored local additions cannot enter an archive. */
export function releaseSourceFiles(tracked) {
  return tracked.filter((path) =>
    releaseFiles.some(
      (entry) =>
        entry !== 'dist' &&
        (path === entry || (['skills', 'vendor'].includes(entry) && path.startsWith(entry + '/'))),
    ),
  );
}
