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
  const counts = { initialize: 0, ping: 0, delete: 0, toolCall: 0 };
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
  }

  return {
    handler,
    counts,
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
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function gatewayFor(
    server: ReturnType<typeof createFakeStatefulMcpServer>,
  ) {
    return createToolGatewayService(db, {
      toolActionSigningSecret: "test-tool-action-signing-secret",
      remoteHttpRequest: server.handler,
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
    const gateway = await gatewayFor(server);
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
  });
});
