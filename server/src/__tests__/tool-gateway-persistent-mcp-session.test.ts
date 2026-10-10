import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  connectionGrants,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
  toolAccessAuditEvents,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolGatewaySessions,
  toolInvocations,
  toolPolicies,
} from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

/**
 * A fake stateful MCP server over Streamable HTTP.
 *
 * It behaves like Playwright MCP in `--isolated` mode: state lives on the
 * session, a request without a known session id is a 404, and every
 * `initialize` starts a new generation with empty state. That is what lets
 * these tests tell "the session was reused" apart from "a blank context was
 * silently created".
 */
function createFakeStatefulMcpServer() {
  const sessions = new Map<string, { markers: Map<string, string> }>();
  const dispatchOrder: string[] = [];
  const counts = { initialize: 0, ping: 0, delete: 0, toolCall: 0, discovery: 0 };
  const concurrency = { inFlight: 0, max: 0 };
  let dropSessions = false;

  function jsonResponse(
    payload: unknown,
    extraHeaders: Record<string, string> = {},
    status = 200,
  ) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...extraHeaders },
    });
  }

  function textResult(id: unknown, text: string) {
    return jsonResponse({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }] },
    });
  }

  async function handler(_url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers as HeadersInit);
    const sessionId = headers.get("mcp-session-id");
    if ((init.method ?? "GET").toUpperCase() === "DELETE") {
      counts.delete += 1;
      if (sessionId) sessions.delete(sessionId);
      return new Response(null, { status: 204 });
    }
    const message = JSON.parse(String(init.body)) as {
      id?: unknown;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (message.method === "initialize") {
      counts.initialize += 1;
      const id = `fake-session-${counts.initialize}`;
      sessions.set(id, { markers: new Map() });
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-stateful", version: "1" },
          },
        },
        { "mcp-session-id": id },
      );
    }
    if (message.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (
      message.method?.startsWith("resources/") ||
      message.method?.startsWith("prompts/")
    ) {
      // Discovery keeps its own short-lived transport and carries no session.
      counts.discovery += 1;
      return jsonResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: { resources: [], prompts: [] },
      });
    }
    const state = sessionId ? sessions.get(sessionId) : undefined;
    if (!state || dropSessions) {
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32001, message: "Session not found" },
        },
        {},
        404,
      );
    }
    if (message.method === "ping") {
      counts.ping += 1;
      return jsonResponse({ jsonrpc: "2.0", id: message.id, result: {} });
    }
    if (message.method !== "tools/call") {
      return jsonResponse({ jsonrpc: "2.0", id: message.id, result: {} });
    }
    counts.toolCall += 1;
    const name = message.params?.name ?? "";
    const args = message.params?.arguments ?? {};
    concurrency.inFlight += 1;
    concurrency.max = Math.max(concurrency.max, concurrency.inFlight);
    try {
      if (typeof args.delayMs === "number") {
        await new Promise((resolve) => setTimeout(resolve, args.delayMs));
      }
      dispatchOrder.push(
        typeof args.label === "string" ? args.label : String(name),
      );
      if (name === "set_marker") {
        state.markers.set("marker", String(args.value ?? ""));
        return textResult(message.id, `set ${String(args.value ?? "")}`);
      }
      if (name === "read_marker") {
        return textResult(message.id, state.markers.get("marker") ?? "missing");
      }
      return textResult(message.id, "ok");
    } finally {
      concurrency.inFlight -= 1;
    }
  }

  return {
    handler,
    counts,
    concurrency,
    dispatchOrder,
    sessionIds: () => [...sessions.keys()],
    dropSessions: (value: boolean) => {
      dropSessions = value;
    },
  };
}

const MARKER_TOOLS = ["set_marker", "read_marker", "browser_close"] as const;

async function createStatefulConnectionFixture(
  db: ReturnType<typeof createDb>,
  companyId: string,
) {
  const application = await db
    .insert(toolApplications)
    .values({
      companyId,
      applicationKey: `stateful-${randomUUID().slice(0, 8)}`,
      name: "Stateful MCP",
      type: "mcp_http",
      status: "active",
    })
    .returning()
    .then((rows) => rows[0]!);
  const connection = await db
    .insert(toolConnections)
    .values({
      companyId,
      applicationId: application.id,
      name: "Stateful connection",
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      credentialPolicy: "shared",
      // A public IP literal keeps the egress guard in play without DNS.
      config: { url: "https://8.8.8.8/mcp", mcpSessionRequired: true },
    })
    .returning()
    .then((rows) => rows[0]!);
  const grant = await db
    .insert(connectionGrants)
    .values({
      companyId,
      connectionId: connection.id,
      kind: "organization",
      credentialSecretRefs: [],
      status: "active",
      isDefault: true,
    })
    .returning()
    .then((rows) => rows[0]!);
  for (const toolName of MARKER_TOOLS) {
    await db.insert(toolCatalogEntries).values({
      companyId,
      applicationId: application.id,
      connectionId: connection.id,
      entryKind: "tool",
      name: toolName,
      toolName,
      title: toolName,
      riskLevel: "read",
      isReadOnly: true,
      status: "active",
      versionHash: randomUUID(),
      schemaHash: randomUUID(),
    });
  }
  return { application, connection, grant };
}

async function createRunScopeFixture(db: ReturnType<typeof createDb>) {
  const company = await db
    .insert(companies)
    .values({
      name: `Gateway ${randomUUID()}`,
      issuePrefix: `TG${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const agent = await db
    .insert(agents)
    .values({
      companyId: company.id,
      name: `Gateway Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })
    .returning()
    .then((rows) => rows[0]!);
  const issue = await db
    .insert(issues)
    .values({
      companyId: company.id,
      title: "Browser work",
      status: "in_progress",
      assigneeAgentId: agent.id,
    })
    .returning()
    .then((rows) => rows[0]!);
  const run = await db
    .insert(heartbeatRuns)
    .values({
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: issue.id },
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(toolPolicies).values({
    companyId: company.id,
    name: "Allow read tools",
    policyType: "allow",
    selectors: { riskLevel: "read" },
  });
  const connection = await createStatefulConnectionFixture(db, company.id);
  return { company, agent, issue, run, ...connection };
}

describeEmbeddedPostgres("persistent stateful MCP sessions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-session-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(toolGatewaySessions);
    await db.delete(toolCallEvents);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolInvocations);
    await db.delete(toolCatalogEntries);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(toolPolicies);
    await db.delete(heartbeatRunEvents);
    // Audit writes can still be settling when a test returns; clear their
    // references again so the run rows can go.
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  function gatewayFor(
    server: ReturnType<typeof createFakeStatefulMcpServer>,
    overrides: Parameters<typeof createToolGatewayService>[1] = {},
  ) {
    return createToolGatewayService(db, {
      toolActionSigningSecret: "test-tool-action-signing-secret",
      remoteHttpRequest: server.handler,
      // Probing is exercised in the registry unit tests; keep these
      // database-backed tests free of background traffic.
      persistentMcpSessions: { keepAliveIntervalMs: 0 },
      ...overrides,
    });
  }

  async function toolName(
    gateway: ReturnType<typeof createToolGatewayService>,
    sessionToken: string,
    upstreamToolName: string,
  ) {
    const tools = await gateway.listToolsForSession(sessionToken);
    const tool = tools.find(
      (candidate) => candidate.upstreamToolName === upstreamToolName,
    );
    expect(tool, `tool ${upstreamToolName} is published`).toBeTruthy();
    return tool!.name;
  }

  it("keeps one session across independent calls in the same run", async () => {
    const { company, agent, run } = await createRunScopeFixture(db);
    const server = createFakeStatefulMcpServer();
    const gateway = gatewayFor(server);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const setMarker = await toolName(gateway, session.token, "set_marker");
    const readMarker = await toolName(gateway, session.token, "read_marker");

    await gateway.executeTool({
      sessionToken: session.token,
      tool: setMarker,
      parameters: { value: "tab-1" },
    });
    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: readMarker,
      parameters: {},
    });
    const second = await gateway.executeTool({
      sessionToken: session.token,
      tool: readMarker,
      parameters: {},
    });

    expect(server.counts.initialize).toBe(1);
    expect(server.sessionIds()).toHaveLength(1);
    expect((first.result as { content?: string }).content).toBe("tab-1");
    expect((second.result as { content?: string }).content).toBe("tab-1");
  }, 120_000);

  it("initializes once for concurrent first calls and keeps them ordered", async () => {
    const { company, agent, run } = await createRunScopeFixture(db);
    const server = createFakeStatefulMcpServer();
    const gateway = gatewayFor(server);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const readMarker = await toolName(gateway, session.token, "read_marker");

    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        gateway.executeTool({
          sessionToken: session.token,
          tool: readMarker,
          parameters: { label: `call-${index}`, delayMs: 10 - index },
        }),
      ),
    );

    // One session for ten concurrent first calls, and never two operations in
    // flight on it. (Arrival-order dispatch is covered by the registry unit
    // tests, where calls reach the registry in a defined order.)
    expect(server.counts.initialize).toBe(1);
    expect(server.counts.toolCall).toBe(10);
    expect(server.concurrency.max).toBe(1);
    expect(new Set(server.dispatchOrder).size).toBe(10);
  }, 120_000);

  it("never shares a session between runs, agents, companies or connections", async () => {
    const first = await createRunScopeFixture(db);
    const second = await createRunScopeFixture(db);
    const secondRunSameAgent = await db
      .insert(heartbeatRuns)
      .values({
        companyId: first.company.id,
        agentId: first.agent.id,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: { issueId: first.issue.id },
      })
      .returning()
      .then((rows) => rows[0]!);
    const server = createFakeStatefulMcpServer();
    const gateway = gatewayFor(server);

    const sessionA = await gateway.createSession({
      companyId: first.company.id,
      agentId: first.agent.id,
      runId: first.run.id,
    });
    const sessionB = await gateway.createSession({
      companyId: first.company.id,
      agentId: first.agent.id,
      runId: secondRunSameAgent.id,
    });
    const sessionC = await gateway.createSession({
      companyId: second.company.id,
      agentId: second.agent.id,
      runId: second.run.id,
    });
    await gateway.executeTool({
      sessionToken: sessionA.token,
      tool: await toolName(gateway, sessionA.token, "set_marker"),
      parameters: { value: "only-run-a" },
    });
    const otherRun = await gateway.executeTool({
      sessionToken: sessionB.token,
      tool: await toolName(gateway, sessionB.token, "read_marker"),
      parameters: {},
    });
    const otherCompany = await gateway.executeTool({
      sessionToken: sessionC.token,
      tool: await toolName(gateway, sessionC.token, "read_marker"),
      parameters: {},
    });

    // A different run, agent, company, connection or grant is a different
    // scope: it gets its own session and can never read the first one's state.
    expect((otherRun.result as { content?: string }).content).toBe("missing");
    expect((otherCompany.result as { content?: string }).content).toBe(
      "missing",
    );
    expect(server.counts.initialize).toBe(3);
    expect(gateway.describePersistentMcpSessions()).toHaveLength(3);
  }, 120_000);

  it("reports an upstream 404 as a lost session and rebuilds on the next call", async () => {
    const { company, agent, run } = await createRunScopeFixture(db);
    const server = createFakeStatefulMcpServer();
    const gateway = gatewayFor(server);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const readMarker = await toolName(gateway, session.token, "read_marker");
    await gateway.executeTool({
      sessionToken: session.token,
      tool: readMarker,
      parameters: {},
    });

    server.dropSessions(true);
    await expect(
      gateway.executeTool({
        sessionToken: session.token,
        tool: readMarker,
        parameters: {},
      }),
    ).rejects.toMatchObject({
      reasonCode: "mcp_session_lost",
      details: { reason: "upstream_session_expired" },
    });

    server.dropSessions(false);
    await gateway.executeTool({
      sessionToken: session.token,
      tool: readMarker,
      parameters: {},
    });
    expect(server.counts.initialize).toBe(2);
  }, 120_000);

  it("reports a restart of the owning server instead of a blank session", async () => {
    const { company, agent, run } = await createRunScopeFixture(db);
    const server = createFakeStatefulMcpServer();
    const before = gatewayFor(server, {
      persistentMcpSessions: {
        keepAliveIntervalMs: 0,
        ownerInstanceId: "worker-a",
        ownerBootId: "boot-1",
      },
    });
    const session = await before.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const setMarker = await toolName(before, session.token, "set_marker");
    const readMarker = await toolName(before, session.token, "read_marker");
    await before.executeTool({
      sessionToken: session.token,
      tool: setMarker,
      parameters: { value: "before-restart" },
    });

    const afterRestart = gatewayFor(server, {
      persistentMcpSessions: {
        keepAliveIntervalMs: 0,
        ownerInstanceId: "worker-a",
        ownerBootId: "boot-2",
      },
    });
    await expect(
      afterRestart.executeTool({
        sessionToken: session.token,
        tool: readMarker,
        parameters: {},
      }),
    ).rejects.toMatchObject({
      reasonCode: "mcp_session_lost",
      details: { reason: "server_restart" },
    });
    expect(server.counts.initialize).toBe(1);

    const rebuilt = await afterRestart.executeTool({
      sessionToken: session.token,
      tool: readMarker,
      parameters: {},
    });
    expect((rebuilt.result as { content?: string }).content).toBe("missing");
    expect(server.counts.initialize).toBe(2);
  }, 120_000);

  it("fails closed when a different worker owns the run's session", async () => {
    const { company, agent, run } = await createRunScopeFixture(db);
    const server = createFakeStatefulMcpServer();
    const workerA = gatewayFor(server, {
      persistentMcpSessions: {
        keepAliveIntervalMs: 0,
        ownerInstanceId: "worker-a",
        ownerBootId: "boot-a",
      },
    });
    const session = await workerA.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const readMarker = await toolName(workerA, session.token, "read_marker");
    await workerA.executeTool({
      sessionToken: session.token,
      tool: readMarker,
      parameters: {},
    });

    const workerB = gatewayFor(server, {
      persistentMcpSessions: {
        keepAliveIntervalMs: 0,
        ownerInstanceId: "worker-b",
        ownerBootId: "boot-b",
      },
    });
    await expect(
      workerB.executeTool({
        sessionToken: session.token,
        tool: readMarker,
        parameters: {},
      }),
    ).rejects.toMatchObject({
      reasonCode: "mcp_session_lost",
      details: { reason: "owner_lost" },
    });
    expect(server.counts.initialize).toBe(1);
  }, 120_000);

  it("closes the session once when the agent closes the browser", async () => {
    const { company, agent, run } = await createRunScopeFixture(db);
    const server = createFakeStatefulMcpServer();
    const gateway = gatewayFor(server);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    await gateway.executeTool({
      sessionToken: session.token,
      tool: await toolName(gateway, session.token, "set_marker"),
      parameters: { value: "tab-1" },
    });
    await gateway.executeTool({
      sessionToken: session.token,
      tool: await toolName(gateway, session.token, "browser_close"),
      parameters: {},
    });

    expect(server.counts.delete).toBe(1);
    expect(gateway.describePersistentMcpSessions()).toEqual([]);

    const afterClose = await gateway.executeTool({
      sessionToken: session.token,
      tool: await toolName(gateway, session.token, "read_marker"),
      parameters: {},
    });
    expect((afterClose.result as { content?: string }).content).toBe("missing");
    expect(server.counts.initialize).toBe(2);
    expect(server.counts.delete).toBe(1);
  }, 120_000);

  it("records a shutdown so the next process does not inherit the session", async () => {
    const { company, agent, run } = await createRunScopeFixture(db);
    const server = createFakeStatefulMcpServer();
    const gateway = gatewayFor(server);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const readMarker = await toolName(gateway, session.token, "read_marker");
    await gateway.executeTool({
      sessionToken: session.token,
      tool: readMarker,
      parameters: {},
    });

    await gateway.shutdownPersistentMcpSessions();

    expect(server.counts.delete).toBe(1);
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.id));
    expect(events.at(-1)?.payload).toMatchObject({
      state: "closed",
      reason: "shutdown",
    });
  }, 120_000);

  it("keeps tool discovery away from the execution session", async () => {
    const { company, agent, run } = await createRunScopeFixture(db);
    const server = createFakeStatefulMcpServer();
    const gateway = gatewayFor(server);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const setMarker = await toolName(gateway, session.token, "set_marker");
    await gateway.executeTool({
      sessionToken: session.token,
      tool: setMarker,
      parameters: { value: "tab-1" },
    });

    // Discovery must not adopt, refresh, or tear down the execution session.
    // Remote context discovery (`resources/*`, `prompts/*`) goes through
    // `callRemoteConnectionProtocol`, a one-shot request that never consults
    // the session registry.
    await gateway.listToolsForSession(session.token);
    const afterDiscovery = await gateway.executeTool({
      sessionToken: session.token,
      tool: await toolName(gateway, session.token, "read_marker"),
      parameters: {},
    });

    expect((afterDiscovery.result as { content?: string }).content).toBe(
      "tab-1",
    );
    expect(server.counts.initialize).toBe(1);
    expect(server.counts.delete).toBe(0);
  }, 120_000);

  it("logs only non-reversible session diagnostics on the run log", async () => {
    const { company, agent, run } = await createRunScopeFixture(db);
    const server = createFakeStatefulMcpServer();
    const gateway = gatewayFor(server);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const readMarker = await toolName(gateway, session.token, "read_marker");
    await gateway.executeTool({
      sessionToken: session.token,
      tool: readMarker,
      parameters: {},
    });

    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.id));
    const lifecycle = events.filter(
      (event) => event.eventType === "tool_mcp_session",
    );
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle.at(-1)?.payload).toMatchObject({
      state: "live",
      generation: 1,
    });
    const serialized = JSON.stringify(lifecycle.map((event) => event.payload));
    for (const secret of [...server.sessionIds(), run.id, company.id]) {
      expect(serialized).not.toContain(secret);
    }
    expect(
      Object.keys(lifecycle.at(-1)?.payload ?? {}).sort(),
    ).toEqual([
      "absoluteExpiresAt",
      "eventAt",
      "fingerprintHmac",
      "generation",
      "idleExpiresAt",
      "ownerBootId",
      "ownerInstanceId",
      "reason",
      "scopeHmac",
      "state",
    ]);
  }, 120_000);

  it("leaves a stateless connection on the previous per-call behaviour", async () => {
    const { company, agent, run, connection } = await createRunScopeFixture(db);
    await db
      .update(toolConnections)
      .set({ config: { url: "https://8.8.8.8/mcp" } })
      .where(eq(toolConnections.id, connection.id));
    const server = createFakeStatefulMcpServer();
    const gateway = gatewayFor(server);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const readMarker = await toolName(gateway, session.token, "read_marker");

    // A stateless server needs no session, so the gateway must not negotiate
    // one, keep one alive, or write a lifecycle record for it.
    await expect(
      gateway.executeTool({
        sessionToken: session.token,
        tool: readMarker,
        parameters: {},
      }),
    ).rejects.toMatchObject({ reasonCode: "mcp_remote_status" });
    expect(server.counts.initialize).toBe(0);
    expect(gateway.describePersistentMcpSessions()).toEqual([]);
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.id));
    expect(
      events.filter((event) => event.eventType === "tool_mcp_session"),
    ).toHaveLength(0);
  }, 120_000);
});
