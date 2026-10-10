import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  connectionGrants,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
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

/**
 * Opt-in integration test against a real, pinned Playwright MCP server.
 *
 * It is skipped unless `PAPERCLIP_PLAYWRIGHT_MCP_URL` points at one, because it
 * needs a browser binary and a spawned server that CI does not provide. Start
 * the pinned server the same way the deployment does, plus an explicit
 * executable so the revision is pinned too:
 *
 *   npm pack @playwright/mcp@0.0.83 && npm install ./playwright-mcp-0.0.83.tgz
 *   node node_modules/@playwright/mcp/cli.js \
 *     --headless --isolated --browser chromium \
 *     --executable-path "$HOME/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome" \
 *     --port 8978
 *   PAPERCLIP_PLAYWRIGHT_MCP_URL=http://localhost:8978/mcp \
 *     npx vitest run server/src/__tests__/playwright-mcp-session.integration.test.ts
 */
const playwrightMcpUrl = process.env.PAPERCLIP_PLAYWRIGHT_MCP_URL?.trim();
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIntegration =
  playwrightMcpUrl && embeddedPostgresSupport.supported
    ? describe
    : describe.skip;

const MARKER_PAGE =
  "data:text/html,<h1 id=marker>INT-102 persistent session marker</h1>";
const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_close",
] as const;

describeIntegration("Playwright MCP session continuity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-playwright-mcp-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
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
    await db.delete(agents);
    await db.delete(companies);
  });

  it("keeps one browser context across independent calls and a heartbeat gap", async () => {
    const company = await db
      .insert(companies)
      .values({
        name: `Playwright ${randomUUID()}`,
        issuePrefix: `PW${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Playwright Agent ${randomUUID()}`,
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
        title: "Browser continuity",
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
    const application = await db
      .insert(toolApplications)
      .values({
        companyId: company.id,
        applicationKey: `playwright-${randomUUID().slice(0, 8)}`,
        name: "Playwright MCP",
        type: "mcp_http",
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]!);
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId: company.id,
        applicationId: application.id,
        name: "Playwright MCP",
        uid: `playwright/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        credentialPolicy: "shared",
        config: { url: playwrightMcpUrl, mcpSessionRequired: true },
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: connection.id,
      kind: "organization",
      credentialSecretRefs: [],
      status: "active",
      isDefault: true,
    });
    for (const toolName of BROWSER_TOOLS) {
      await db.insert(toolCatalogEntries).values({
        companyId: company.id,
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

    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "test-tool-action-signing-secret",
    });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const tools = await gateway.listToolsForSession(session.token);
    const toolNamed = (upstream: string) => {
      const tool = tools.find(
        (candidate) => candidate.upstreamToolName === upstream,
      );
      expect(tool, `tool ${upstream} is published`).toBeTruthy();
      return tool!.name;
    };
    const content = (result: { result: unknown }) =>
      String((result.result as { content?: string }).content ?? "");

    await gateway.executeTool({
      sessionToken: session.token,
      tool: toolNamed("browser_navigate"),
      parameters: { url: MARKER_PAGE },
    });
    // Cross the server's ~5s heartbeat boundary between two independent calls.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const snapshot = await gateway.executeTool({
      sessionToken: session.token,
      tool: toolNamed("browser_snapshot"),
      parameters: {},
    });

    expect(content(snapshot)).toContain("INT-102 persistent session marker");

    // An explicit close ends the context; the next call starts a clean one
    // rather than silently inheriting a half-closed browser.
    await gateway.executeTool({
      sessionToken: session.token,
      tool: toolNamed("browser_close"),
      parameters: {},
    });
    const afterClose = await gateway.executeTool({
      sessionToken: session.token,
      tool: toolNamed("browser_snapshot"),
      parameters: {},
    });
    expect(content(afterClose)).not.toContain(
      "INT-102 persistent session marker",
    );

    const lifecycle = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.id))
      .then((rows) =>
        rows.filter((row) => row.eventType === "tool_mcp_session"),
      );
    expect(
      lifecycle.map((row) => (row.payload as { state?: string }).state),
    ).toEqual(["opening", "live", "closed", "opening", "live"]);
  }, 180_000);
});
