import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod-modern';
import { osReferences } from './generated/os-references.js';
import { guidance } from './generated/guidance.js';
export const guidanceIndexUri = 'wishos://guidance/components';
export const guidanceCatalog = {
  format: 'wishos-components/1',
  scope: 'Hub-bundled portable guidance; selected device implementations are discovered separately',
  components: guidance.map(({ text, ...record }) => record),
  references: osReferences.map(({ text, ...record }) => record),
};
export function guidanceLinks() {
  return [
    {
      type: 'resource_link' as const,
      uri: guidanceIndexUri,
      name: 'WishOS component and skill index',
      mimeType: 'application/json',
    },
  ];
}
export function guideToolReply(reply: CallToolResult): CallToolResult {
  return { ...reply, content: [...(reply.content ?? []), ...guidanceLinks()] };
}
export function registerGuidance(server: McpServer) {
  server.registerResource(
    'wishos-components',
    guidanceIndexUri,
    { title: 'WishOS components and skills', mimeType: 'application/json' },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(guidanceCatalog) },
      ],
    }),
  );
  for (const reference of osReferences)
    server.registerResource(
      'os-' + reference.id,
      reference.uri,
      {
        title: 'WishOS ' + reference.id,
        mimeType: 'text/markdown',
        description:
          'Pinned authoritative OS runtime reference; consult live metadata for version-specific capabilities',
      },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: reference.text }] }),
    );
  for (const guide of guidance)
    server.registerResource(
      guide.id,
      guide.uri,
      {
        title: guide.id,
        mimeType: 'text/markdown',
        description: `${guide.layer} layer guidance; schema discovery remains authoritative`,
      },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide.text }] }),
    );
  server.registerTool(
    'get_guidance',
    {
      description:
        'Read WishOS component/skill index or a complete selected guide. Available as a tool for clients that do not expose MCP resource browsing.',
      inputSchema: z.object({ component_id: z.string().default('index') }),
    },
    async ({ component_id }) => {
      if (component_id === 'index')
        return {
          content: [
            { type: 'text', text: JSON.stringify(guidanceCatalog) },
            ...guidance.map((g) => ({
              type: 'resource_link' as const,
              uri: g.uri,
              name: g.id,
              mimeType: g.mimeType,
            })),
          ],
        };
      const guide =
        guidance.find((g) => g.id === component_id) ??
        osReferences.find((g) => g.id === component_id);
      if (!guide) throw Error('guidance_not_found');
      return {
        content: [
          {
            type: 'resource',
            resource: { uri: guide.uri, mimeType: 'text/markdown', text: guide.text },
          },
        ],
      };
    },
  );
  server.registerPrompt(
    'wishos-authoring',
    {
      description:
        'Author or update a WishOS application after discovering system, driver and package contracts.',
      argsSchema: z.object({ device_id: z.string().optional(), task: z.string().optional() }),
    },
    ({ device_id, task }) => ({
      description: 'WishOS runtime authoring',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Use WishOS MCP for the requested task${device_id ? ' on device ' + JSON.stringify(device_id) : ''}. Read ${guidanceIndexUri} (or get_guidance), then the system, selected driver and application/package guides. Discover live schemas and budgets; use real preflight before device delivery. Replace whole files in immutable revisions. Native validation and admission remain authoritative; a successful parser is not proof of arbitrary program semantics. Task: ${task ?? 'Inspect the selected device and explain an appropriate runtime package plan.'}`,
          },
        },
      ],
    }),
  );
}
