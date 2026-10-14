import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createNotesMcp } from './mcp-tools.js';
import { createWishosMcp } from './wishos-mcp.js';
import { hubApi } from './hub-api.js';
const server = (process.env.NOTES_PROTOCOL === 'notes' ? createNotesMcp : createWishosMcp)(
  hubApi(process.env.NOTES_HUB_URL ?? 'http://127.0.0.1:8787', process.env.NOTES_ADMIN_TOKEN ?? ''),
);
await server.connect(new StdioServerTransport());
