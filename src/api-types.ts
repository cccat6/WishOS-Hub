export type HubApi = (
  path: string,
  body?: unknown,
) => Promise<{ content: { type: 'text'; text: string }[] }>;
