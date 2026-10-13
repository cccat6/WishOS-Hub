import { randomUUID } from 'node:crypto';
import type { HarnessAdapter, AgentEvent } from './types.js';
export class MockAdapter implements HarnessAdapter {
  name = 'mock';
  capabilities = { interrupt: false, approval: false };
  async open(id?: string) {
    return id ?? randomUUID();
  }
  async send(_session: string, text: string, emit: (e: AgentEvent) => void) {
    const result = `[MOCK - no model called] ${text}`;
    emit({ type: 'text', text: result });
    return result;
  }
  async close() {}
}
