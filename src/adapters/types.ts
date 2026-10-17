import type { NativeSpeech } from '../voice.js';
import type { HarnessUsage } from './usage.js';
import type { HarnessSession, HarnessMessage, HarnessPage } from './sessions.js';
export interface AgentEvent {
  type: 'text' | 'status' | 'approval';
  text?: string;
  requestId?: string;
  request?: unknown;
}
export interface HarnessAdapter {
  readonly name: string;
  readonly nativeSpeech?: NativeSpeech;
  readonly capabilities: {
    interrupt: boolean;
    approval: boolean;
    usage?: boolean;
    steer?: boolean;
  };
  readUsage?(session?: string): Promise<HarnessUsage>;
  readTools?(session: string): Promise<unknown>;
  reloadTools?(): Promise<unknown>;
  listSessions?(options: { cursor?: string; limit: number }): Promise<HarnessPage<HarnessSession>>;
  readSession?(id: string): Promise<HarnessSession>;
  createSession?(): Promise<HarnessSession>;
  listMessages?(
    id: string,
    options: { cursor?: string; limit: number },
  ): Promise<HarnessPage<HarnessMessage>>;
  open(nativeId?: string): Promise<string>;
  send(session: string, text: string, emit: (e: AgentEvent) => void): Promise<string>;
  /** False only when the turn has ended; transport failures must not be replayed. */
  steer?(session: string, text: string): Promise<boolean>;
  interrupt?(session: string): Promise<void>;
  approve?(id: string, accept: boolean, content?: unknown): void;
  close(): Promise<void>;
}
