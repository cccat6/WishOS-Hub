import { textRaster, svgRaster } from './rendering.js';

const cached = new Map<string, Promise<string>>();
export function voiceFeedbackRaster(kind: 'processing' | 'failed'): Promise<string> {
  if (!cached.has(kind)) {
    const title = kind === 'processing' ? '稍等' : '未能处理';
    const caption = kind === 'processing' ? '正在处理你的语音' : '可以继续按住功能键说话';
    const icon =
      kind === 'processing'
        ? `<circle cx="240" cy="208" r="56" fill="#ffe100"/>
           <path d="M220 180h40v12l-20 16 20 16v12h-40v-12l20-16-20-16z" fill="none" stroke="#000000" stroke-width="6" stroke-linejoin="round"/>`
        : `<circle cx="240" cy="208" r="56" fill="#dc1e1e"/>
             <path d="M222 190l36 36m0-36l-36 36" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/>`;
    // Static six-ink artwork; fast waveform selection is independent of its colors.
    // SVG text uses the same native-grid stem renderer as the accepted status pages.
    const value = svgRaster(
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720" viewBox="0 0 480 720">
        <rect width="480" height="720" fill="#ffffff"/>
        <rect x="32" y="32" width="48" height="8" rx="4" fill="#1e4bb4"/>
        <g fill="#000000" font-family="sans-serif">
          <text x="32" y="88" font-size="32">Agentic Notes</text>
          ${icon}
          <text x="240" y="350" font-size="60" text-anchor="middle">${title}</text>
          <text x="240" y="421" font-size="24" text-anchor="middle">${caption}</text>
        </g>
        <circle cx="216" cy="510" r="6" fill="#1e4bb4"/>
        <circle cx="240" cy="510" r="6" fill="#dc1e1e"/>
        <circle cx="264" cy="510" r="6" fill="#19964b"/>
      </svg>`,
      { color_mode: 'nearest', svg_text_mode: 'grid' },
      8000,
    )
      .then((result) => result.data)
      .catch((error) => {
        cached.delete(kind);
        throw error;
      });
    cached.set(kind, value);
  }
  return cached.get(kind)!;
}

/** Fallback presents the actual answer, never a generic completion splash. */
export async function voiceResultRaster(text: string, maximum = 8000): Promise<string> {
  const normalized = text
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '')
    .trim();
  // Keep first page readable; full answer remains in the Harness session/Hub.
  const chars = [...normalized],
    lines: string[] = [];
  let line = '',
    width = 0;
  for (const c of chars) {
    const w = /[\x20-\x7e]/.test(c) ? 0.62 : 1;
    if (c === '\n' || width + w > 16) {
      lines.push(line);
      line = '';
      width = 0;
      if (lines.length >= 16) break;
    }
    if (c !== '\n') {
      line += c;
      width += w;
    }
  }
  if (lines.length < 16 && line) lines.push(line);
  if (lines.join('').length < normalized.replace(/\n/g, '').length && lines.length)
    lines[lines.length - 1] = lines.at(-1)!.slice(0, -1) + '…';
  const result = await textRaster(
    {
      background: 1,
      orientation: 'portrait',
      blocks: [
        { x: 32, y: 36, w: 416, h: 52, text: 'Agentic Notes', font_size: 32, color: 3 },
        {
          x: 32,
          y: 124,
          w: 416,
          h: 560,
          text: lines.join('\n'),
          font_size: 24,
          line_height: 34,
          hinting: 'stems',
          baseline_mode: 'font',
        },
      ],
    },
    maximum,
  );
  return result.data;
}
