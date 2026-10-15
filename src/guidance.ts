import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod-modern';
import { osReferences } from './generated/os-references.js';
import { guidance } from './generated/guidance.js';
export const guidanceIndexUri = 'wishos://guidance/components';
export const guidanceCatalog = {
  format: 'wishos-components/1',
  scope: 'Hub 随包通用指南；具体设备实现另行发现',
  components: guidance.map(({ text, ...record }) => record),
  references: osReferences.map(({ text, ...record }) => record),
};
export function guidanceLinks() {
  return [
    {
      type: 'resource_link' as const,
      uri: guidanceIndexUri,
      name: 'WishOS 组件与使用指南',
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
    { title: 'WishOS 组件与使用指南', mimeType: 'application/json' },
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
        description: '固定版本 OS 参考；实际支持以当前设备元数据为准',
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
        description: `${guide.layer} 层指南；实时 schema 为调用依据`,
      },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide.text }] }),
    );
  server.registerTool(
    'get_guidance',
    {
      description: '读取 WishOS 组件索引或完整分层指南；不支持 MCP 资源浏览的客户端也可用此工具。',
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
      description: '发现系统、驱动和包契约后制作或更新 WishOS 应用。',
      argsSchema: z.object({ device_id: z.string().optional(), task: z.string().optional() }),
    },
    ({ device_id, task }) => ({
      description: 'WishOS 运行时应用制作',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `通过 WishOS MCP 完成任务${device_id ? '，目标设备 ' + JSON.stringify(device_id) : ''}。先读 ${guidanceIndexUri}（或 get_guidance），按需读系统、所选驱动、应用及包指南。发现当前 schema 和预算，交付前真实预检；整文件写入新不可变 revision。原生验证/准入仍是最终依据，编译不能证明任意程序语义。任务：${task ?? '查看设备并确定适当的运行时应用方案。'}`,
          },
        },
      ],
    }),
  );
}
