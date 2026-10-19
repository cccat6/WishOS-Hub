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
import { parseManagedResult } from '../src/actions.js';
import { managedAgentRoute, managedPrompt, managedResultEnvelope } from '../src/os-agent.js';

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

test('managed prompts carry a parser-validated canonical envelope and preserve strict rejection of the real Cube wrong discriminator', () => {
  const wrong =
    '{"version":"wishos-result/2","actions":[{"type":"application","recipient":"origin","data":{"text":"进度测试完成"}}]}';
  assert.throws(() => parseManagedResult(wrong), /managed_result_format/);
  const prompt = managedPrompt('f57a77c702b6c3ef:3');
  assert(prompt.includes(JSON.stringify(managedResultEnvelope)));
  assert(prompt.includes('不是 version'));
  const canonical = parseManagedResult(JSON.stringify(managedResultEnvelope));
  assert.equal(canonical.format, 'wishos-result/2');
  assert.equal(canonical.actions![0].type, 'application');
  assert.throws(
    () =>
      parseManagedResult('{"format":"wishos-result/2","version":"wishos-result/2","actions":[]}'),
    /managed_result_field/,
  );
});

test('shipped checklist discovers input topology before choosing accessible navigation and typography', async () => {
  const checklist = await readFile(
    new URL('../skills/wishos-applications/references/authoring-checklist.md', import.meta.url),
    'utf8',
  );
  for (const fragment of [
    '按钮数量',
    '去抖',
    '触屏',
    '轴',
    'Home',
    '单键',
    '无触屏',
    '可配置扫描',
    '语义角色',
    'verticalAlign',
    'label_vertical_align',
    '对比度',
  ])
    assert(checklist.includes(fragment), fragment);
  assert(authoringInstructions().includes('先读按钮数量'));
});

test('authoring guidance checks real parent bounds and font line boxes and teaches gestures without inventing them', async () => {
  const checklist = await readFile(
    new URL('../skills/wishos-applications/references/authoring-checklist.md', import.meta.url),
    'utf8',
  );
  for (const text of [
    '真实承载卡片',
    '父容器局部坐标',
    '实际渲染边界',
    '内边距',
    '相邻按钮',
    '多行最后一行',
    'line_height 可以大于 fontSize',
    '不能以字号×行数',
    '完整动词',
    '单击 → 双击 → 三击 → 长按',
    '仅列当前需要',
    '完整帮助仍须与当前系统配置',
    '空间不足就分行或分页',
  ])
    assert(checklist.includes(text), text);
  const skill = await readFile(
    new URL('../skills/wishos-applications/SKILL.md', import.meta.url),
    'utf8',
  );
  assert(skill.includes('line_height'));
  assert(skill.includes('真实承载'));
  assert(skill.includes('完整顺序'));
});
