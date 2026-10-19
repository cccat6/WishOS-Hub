import { execFileSync } from 'node:child_process';
/** Export file bytes, not the publisher machine's extended attributes. */
export function createTarArchive(archive, parent, name) {
  execFileSync('tar', ['-czf', archive, '-C', parent, name], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
}
