import { bootRpc, readDeviceFile } from './device-files.js';
import { registerGuidance, guideToolReply, authoringInstructions } from './guidance.js';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod-modern';
import type { HubApi } from './api-types.js';
/** Model-facing integration for the portable resource ABI. No device geometry,
 * palette, application page or physical refresh sequence is defined here. */
export function createWishosMcp(api: HubApi, options = { imagePreparation: true }) {
  const server = new McpServer(
    { name: 'wishos', version: '1.0.0' },
    {
      supportedProtocolVersions: [
        '2026-07-28',
        '2025-11-25',
        '2025-06-18',
        '2025-03-26',
        '2024-11-05',
      ],
      instructions:
        '先读取 wishos://guidance/components 或 get_guidance，按需读 system、drivers、applications、packages 指南和目标组件。发现实时 schema、boot、配置与预算，不从 MCU 推断外设。系统负责执行、渲染、呈现和资源协调；页面、输入含义、导航和调用顺序属于可替换运行时应用，Launcher 与用户应用同层，保留系统独立 home/voice 和声明的恢复入口。应用通过系统 AI 服务调用上游；会话和模型凭据留在用户 Harness。大资源单独 stage，解析/索引/复杂绘图在上游处理。应用安装按声明的 install_providers，普通下载按 transfers 策略和显式配额。托管回复只返回有序 application/system actions，不预先执行；设备拥有顺序、回调、原生完成屏障和清理。变更保留 request_id 与 expected_boot_id，结果不明先查回执，不重放。发现显示配置档及完成模型，不能中断 BUSY。录音为压缩块，无 SD 不隐式写 Flash。' +
        authoringInstructions(),
    },
  );
  registerGuidance(server);
  server.registerTool(
    'get_device_components',
    {
      description:
        '读取当前 boot 的系统、所选驱动/拓扑与初始应用包来源，不挂载存储，不从 MCU 推断外设。',
      inputSchema: z.object({ device_id: z.string(), expected_boot_id: z.string() }),
    },
    async ({ device_id, expected_boot_id }) => {
      const rpc = bootRpc(async (path, method, args) => {
        const reply = await api('/api/os/devices/' + encodeURIComponent(device_id) + '/invoke', {
          path,
          method,
          args,
          expected_boot_id,
        });
        return JSON.parse(reply.content[0]!.text);
      }, expected_boot_id);
      const board = await rpc('/sys/board', 'read', {});
      if (!board.ok) throw Error(board.error);
      const index = board.result.component_index;
      if (index?.format !== 'wishos-components/1' || typeof index.file !== 'string')
        throw Error('component_index_not_advertised');
      const bytes = await readDeviceFile(rpc, index.file, 256 * 1024, AbortSignal.timeout(30000)),
        document = JSON.parse(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
        );
      if (document.format !== index.format || !Array.isArray(document.components))
        throw Error('component_index_format');
      return guideToolReply({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ boot_id: board.boot_id, file: index.file, ...document }),
          },
        ],
      });
    },
  );
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (input: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
    annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean },
  ) {
    server.registerTool(
      name,
      { description, inputSchema: z.object(shape), ...(annotations ? { annotations } : {}) },
      run,
    );
  }
  const invoke = async (
    device: string,
    path: string,
    method: string,
    args: Record<string, unknown>,
    boot?: string,
    requestId?: string,
  ) => {
    const reply = await api(`/api/os/devices/${encodeURIComponent(device)}/invoke`, {
      path,
      method,
      args,
      ...(requestId ? { request_id: requestId } : {}),
      ...(boot ? { expected_boot_id: boot } : {}),
    });
    return { ...reply, isError: JSON.parse(reply.content[0]!.text).ok === false };
  };
  tool(
    'server_capabilities',
    '读取此 MCP 部署的资源限制及上游处理能力；设备能力单独发现。',
    {},
    async () => guideToolReply(await api('/api/service')),
  );
  tool('list_devices', '列出设备及其当前传输状态。', {}, () => api('/api/devices'));
  tool(
    'device_state',
    '读取设备、Harness 和连接状态。',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/state`),
  );
  tool(
    'discover_resources',
    '读取一页实时资源目录；more 为 true 时继续分页，方法详情另行读取。',
    { device_id: z.string(), cursor: z.number().int().min(0).default(0) },
    ({ device_id, cursor }) =>
      invoke(device_id, '/sys/capabilities', 'list', { cursor, limit: 4, details: false }),
  );
  tool(
    'describe_resource',
    '读取所选资源能力、配置和生命周期，不启动资源操作。',
    { device_id: z.string(), path: z.string() },
    async ({ device_id, path }) =>
      guideToolReply(await invoke(device_id, '/sys/capabilities', 'describe', { path })),
  );
  tool(
    'invoke_resource',
    '调用已声明资源。变更传唯一 request_id 和发现所得 expected_boot_id；保留身份查回执，不重放结果不明的写入。异步方法等待声明的 operation 完成，大文件按块传。',
    {
      device_id: z.string(),
      path: z.string().min(1),
      method: z.string().min(1),
      args: z.record(z.string(), z.unknown()).default({}),
      expected_boot_id: z.string().optional(),
      request_id: z
        .string()
        .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
        .optional(),
    },
    ({ device_id, path, method, args, expected_boot_id, request_id }) =>
      invoke(device_id, path, method, args, expected_boot_id, request_id),
  );
  tool(
    'read_operation',
    '读取先前变更的服务器回执，不重复执行；原生受理与物理完成不同，还需检查原生完成资源。',
    { device_id: z.string(), boot_id: z.string(), request_id: z.string() },
    (input) => api('/api/os/receipts/read', input),
  );
  tool(
    'stage_resource',
    '上游获取资源或暂存生成文本。生成二进制可通过已授权的 POST /api/os/artifacts/upload 流式上传，类型 application/octet-stream。返回 job；轮询完成取得 artifact_id，再交付或放入托管结果 files。原始大资源 URL 不交给设备下载。',
    {
      url: z.string().url().optional(),
      text: z.string().optional(),
      limit_bytes: z.number().int().positive().optional(),
      request_id: z.string().optional(),
    },
    ({ request_id, ...input }) => api('/api/os/jobs', { kind: 'stage', input, request_id }),
  );
  tool(
    'read_resource_job',
    '读取处理、传输或包任务结果。检查 result.state 和各阶段 receipts；激活失败仍可能已经安装。结果不明先核对，任务完成不等于物理输出完成。',
    { id: z.string() },
    (input) => api('/api/os/jobs/read', input),
  );
  tool(
    'cancel_resource_job',
    '请求取消上游资源任务，不回滚已提交的设备操作。',
    { id: z.string() },
    (input) => api('/api/os/jobs/cancel', input),
  );
  if (options.imagePreparation)
    tool(
      'prepare_image',
      '用户主机将已有 artifact 按目标几何裁切/缩放，输出 PNG、RGB8 或显式色表索引；屏幕字节编码归适配器，不推断六色或固定尺寸。',
      {
        artifact_id: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        fit: z.enum(['contain', 'cover', 'fill']).optional(),
        background: z.string().optional(),
        format: z.enum(['png', 'rgb8', 'indexed8']).optional(),
        palette: z.array(z.tuple([z.number(), z.number(), z.number()])).optional(),
        request_id: z.string().optional(),
      },
      ({ request_id, ...input }) => api('/api/os/jobs', { kind: 'image', input, request_id }),
    );
  tool(
    'deliver_resources',
    '按目标存储策略分块交付已校验资源；仅完成传输，之后通过资源调用或托管结果使用。调用方负责消费者接管后的回执释放。',
    {
      device_id: z.string(),
      expected_boot_id: z.string(),
      files: z.array(
        z.object({
          path: z.string(),
          artifact_id: z.string(),
          kind: z.enum(['json', 'lua', 'asset']).optional(),
        }),
      ),
      request_id: z.string().optional(),
    },
    ({ request_id, ...input }) => api('/api/os/jobs', { kind: 'deliver', input, request_id }),
  );
  const packageFile = z.object({
    path: z.string(),
    artifact_id: z.string(),
    kind: z.enum(['json', 'lua', 'asset']).optional(),
  });
  const target = { device_id: z.string().optional(), expected_boot_id: z.string().optional() };
  const job = (name: string, kind: string, description: string, shape: z.ZodRawShape) =>
    tool(
      name,
      description,
      { ...shape, request_id: z.string().optional() },
      ({ request_id, ...input }) => api('/api/os/jobs', { kind, input, request_id }),
    );
  job(
    'preflight_bundle',
    'preflight',
    '设备写入前预检完整不可变文件集合；可选目标增加 boot、能力、安装卷和预算检查。只编译不执行 Lua，不预留内存或保证激活。',
    { ...target, files: z.array(packageFile).min(1) },
  );
  job(
    'prepare_package',
    'package_prepare',
    '为完整运行时文件构建排序 SHA-256 inventory/header 并预检，返回 deploy_package 所需 files；不写设备。',
    { ...target, files: z.array(packageFile).min(1), manifest: z.string().default('app.json') },
  );
  job(
    'deploy_package',
    'package_deploy',
    '完整预检后交付、等待原生验证，以匹配票据/catalog revision 安装。激活可选，回执分开；激活失败可能已安装。stop_current_before_transfer 显式启用且须 activate:true，仅在完整检查且无应用切换 pending 时停止当前 VM，停止后复核再传输；不取消切换，后续失败可能保持停止，不自动重启/回滚/重试。轮询 job。',
    {
      device_id: z.string(),
      expected_boot_id: z.string(),
      files: z.array(packageFile).min(1),
      package: z.string().optional(),
      expected_revision: z.number().int().nonnegative().optional(),
      persist: z.boolean().default(true),
      activate: z.boolean().default(false),
      stop_current_before_transfer: z.boolean().default(false),
    },
  );
  job(
    'update_package',
    'package_update',
    '以完整替换文件/显式删除构造安装包的新不可变 revision。读取未变化控制源码做完整预检；大资源在设备复制并校验摘要。不做行补丁或静默合并新基线，用户数据不放 revision 内。安装/激活回执分开，停止当前 VM 仅限显式 stop_current_before_transfer 且 activate:true，停止前后复核应用切换，不取消 pending。',
    {
      device_id: z.string(),
      expected_boot_id: z.string(),
      application_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      replacements: z.array(packageFile),
      delete: z.array(z.string()).default([]),
      persist: z.boolean().default(true),
      activate: z.boolean().default(false),
      stop_current_before_transfer: z.boolean().default(false),
    },
  );
  const sessionReply = async (device_id: string, input: Record<string, unknown>) => {
    const reply = await api(`/api/devices/${encodeURIComponent(device_id)}/sessions`, {
      kind: 'session_control',
      ...input,
    });
    const data = JSON.parse(reply.content[0]!.text);
    if (data.ok && data.selected_session && ['select', 'create'].includes(data.operation)) {
      const select = {
        format: 'wishos-session-control/1',
        operation: 'select',
        ok: true,
        runtime_id: data.runtime_id,
        selected_session: data.selected_session,
        ...(data.session ? { session: data.session } : {}),
      };
      return {
        ...reply,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...data,
              selection_action: {
                type: 'application',
                topic: 'session_control',
                data: select,
                wait: 'processed',
              },
            }),
          },
        ],
      };
    }
    return { ...reply, isError: data.ok === false };
  };
  tool(
    'harness_sessions',
    '读取配置Harness的会话目录/元数据/近期公开消息，select只验证引用，不切设备或全局默认。语音切回旧会话：查询目录、select解析引用，再按用户意图把selection_action放进托管有序结果；应用保存并processed ACK后才确认已切换。只声明实际adapter支持的操作。',
    {
      device_id: z.string(),
      operation: z.enum(['status', 'list', 'select', 'messages']),
      runtime_id: z.string().optional(),
      session_id: z.string().min(1).max(256).optional(),
      session_scope: z.string().max(64).optional(),
      cursor: z.string().max(128).nullable().optional(),
      limit: z.number().int().min(1).max(20).optional(),
      text_max_bytes: z.number().int().min(8).max(1024).optional(),
      operation_id: z.string().max(64).optional(),
    },
    ({ device_id, ...input }) => sessionReply(device_id, input),
    { readOnlyHint: true, idempotentHint: true },
  );
  tool(
    'create_harness_session',
    '用户显式要求新建时创建原生Harness会话，不发送模型任务。operation_id必须稳定保留，未知结果先status对账，不换新ID盲重试。工具本身不切设备；按用户意图有序返回selection_action。',
    {
      device_id: z.string(),
      operation_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
      runtime_id: z.string().optional(),
      session_scope: z.string().max(64).optional(),
    },
    ({ device_id, ...input }) => sessionReply(device_id, { ...input, operation: 'create' }),
    { readOnlyHint: false, idempotentHint: true },
  );
  tool(
    'harness_usage',
    '读取绑定 Harness 提供的真实用量；以适配器能力为准。',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/usage`),
  );
  tool(
    'harness_tools',
    '读取绑定 Harness 会话可用工具。',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/tools`),
  );
  return server;
}
