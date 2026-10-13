import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ResvgRenderOptions } from '@resvg/resvg-js';
export async function renderAsync(svg: string | Buffer, options: ResvgRenderOptions) {
  if (process.env.NOTES_DESKTOP_SIGNED_RUNTIME !== '1') {
    const engine = await import('@resvg/resvg-js');
    return engine.renderAsync(svg, options);
  }
  // Keep the signed desktop caller free of unrelated native libraries.
  const runtime = process.env.NOTES_RENDER_NODE ?? 'node';
  const worker = fileURLToPath(new URL('./svg-artwork-worker.js', import.meta.url));
  const png = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(runtime, [worker], {
      stdio: 'pipe',
      shell: false,
      env: { PATH: process.env.PATH ?? '' },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('SVG render worker timeout'));
    }, 45000);
    timer.unref();
    child.stdout.on('data', (data: Buffer) => {
      size += data.length;
      if (size > 16 * 1024 * 1024) {
        child.kill('SIGKILL');
        reject(Error('SVG render output too large'));
      } else chunks.push(data);
    });
    child.stderr.on('data', () => {});
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(Error(`SVG render worker failed (${code})`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(
      JSON.stringify({ svg: typeof svg === 'string' ? svg : svg.toString('utf8'), options }),
    );
  });
  return { asPng: () => png };
}
