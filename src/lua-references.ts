import lexer from 'luaparse';
import type { Token } from 'luaparse';
/** The C compiler validates syntax. This lexer is used only to identify literal
 * references; dynamic expressions are retained as unproved, never "validated". */
function literal(raw: string) {
  if (raw.startsWith('[')) {
    const open = raw.match(/^\[(=*)\[/)![0],
      close = ']' + open.slice(1, -1) + ']';
    let value = raw.slice(open.length, -close.length).replace(/\r\n|\n\r|\r/g, '\n');
    if (value.startsWith('\n')) value = value.slice(1);
    return value;
  }
  const out: number[] = [],
    encoder = new TextEncoder();
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] !== '\\') {
      const cp = raw.codePointAt(i)!;
      out.push(...encoder.encode(String.fromCodePoint(cp)));
      if (cp > 65535) i++;
      continue;
    }
    const escape = raw[++i]!,
      simple: Record<string, number> = {
        a: 7,
        b: 8,
        f: 12,
        n: 10,
        r: 13,
        t: 9,
        v: 11,
        '\\': 92,
        '"': 34,
        "'": 39,
      };
    if (escape in simple) {
      out.push(simple[escape]!);
      continue;
    }
    if (escape === 'z') {
      while (/\s/.test(raw[i + 1] ?? '') && i + 1 < raw.length - 1) i++;
      continue;
    }
    if (escape === 'x') {
      out.push(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    if (escape === 'u') {
      const end = raw.indexOf('}', i);
      out.push(...encoder.encode(String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16))));
      i = end;
      continue;
    }
    if (/[0-9]/.test(escape)) {
      let digits = escape;
      while (digits.length < 3 && /[0-9]/.test(raw[i + 1] ?? '')) digits += raw[++i];
      out.push(Number(digits));
      continue;
    }
    if (escape === '\r' || escape === '\n') {
      out.push(10);
      if (raw[i + 1] && raw[i + 1] !== escape && /[\r\n]/.test(raw[i + 1]!)) i++;
      continue;
    }
    throw Error('lua_reference_encoding');
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(out));
}
export function luaReferences(source: string) {
  lexer.parse(source, { wait: true, luaVersion: '5.3', encodingMode: 'none', comments: false });
  const tokens: Token[] = [];
  for (;;) {
    const t = lexer.lex();
    if (t.type === 1) break;
    tokens.push(t);
  }
  const modules: { path?: string; line: number }[] = [];
  const text = (t: Token | undefined) =>
    t?.type === 2 ? literal(source.slice(t.range[0], t.range[1])) : undefined;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.value !== 'notes' || tokens[i + 1]?.value !== '.') continue;
    const method = tokens[i + 2]?.value;
    if (method !== 'require') continue;
    const arg = i + 3 + (tokens[i + 3]?.value === '(' ? 1 : 0),
      path = text(tokens[arg]);
    modules.push({ path, line: tokens[i]!.line });
  }
  return { modules };
}
