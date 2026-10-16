import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createWishosMcp } from '../src/wishos-mcp.js';
import { authoringInstructions } from '../src/guidance.js';
import { ArtifactStore } from '../src/os-artifacts.js';
import { managedAgentRoute } from '../src/os-agent.js';

test('authoring and modification discover the same shipped checklist through prompts or tools without resource browsing', async () => {
  const calls: string[] = [];
  const server = createWishosMcp(async (path) => {
    calls.push(path);
    return { content: [{ type: 'text', text: '{}' }] };
  });
  const client = new Client({ name: 'tool-only-author', version: '1' });
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(transport), client.connect(peer)]);
    assert(client.getInstructions()?.includes(authoringInstructions()));
    // This client deliberately never lists or reads MCP resources or a local Skill.
    const index: any = await client.callTool({ name: 'get_guidance', arguments: {} });
    const catalog = JSON.parse(index.content[0].text);
    assert.deepEqual(catalog.authoring.applies_to, ['create', 'modify']);
    assert.equal(catalog.authoring.instructions, authoringInstructions());
    const entry = catalog.references.find((r: any) => r.id === catalog.authoring.component_id);
    assert.equal(entry.uri, catalog.authoring.uri);
    const fallback: any = await client.callTool({
      name: 'get_guidance',
      arguments: { component_id: entry.id },
    });
    assert(!fallback.isError);
    const checklist = fallback.content[0].resource;
    assert.equal(checklist.uri, entry.uri);
    const source = await readFile(new URL('../' + entry.source.path, import.meta.url), 'utf8');
    assert.equal(checklist.text, source);
    assert.equal(createHash('sha256').update(checklist.text).digest('hex'), entry.sha256);
    const skill: any = await client.callTool({
      name: 'get_guidance',
      arguments: { component_id: 'wishos-applications' },
    });
    assert(skill.content[0].resource.text.includes(entry.id));
    for (const task of ['制作一个离线倒计时应用', '修改现有应用，让时钟持续跟随系统时间']) {
      const prompt = await client.getPrompt({
        name: 'wishos-authoring',
        arguments: { device_id: 'device', task },
      });
      const content = prompt.messages[0].content as any;
      assert(content.text.includes(task));
      assert(content.text.includes(authoringInstructions()));
    }
    // Tool discovery fallback carries the entry even if prompts are not supported.
    const described: any = await client.callTool({ name: 'server_capabilities', arguments: {} });
    assert(
      described.content.some((c: any) => c.type === 'text' && c.text === authoringInstructions()),
    );
    assert.deepEqual(calls, ['/api/service']); // Guidance has no target side effects.
    const resource = await client.readResource({ uri: entry.uri });
    assert.equal((resource.contents[0] as any).text, source);
  } finally {
    await client.close();
    await server.close();
  }
});

test('each managed text request carries authoring review and keeps application result delivery separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wishos-authoring-'));
  const db = new DatabaseSync(':memory:');
  const inputs: string[] = [],
    methods: string[] = [];
  const tasks = ['创建一个本地时钟', '修改时钟的字号及更新频率'];
  try {
    const route = managedAgentRoute({
      artifacts: new ArtifactStore(db, root),
      rpc: async (path, method) => {
        methods.push(path + ':' + method);
        return {
          ok: true,
          boot_id: 'boot',
          result:
            path === '/sys/capabilities'
              ? {
                  result_format: 'wishos-result/2',
                  action_limit_bytes: 2048,
                  inline_result_limit_bytes: 4096,
                }
              : {},
        };
      },
      start: (request, text) => {
        inputs.push(text);
        return { id: request.request_id };
      },
      status: () => ({ status: 'completed', result: 'fixture reply' }),
    });
    for (const [n, text] of tasks.entries()) {
      const result: any = await route(
        {
          id: n + 1,
          request_id: 'author-' + n,
          route: 'wishos.ai',
          payload: { format: 'wishos-ai/2', input: { text, page: 'clock' } },
        },
        new AbortController().signal,
      );
      assert.equal(result.actions[0].type, 'application');
      assert.equal(result.actions[0].data.text, 'fixture reply');
      assert(inputs[n].includes(authoringInstructions()));
      assert(inputs[n].includes('"page":"clock"'));
      assert(inputs[n].endsWith(text));
    }
    assert.equal(inputs.length, tasks.length);
    assert(methods.every((m) => ['/sys/board:read', '/sys/capabilities:describe'].includes(m)));
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
