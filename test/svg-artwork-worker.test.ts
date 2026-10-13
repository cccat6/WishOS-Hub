import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAsync } from '../dist/svg-artwork.js';

test('isolated renderer preserves PNG bytes while signed host avoids native addon loading', async () => {
  const previous = process.env.NOTES_DESKTOP_SIGNED_RUNTIME;
  const previousNode = process.env.NOTES_RENDER_NODE;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="white"/><circle cx="32" cy="32" r="18" fill="red"/></svg>';
  try {
    delete process.env.NOTES_DESKTOP_SIGNED_RUNTIME;
    const direct = await renderAsync(svg, { font: { loadSystemFonts: false } });
    process.env.NOTES_DESKTOP_SIGNED_RUNTIME = '1';
    process.env.NOTES_RENDER_NODE = process.execPath;
    const isolated = await renderAsync(svg, { font: { loadSystemFonts: false } });
    assert.ok(Buffer.from(direct.asPng()).equals(Buffer.from(isolated.asPng())));
  } finally {
    if (previous === undefined) delete process.env.NOTES_DESKTOP_SIGNED_RUNTIME;
    else process.env.NOTES_DESKTOP_SIGNED_RUNTIME = previous;
    if (previousNode === undefined) delete process.env.NOTES_RENDER_NODE;
    else process.env.NOTES_RENDER_NODE = previousNode;
  }
});
