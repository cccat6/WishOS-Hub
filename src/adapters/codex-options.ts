/** Add the Notes endpoint without replacing the Harness's user configuration. */
export function codexThreadOptions(
  cwd: string,
  hubUrl: string,
  tokenEnv: string,
  notesSkill: string,
  overrides: Record<string, unknown> = {},
  desktopBridge?: Record<string, unknown>,
  additionalDesktopServers: Record<string, Record<string, unknown>> = {},
) {
  const config = (overrides.config ?? {}) as Record<string, any>;
  const servers = (config.mcp_servers ?? {}) as Record<string, any>;
  const notes = servers.agentic_notes ?? {};
  return {
    ...overrides,
    cwd: overrides.cwd ?? cwd,
    developerInstructions: [
      notesSkill,
      'Use the target device_id from Notes context. Use the Harness existing tools, MCP servers and skills to fulfill the user request; Notes is an input/display terminal, not a tool allowlist. Obtain explicit user authorization before installing, enabling, authenticating or configuring new tools. Keep the Harness approval and permission rules. Verify display receipts. Do not change device power/network policies during hardware bring-up.',
      typeof overrides.developerInstructions === 'string' ? overrides.developerInstructions : '',
    ]
      .filter(Boolean)
      .join('\n'),
    config: {
      ...config,
      mcp_servers: {
        ...servers,
        ...Object.fromEntries(
          Object.entries(additionalDesktopServers).map(([name, server]) => [
            name,
            { ...server, ...(servers[name] ?? {}) },
          ]),
        ),
        ...(desktopBridge
          ? { notes_desktop: { ...desktopBridge, ...(servers.notes_desktop ?? {}) } }
          : {}),
        agentic_notes: {
          url: hubUrl,
          bearer_token_env_var: tokenEnv,
          startup_timeout_sec: 30,
          default_tools_approval_mode: 'approve',
          tool_timeout_sec: 240,
          ...notes,
        },
      },
    },
  };
}
