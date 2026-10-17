export type HarnessSession = {
  id: string;
  title: string;
  summary?: string;
  created_at?: number;
  updated_at?: number;
  state?: string;
  ephemeral?: boolean;
};
export type HarnessMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  created_at?: number;
  preview?: boolean;
};
export type HarnessPage<T> = { entries: T[]; next_cursor: string | null };
