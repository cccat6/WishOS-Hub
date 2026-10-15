declare module 'luaparse' {
  export type Token = { type: number; value: unknown; line: number; range: [number, number] };
  const api: { parse(source: string, options: Record<string, unknown>): unknown; lex(): Token };
  export default api;
}
