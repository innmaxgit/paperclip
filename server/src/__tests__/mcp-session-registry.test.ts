import { describe, expect, it } from "vitest";
import {
  createPersistentMcpSessionRegistry,
  McpSessionLostError,
  type McpHttpSessionIdentity,
  type McpSessionLifecycleRecord,
  type McpSessionLifecyclePort,
  type McpPersistentSessionRegistryOptions,
} from "../services/mcp-http.js";

const SCOPE = {
  companyId: "company-1",
  runId: "run-1",
  agentId: "agent-1",
};

/**
 * In-memory stand-in for the run-log lifecycle port. `decide` runs against the
 * scope's latest record and its append lands before the next call can read it,
 * which is the atomicity the real port gets from the run row lock.
 */
function createMemoryLifecycle() {
  const records: McpSessionLifecycleRecord[] = [];
  let runActive = true;
  const port: McpSessionLifecyclePort = {
    async transition(input) {
      const latest =
        [...records]
          .reverse()
          .find((record) => record.scopeHmac === input.scopeHmac) ?? null;
      const decision = input.decide({ latest, runActive });
      if (decision.kind === "append") records.push(decision.record);
    },
  };
  return {
    port,
    records,
    endRun() {
      runActive = false;
    },
    states: () => records.map((record) => `${record.state}:${record.reason}`),
  };
}

function createClock(startMs = 1_700_000_000_000) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

interface FakeUpstream {
  open: () => Promise<McpHttpSessionIdentity>;
  counts: { open: number; close: number; ping: number };
  failPing: (value: boolean) => void;
  closeSession: (identity: McpHttpSessionIdentity) => Promise<void>;
  ping: (identity: McpHttpSessionIdentity) => Promise<void>;
}

function createFakeUpstream(): FakeUpstream {
  const counts = { open: 0, close: 0, ping: 0 };
  let failPing = false;
  return {
    counts,
    failPing: (value: boolean) => {
      failPing = value;
    },
    open: async () => {
      counts.open += 1;
      return {
        protocolVersion: "2025-06-18",
        sessionId: `upstream-session-${counts.open}`,
      };
    },
    closeSession: async () => {
      counts.close += 1;
    },
    ping: async () => {
      counts.ping += 1;
      if (failPing) throw new Error("ping failed");
    },
  };
}

function registryFor(
  lifecycle: McpSessionLifecyclePort,
  overrides: Partial<McpPersistentSessionRegistryOptions> = {},
) {
  return createPersistentMcpSessionRegistry({
    lifecycle,
    scopeKey: "test-scope-key",
    ownerInstanceId: "worker-a",
    ownerBootId: "boot-1",
    keepAliveIntervalMs: 0,
    ...overrides,
  });
}

type CallOptions = {
  scopeParts?: Array<[string, string | null]>;
  authorizationParts?: Array<[string, string | null]>;
  configurationParts?: Array<[string, string | null]>;
  authorizationExpiresAt?: Date | null;
  expired?: boolean;
  close?: boolean;
  scope?: typeof SCOPE;
};

function callThrough(
  registry: ReturnType<typeof registryFor>,
  upstream: FakeUpstream,
  label: string,
  options: CallOptions = {},
) {
  return registry.withSession<string>({
    scope: {
      ...(options.scope ?? SCOPE),
      parts: options.scopeParts ?? [["connectionId", "connection-1"]],
    },
    authorizationParts: options.authorizationParts ?? [
      ["grantStatus", "active"],
    ],
    configurationParts: options.configurationParts ?? [
      ["endpoint", "https://mcp.invalid/mcp"],
    ],
    authorizationExpiresAt: options.authorizationExpiresAt ?? null,
    open: upstream.open,
    closeSession: upstream.closeSession,
    ping: upstream.ping,
    dispatch: async (identity) => {
      if (options.expired) return { outcome: "session_expired" };
      return {
        outcome: "ok",
        value: `${label}@${identity.sessionId}`,
        closeSession: options.close,
      };
    },
  });
}

async function expectSessionLost(
  promise: Promise<unknown>,
  reason: string,
): Promise<McpSessionLostError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(McpSessionLostError);
  expect((error as McpSessionLostError).reason).toBe(reason);
  return error as McpSessionLostError;
}

describe("persistent MCP session registry", () => {
  it("opens once per scope and reuses the session for later calls", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port);

    const results = [
      await callThrough(registry, upstream, "first"),
      await callThrough(registry, upstream, "second"),
      await callThrough(registry, upstream, "third"),
    ];

    expect(upstream.counts.open).toBe(1);
    expect(results).toEqual([
      "first@upstream-session-1",
      "second@upstream-session-1",
      "third@upstream-session-1",
    ]);
    expect(lifecycle.states()).toEqual([
      "opening:established",
      "live:opened",
    ]);
  });

  it("opens once for ten concurrent first calls and dispatches them in order", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port);
    const dispatched: string[] = [];

    const calls = Array.from({ length: 10 }, (_unused, index) =>
      registry.withSession<number>({
        scope: { ...SCOPE, parts: [["connectionId", "connection-1"]] },
        authorizationParts: [["grantStatus", "active"]],
        configurationParts: [["endpoint", "https://mcp.invalid/mcp"]],
        open: upstream.open,
        dispatch: async () => {
          // A later call finishing first would show up as an out-of-order
          // entry here, which a stateful browser session cannot tolerate.
          await new Promise((resolve) =>
            setTimeout(resolve, 10 - index),
          );
          dispatched.push(`call-${index}`);
          return { outcome: "ok", value: index };
        },
      }),
    );
    await Promise.all(calls);

    expect(upstream.counts.open).toBe(1);
    expect(dispatched).toEqual(
      Array.from({ length: 10 }, (_unused, index) => `call-${index}`),
    );
  });

  it("keeps separate sessions for different scopes", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port);

    const variants: CallOptions[] = [
      {},
      { scope: { ...SCOPE, runId: "run-2" } },
      { scope: { ...SCOPE, agentId: "agent-2" } },
      { scope: { ...SCOPE, companyId: "company-2" } },
      { scopeParts: [["connectionId", "connection-2"]] },
      {
        scopeParts: [
          ["connectionId", "connection-1"],
          ["grantId", "grant-2"],
        ],
      },
      {
        scopeParts: [
          ["connectionId", "connection-1"],
          ["responsibleUserId", "user-2"],
        ],
      },
      {
        scopeParts: [
          ["connectionId", "connection-1"],
          ["issueId", "issue-2"],
        ],
      },
      {
        scopeParts: [
          ["connectionId", "connection-1"],
          ["projectId", "project-2"],
        ],
      },
      {
        scopeParts: [
          ["connectionId", "connection-1"],
          ["gatewayProfileId", "profile-2"],
        ],
      },
    ];
    for (const variant of variants) {
      await callThrough(registry, upstream, "call", variant);
    }

    expect(upstream.counts.open).toBe(variants.length);
    expect(new Set(registry.describe().map((entry) => entry.scopeHmac)).size)
      .toBe(variants.length);
  });

  it("reports an authorization rotation and only rebuilds afterwards", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port);
    await callThrough(registry, upstream, "first");

    const rotated: CallOptions = {
      authorizationParts: [
        ["grantStatus", "active"],
        ["credentials", "rotated"],
      ],
    };
    await expectSessionLost(
      callThrough(registry, upstream, "second", rotated),
      "authorization_changed",
    );
    const rebuilt = await callThrough(registry, upstream, "third", rotated);

    expect(rebuilt).toBe("third@upstream-session-2");
    expect(upstream.counts.open).toBe(2);
    expect(upstream.counts.close).toBe(1);
    expect(lifecycle.records.at(-1)).toMatchObject({
      state: "live",
      generation: 2,
    });
  });

  it("reports a configuration rotation", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port);
    await callThrough(registry, upstream, "first");

    await expectSessionLost(
      callThrough(registry, upstream, "second", {
        configurationParts: [["endpoint", "https://other.invalid/mcp"]],
      }),
      "config_changed",
    );
  });

  it("expires an idle session and reports it before rebuilding", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const clock = createClock();
    const registry = registryFor(lifecycle.port, {
      now: clock.now,
      idleTtlMs: 60_000,
      absoluteTtlMs: 600_000,
    });
    await callThrough(registry, upstream, "first");

    clock.advance(60_001);
    await expectSessionLost(
      callThrough(registry, upstream, "second"),
      "idle_timeout",
    );
    await callThrough(registry, upstream, "third");

    expect(upstream.counts.open).toBe(2);
  });

  it("expires a session at the absolute bound even while in use", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const clock = createClock();
    const registry = registryFor(lifecycle.port, {
      now: clock.now,
      idleTtlMs: 60_000,
      absoluteTtlMs: 120_000,
    });
    await callThrough(registry, upstream, "first");
    clock.advance(59_000);
    await callThrough(registry, upstream, "second");
    clock.advance(59_000);
    await callThrough(registry, upstream, "third");

    clock.advance(10_000);
    await expectSessionLost(
      callThrough(registry, upstream, "fourth"),
      "absolute_timeout",
    );
  });

  it("expires a session when its authorization window closes first", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const clock = createClock();
    const registry = registryFor(lifecycle.port, {
      now: clock.now,
      idleTtlMs: 900_000,
      absoluteTtlMs: 3_600_000,
    });
    const authorizationExpiresAt = new Date(clock.now() + 30_000);
    await callThrough(registry, upstream, "first", { authorizationExpiresAt });

    clock.advance(30_001);
    await expectSessionLost(
      callThrough(registry, upstream, "second", { authorizationExpiresAt }),
      "authorization_expired",
    );
  });

  it("probes a live session without extending its idle deadline", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const clock = createClock();
    const registry = registryFor(lifecycle.port, {
      now: clock.now,
      idleTtlMs: 60_000,
      absoluteTtlMs: 600_000,
      keepAliveIntervalMs: 5,
    });
    await callThrough(registry, upstream, "first");

    // Well past the server's ~5s heartbeat boundary: the session survives the
    // gap and stays usable, and the probes do not count as caller activity.
    clock.advance(6_000);
    await waitFor(() => upstream.counts.ping >= 2);
    const second = await callThrough(registry, upstream, "second");
    expect(second).toBe("second@upstream-session-1");
    expect(upstream.counts.open).toBe(1);

    clock.advance(60_001);
    await waitFor(() => registry.describe().length === 0);
    await expectSessionLost(
      callThrough(registry, upstream, "third"),
      "idle_timeout",
    );
  });

  it("reports a failed probe instead of handing over a fresh session", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port, { keepAliveIntervalMs: 5 });
    await callThrough(registry, upstream, "first");
    upstream.failPing(true);

    await waitFor(() => registry.describe().length === 0);
    await expectSessionLost(
      callThrough(registry, upstream, "second"),
      "heartbeat_failed",
    );
    upstream.failPing(false);
    expect(await callThrough(registry, upstream, "third")).toBe(
      "third@upstream-session-2",
    );
  });

  it("reports an upstream 404 without replaying the call", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port);
    await callThrough(registry, upstream, "first");

    await expectSessionLost(
      callThrough(registry, upstream, "second", { expired: true }),
      "upstream_session_expired",
    );

    // The tool was dispatched exactly once and never retried on a new session.
    expect(upstream.counts.open).toBe(1);
    expect(upstream.counts.close).toBe(1);
  });

  it("reports a server restart and rebuilds only on the next call", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const before = registryFor(lifecycle.port);
    await callThrough(before, upstream, "first");

    const afterRestart = registryFor(lifecycle.port, { ownerBootId: "boot-2" });
    await expectSessionLost(
      callThrough(afterRestart, upstream, "second"),
      "server_restart",
    );
    expect(upstream.counts.open).toBe(1);

    expect(await callThrough(afterRestart, upstream, "third")).toBe(
      "third@upstream-session-2",
    );
    expect(lifecycle.records.at(-1)).toMatchObject({
      state: "live",
      generation: 2,
      ownerBootId: "boot-2",
    });
  });

  it("fails closed when another worker owns the session", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const workerA = registryFor(lifecycle.port);
    await callThrough(workerA, upstream, "first");

    const workerB = registryFor(lifecycle.port, {
      ownerInstanceId: "worker-b",
      ownerBootId: "boot-b",
    });
    await expectSessionLost(
      callThrough(workerB, upstream, "second"),
      "owner_lost",
    );
    expect(upstream.counts.open).toBe(1);
  });

  it("refuses to open a session for a run that already ended", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port);
    await callThrough(registry, upstream, "first");
    lifecycle.endRun();

    await expectSessionLost(
      callThrough(registry, upstream, "second"),
      "run_ended",
    );
    await expectSessionLost(
      callThrough(registry, upstream, "third"),
      "run_ended",
    );
    expect(upstream.counts.open).toBe(1);
  });

  it("closes the session once after an explicit close", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port);
    await callThrough(registry, upstream, "first");

    expect(await callThrough(registry, upstream, "close", { close: true })).toBe(
      "close@upstream-session-1",
    );
    expect(upstream.counts.close).toBe(1);
    expect(registry.describe()).toEqual([]);
    expect(lifecycle.records.at(-1)).toMatchObject({
      state: "closed",
      reason: "explicit_close",
    });

    // A deliberate close is not a loss, so the next call may open a session.
    expect(await callThrough(registry, upstream, "next")).toBe(
      "next@upstream-session-2",
    );
    expect(upstream.counts.close).toBe(1);
  });

  it("does not reuse a session after a failed close", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port);
    let closes = 0;
    const flakyClose = async () => {
      closes += 1;
      throw new Error("DELETE failed");
    };
    await registry.withSession({
      scope: { ...SCOPE, parts: [["connectionId", "connection-1"]] },
      authorizationParts: [["grantStatus", "active"]],
      configurationParts: [["endpoint", "https://mcp.invalid/mcp"]],
      open: upstream.open,
      closeSession: flakyClose,
      dispatch: async () => ({
        outcome: "ok",
        value: "closed",
        closeSession: true,
      }),
    });

    expect(closes).toBe(1);
    expect(registry.describe()).toEqual([]);
    expect(await callThrough(registry, upstream, "next")).toBe(
      "next@upstream-session-2",
    );
    // Best effort, at most once: the failed DELETE is not retried later.
    expect(closes).toBe(1);
  });

  it("records a shutdown and reports the loss to a later call", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port);
    await callThrough(registry, upstream, "first");

    await registry.shutdown();

    expect(upstream.counts.close).toBe(1);
    expect(registry.describe()).toEqual([]);
    expect(lifecycle.records.at(-1)).toMatchObject({
      state: "closed",
      reason: "shutdown",
    });
    await expectSessionLost(
      callThrough(registry, upstream, "second"),
      "shutdown",
    );
  });

  it("keeps the durable record free of the upstream session id", async () => {
    const lifecycle = createMemoryLifecycle();
    const upstream = createFakeUpstream();
    const registry = registryFor(lifecycle.port);
    await callThrough(registry, upstream, "first", {
      authorizationParts: [["credentials", "super-secret-token"]],
    });

    const serialized = JSON.stringify(lifecycle.records);
    expect(serialized).not.toContain("upstream-session-1");
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("connection-1");
    expect(Object.keys(lifecycle.records[0]!).sort()).toEqual([
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
  });
});

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was never met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
