import { renderAsync } from '@resvg/resvg-js';
const chunks: Buffer[] = [];
let size = 0;
for await (const part of process.stdin) {
  size += part.length;
  // Native-grid glyph preparation can expand a small source SVG considerably.
  if (size > 16 * 1024 * 1024) throw Error('SVG worker input exceeds limit');
  chunks.push(part);
}
const { svg, options } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (typeof svg !== 'string' || !options || typeof options !== 'object')
  throw Error('Invalid SVG worker input');
const image = await renderAsync(svg, options);
process.stdout.write(image.asPng());
