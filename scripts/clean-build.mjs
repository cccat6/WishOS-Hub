import { rm } from 'node:fs/promises';
// Generated output only: deleted sources must not survive into an installer.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
