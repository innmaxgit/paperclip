// Helpers for talking to remote MCP servers over the Streamable HTTP transport.
//
// The MCP Streamable HTTP spec requires the client to advertise that it accepts
// BOTH a single JSON response and an SSE stream on every POST:
//
//   Accept: application/json, text/event-stream
//
// Spec-compliant servers reject requests missing this header with 406 Not
// Acceptable, and when the header is present they are free to answer with an
// SSE stream (`event: message\ndata: {…}`) instead of a bare JSON body. So any
// code path that POSTs JSON-RPC to a remote `/mcp` endpoint must (a) send the
// Accept header and (b) be able to read an SSE-framed response.

import { createHmac, randomUUID } from "node:crypto";
import { hostname } from "node:os";

/** The Accept header value required by the MCP Streamable HTTP transport. */
export const MCP_HTTP_ACCEPT = "application/json, text/event-stream";
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Default headers for an MCP Streamable HTTP JSON-RPC POST. Caller-supplied
 * headers (e.g. resolved credentials) are preserved, while the required
 * Streamable HTTP Accept value is kept authoritative.
 */
export function mcpHttpRequestHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    ...extra,
    accept: MCP_HTTP_ACCEPT,
  };
}

export class McpHttpInitializationError extends Error {
  constructor(
    message: string,
    readonly stage: "initialize" | "initialized_notification",
    readonly status: number | null,
  ) {
    super(message);
    this.name = "McpHttpInitializationError";
  }
}

/**
 * The negotiated identity of one Streamable HTTP session. The raw upstream
 * session id lives only here, in transport memory: it is never persisted with
 * the connection and never written to a durable log.
 */
export interface McpHttpSessionIdentity {
  protocolVersion: string;
  sessionId: string | null;
}

/** The per-request headers that address an already negotiated session. */
export function mcpHttpSessionHeaders(
  identity: McpHttpSessionIdentity,
): Record<string, string> {
  return {
    "MCP-Protocol-Version": identity.protocolVersion,
    ...(identity.sessionId ? { "Mcp-Session-Id": identity.sessionId } : {}),
  };
}

/**
 * Establish the short-lived Streamable HTTP session needed by stateful MCP
 * servers. The returned headers belong only to the caller's next request; no
 * session id is persisted with the connection or shared across operations.
 */
export async function initializeMcpHttpSession(input: {
  send: (init: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
  requestId: string;
}): Promise<Record<string, string>> {
  const identity = await openMcpHttpSession(input);
  return { ...(input.headers ?? {}), ...mcpHttpSessionHeaders(identity) };
}

/**
 * Negotiate a Streamable HTTP session and return its identity instead of a
 * header bag, so a caller that keeps the session alive across operations can
 * merge freshly resolved credentials into every request.
 */
export async function openMcpHttpSession(input: {
  send: (init: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
  requestId: string;
}): Promise<McpHttpSessionIdentity> {
  const initializeResponse = await input.send({
    method: "POST",
    headers: mcpHttpRequestHeaders(input.headers),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${input.requestId}-initialize`,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "paperclip", version: "1" },
      },
    }),
  });
  if (!initializeResponse.ok) {
    throw new McpHttpInitializationError(
      `Remote MCP initialization returned HTTP ${initializeResponse.status}`,
      "initialize",
      initializeResponse.status,
    );
  }
  let payload: unknown;
  try {
    payload = parseMcpHttpResponseBody(
      await initializeResponse.text(),
      initializeResponse.headers.get("content-type"),
    );
  } catch {
    throw new McpHttpInitializationError("Remote MCP initialization returned an invalid response", "initialize", null);
  }
  const result = payload && typeof payload === "object" && "result" in payload
    ? (payload as { result?: unknown }).result
    : null;
  const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : null;
  const protocolVersion = typeof resultRecord?.protocolVersion === "string" && resultRecord.protocolVersion
    ? resultRecord.protocolVersion
    : MCP_PROTOCOL_VERSION;
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  const identity: McpHttpSessionIdentity = { protocolVersion, sessionId };
  const initializedResponse = await input.send({
    method: "POST",
    headers: mcpHttpRequestHeaders({
      ...(input.headers ?? {}),
      ...mcpHttpSessionHeaders(identity),
    }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  if (!initializedResponse.ok) {
    throw new McpHttpInitializationError(
      `Remote MCP initialized notification returned HTTP ${initializedResponse.status}`,
      "initialized_notification",
      initializedResponse.status,
    );
  }
  return identity;
}

// ---------------------------------------------------------------------------
// Persistent, run-scoped sessions for stateful MCP servers
// ---------------------------------------------------------------------------
//
// A stateful MCP server (Playwright MCP in `--isolated` mode, for example)
// binds its state — the browser context, its tabs and cookies — to the
// Streamable HTTP session. Initializing per operation therefore hands every
// call a blank context, which is what made a navigate/read/screenshot sequence
// behave as if nothing had happened (INT-99/INT-101).
//
// The registry below keeps one transport alive per fully re-validated scope
// inside a single server-authenticated run. It deliberately does NOT:
//  - share a session across runs, workers, scopes, or fingerprints,
//  - persist the raw upstream session id anywhere outside this process,
//  - re-initialize silently after a loss, or replay an operation whose
//    outcome is unknown.

/** Unambiguous separator for the digest inputs below. */
const FIELD_SEPARATOR = "\u001f";

export const MCP_SESSION_IDLE_TTL_MS = 15 * 60 * 1000;
export const MCP_SESSION_ABSOLUTE_TTL_MS = 60 * 60 * 1000;
export const MCP_SESSION_KEEP_ALIVE_INTERVAL_MS = 60 * 1000;
export const MCP_SESSION_LOST_REASON_CODE = "mcp_session_lost";

/** Why a scope's session stopped being usable. Surfaced to the caller as-is. */
export type McpSessionLossReason =
  | "idle_timeout"
  | "absolute_timeout"
  | "authorization_expired"
  | "run_ended"
  | "server_restart"
  | "owner_lost"
  | "config_changed"
  | "authorization_changed"
  | "upstream_session_expired"
  | "heartbeat_failed"
  | "open_failed"
  | "explicit_close"
  | "shutdown";

export type McpSessionState = "opening" | "live" | "lost" | "closed";

/**
 * The durable projection of a session's lifecycle. Every field is either an
 * irreversible digest, an owner identity, or a state/expiry marker — never a
 * raw session id, token, credential, or tool payload.
 */
export interface McpSessionLifecycleRecord {
  scopeHmac: string;
  generation: number;
  fingerprintHmac: string;
  ownerInstanceId: string;
  ownerBootId: string;
  state: McpSessionState;
  reason: string | null;
  idleExpiresAt: string | null;
  absoluteExpiresAt: string | null;
  eventAt: string;
}

export type McpSessionTransitionDecision =
  | { kind: "reuse" }
  | { kind: "append"; record: McpSessionLifecycleRecord; message?: string };

/**
 * The durable log the registry reasons against. `decide` runs inside the same
 * transaction that read the scope's latest record, so a transition can never
 * be interleaved with another writer's.
 */
export interface McpSessionLifecyclePort {
  transition(input: {
    companyId: string;
    runId: string;
    agentId: string;
    scopeHmac: string;
    decide: (context: {
      latest: McpSessionLifecycleRecord | null;
      runActive: boolean;
    }) => McpSessionTransitionDecision;
  }): Promise<void>;
}

export class McpSessionLostError extends Error {
  readonly reasonCode = MCP_SESSION_LOST_REASON_CODE;
  constructor(
    readonly reason: McpSessionLossReason,
    readonly generation: number,
  ) {
    super(`The persistent MCP session is no longer usable (${reason})`);
    this.name = "McpSessionLostError";
  }
}

/** The identifiers a session may never be shared across. */
export interface McpPersistentSessionScope {
  companyId: string;
  runId: string;
  agentId: string;
  /** Ordered, labelled identifiers; all are re-validated by the caller. */
  parts: Array<[string, string | null | undefined]>;
}

export type McpSessionDispatchResult<T> =
  | { outcome: "ok"; value: T; closeSession?: boolean }
  | { outcome: "session_expired" };

export interface McpPersistentSessionRequest<T> {
  scope: McpPersistentSessionScope;
  /** Grant/credential state: a change here is an authorization rotation. */
  authorizationParts: Array<[string, string | null | undefined]>;
  /** Connection/endpoint state: a change here is a configuration rotation. */
  configurationParts: Array<[string, string | null | undefined]>;
  /** Hard upper bound from the caller's authorization (token/session expiry). */
  authorizationExpiresAt?: Date | null;
  open: () => Promise<McpHttpSessionIdentity>;
  dispatch: (
    identity: McpHttpSessionIdentity,
  ) => Promise<McpSessionDispatchResult<T>>;
  /** Best-effort upstream DELETE. Attempted at most once per session. */
  closeSession?: (identity: McpHttpSessionIdentity) => Promise<void>;
  /** Liveness probe. Never counts as caller activity for the idle timer. */
  ping?: (identity: McpHttpSessionIdentity) => Promise<void>;
}

export interface McpPersistentSessionRegistryOptions {
  lifecycle: McpSessionLifecyclePort;
  now?: () => number;
  idleTtlMs?: number;
  absoluteTtlMs?: number;
  /** 0 disables the liveness probe. */
  keepAliveIntervalMs?: number;
  /** Instance-local key for the irreversible scope/fingerprint digests. */
  scopeKey?: string;
  /** Stable per worker slot across restarts; distinct per worker. */
  ownerInstanceId?: string;
  /** Unique per process start. A change means this worker restarted. */
  ownerBootId?: string;
  onLifecycleWriteFailure?: (error: unknown) => void;
}

interface LiveSession {
  scopeHmac: string;
  scope: { companyId: string; runId: string; agentId: string };
  generation: number;
  fingerprintHmac: string;
  authorizationHmac: string;
  configurationHmac: string;
  identity: McpHttpSessionIdentity;
  openedAtMs: number;
  lastUsedAtMs: number;
  authorizationExpiresAtMs: number | null;
  closeAttempted: boolean;
  closeSession?: (identity: McpHttpSessionIdentity) => Promise<void>;
  ping?: (identity: McpHttpSessionIdentity) => Promise<void>;
  keepAlive: ReturnType<typeof setInterval> | null;
}

type AcquirePlan =
  | { kind: "reuse" }
  | { kind: "open"; generation: number }
  | { kind: "lost"; reason: McpSessionLossReason; generation: number };

function defaultOwnerInstanceId(): string {
  const slot =
    process.env.PAPERCLIP_MCP_SESSION_OWNER_SLOT ??
    process.env.NODE_APP_INSTANCE ??
    process.env.pm_id ??
    "0";
  return `${hostname()}#${slot}`;
}

function defaultScopeKey(ownerInstanceId: string): string {
  return (
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim() ||
    ownerInstanceId
  );
}

export function createPersistentMcpSessionRegistry(
  options: McpPersistentSessionRegistryOptions,
) {
  const now = options.now ?? (() => Date.now());
  const idleTtlMs = options.idleTtlMs ?? MCP_SESSION_IDLE_TTL_MS;
  const absoluteTtlMs = options.absoluteTtlMs ?? MCP_SESSION_ABSOLUTE_TTL_MS;
  const keepAliveIntervalMs =
    options.keepAliveIntervalMs ?? MCP_SESSION_KEEP_ALIVE_INTERVAL_MS;
  const ownerInstanceId = options.ownerInstanceId ?? defaultOwnerInstanceId();
  const ownerBootId = options.ownerBootId ?? randomUUID();
  const scopeKey = options.scopeKey ?? defaultScopeKey(ownerInstanceId);
  const live = new Map<string, LiveSession>();
  const queues = new Map<string, Promise<unknown>>();
  // Losses this process discovered on its own (a TTL sweep or a failed probe)
  // rather than while serving a caller. The next caller for that scope is told
  // the session was lost; only the call after it rebuilds. A scope that never
  // calls again (its run ended) would otherwise keep an entry forever, so the
  // oldest ones are dropped once the map is larger than any live fleet.
  const unreportedLoss = new Map<
    string,
    { reason: McpSessionLossReason; generation: number }
  >();
  const UNREPORTED_LOSS_LIMIT = 1_000;

  function digest(
    domain: string,
    parts: Array<[string, string | null | undefined]>,
  ): string {
    const canonical = parts
      .map(([name, value]) => `${name}=${value ?? ""}`)
      .join(FIELD_SEPARATOR);
    return createHmac("sha256", scopeKey)
      .update(`${domain}${FIELD_SEPARATOR}${canonical}`)
      .digest("hex");
  }

  /**
   * Run `task` after every previously queued task for the same scope. This is
   * both the singleflight for the first initialize and the dispatch ordering
   * guarantee: a stateful session may only ever have one operation in flight.
   */
  function enqueue<T>(scopeHmac: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(scopeHmac) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(scopeHmac, tail);
    void tail.then(() => {
      if (queues.get(scopeHmac) === tail) queues.delete(scopeHmac);
    });
    return result;
  }

  function expiryReason(
    session: LiveSession,
    atMs: number,
  ): McpSessionLossReason | null {
    if (
      session.authorizationExpiresAtMs !== null &&
      atMs >= session.authorizationExpiresAtMs
    ) {
      return "authorization_expired";
    }
    if (atMs >= session.openedAtMs + absoluteTtlMs) return "absolute_timeout";
    if (atMs >= session.lastUsedAtMs + idleTtlMs) return "idle_timeout";
    return null;
  }

  function absoluteExpiryMs(session: LiveSession): number {
    const ttlBound = session.openedAtMs + absoluteTtlMs;
    return session.authorizationExpiresAtMs === null
      ? ttlBound
      : Math.min(ttlBound, session.authorizationExpiresAtMs);
  }

  function lifecycleRecord(
    session: Pick<
      LiveSession,
      | "scopeHmac"
      | "generation"
      | "fingerprintHmac"
      | "openedAtMs"
      | "lastUsedAtMs"
      | "authorizationExpiresAtMs"
    >,
    state: McpSessionState,
    reason: string | null,
    atMs: number,
  ): McpSessionLifecycleRecord {
    return {
      scopeHmac: session.scopeHmac,
      generation: session.generation,
      fingerprintHmac: session.fingerprintHmac,
      ownerInstanceId,
      ownerBootId,
      state,
      reason,
      idleExpiresAt: new Date(session.lastUsedAtMs + idleTtlMs).toISOString(),
      absoluteExpiresAt: new Date(
        absoluteExpiryMs(session as LiveSession),
      ).toISOString(),
      eventAt: new Date(atMs).toISOString(),
    };
  }

  /** Drop the in-process transport without writing a durable transition. */
  async function discardLive(session: LiveSession): Promise<void> {
    if (session.keepAlive) {
      clearInterval(session.keepAlive);
      session.keepAlive = null;
    }
    if (live.get(session.scopeHmac) === session) {
      live.delete(session.scopeHmac);
    }
    if (!session.closeAttempted && session.closeSession) {
      session.closeAttempted = true;
      try {
        await session.closeSession(session.identity);
      } catch {
        // Best effort, at most once: a failed DELETE must never make the
        // invalidated session reusable, and must never fail the caller.
      }
    }
  }

  /**
   * Invalidate a live session and record the transition that caused it.
   *
   * `surfaced` says the caller is already being told about this invalidation.
   * When it is not, the loss is remembered so the next caller is told
   * explicitly instead of silently receiving a brand new session.
   */
  async function invalidate(
    session: LiveSession,
    reason: McpSessionLossReason,
    options_: { surfaced?: boolean } = {},
  ): Promise<void> {
    const scope = session.scope;
    const atMs = now();
    if (!options_.surfaced) {
      unreportedLoss.set(session.scopeHmac, {
        reason,
        generation: session.generation,
      });
      while (unreportedLoss.size > UNREPORTED_LOSS_LIMIT) {
        const oldest = unreportedLoss.keys().next();
        if (oldest.done) break;
        unreportedLoss.delete(oldest.value);
      }
    }
    const state: McpSessionState =
      reason === "explicit_close" || reason === "shutdown" ? "closed" : "lost";
    await discardLive(session);
    try {
      await options.lifecycle.transition({
        ...scope,
        scopeHmac: session.scopeHmac,
        decide: ({ latest }) => {
          if (
            latest &&
            (latest.generation !== session.generation ||
              latest.ownerBootId !== ownerBootId ||
              (latest.state !== "live" && latest.state !== "opening"))
          ) {
            return { kind: "reuse" };
          }
          return {
            kind: "append",
            record: lifecycleRecord(session, state, reason, atMs),
            message: `MCP session ${state} (${reason})`,
          };
        },
      });
    } catch (error) {
      options.onLifecycleWriteFailure?.(error);
    }
  }

  function scheduleKeepAlive(session: LiveSession): void {
    if (session.keepAlive || keepAliveIntervalMs <= 0 || !session.ping) return;
    const timer = setInterval(() => {
      void enqueue(session.scopeHmac, async () => {
        if (live.get(session.scopeHmac) !== session) return;
        // A probe is not caller activity: it reports liveness and sweeps an
        // expired session, but it never extends the idle deadline.
        const reason = expiryReason(session, now());
        if (reason) {
          await invalidate(session, reason);
          return;
        }
        try {
          await session.ping?.(session.identity);
        } catch {
          await invalidate(session, "heartbeat_failed");
        }
      });
    }, keepAliveIntervalMs);
    timer.unref?.();
    session.keepAlive = timer;
  }

  function planAcquire(input: {
    latest: McpSessionLifecycleRecord | null;
    runActive: boolean;
    session: LiveSession | null;
    atMs: number;
    fingerprintHmac: string;
    authorizationHmac: string;
  }): AcquirePlan {
    const { latest, session, atMs } = input;
    const owned =
      latest !== null &&
      (latest.state === "live" || latest.state === "opening");
    if (!input.runActive) {
      return {
        kind: "lost",
        reason: "run_ended",
        generation: latest?.generation ?? 0,
      };
    }
    if (!owned) {
      return { kind: "open", generation: (latest?.generation ?? 0) + 1 };
    }
    if (latest.ownerInstanceId !== ownerInstanceId) {
      // Another worker owns this session. Without owner routing we fail closed
      // instead of adopting or rebuilding someone else's browser state.
      return {
        kind: "lost",
        reason: "owner_lost",
        generation: latest.generation,
      };
    }
    if (latest.ownerBootId !== ownerBootId) {
      return {
        kind: "lost",
        reason: "server_restart",
        generation: latest.generation,
      };
    }
    if (!session || session.generation !== latest.generation) {
      return {
        kind: "lost",
        reason: "owner_lost",
        generation: latest.generation,
      };
    }
    if (latest.fingerprintHmac !== input.fingerprintHmac) {
      return {
        kind: "lost",
        reason:
          session.authorizationHmac !== input.authorizationHmac
            ? "authorization_changed"
            : "config_changed",
        generation: latest.generation,
      };
    }
    const expired = expiryReason(session, atMs);
    if (expired) {
      return { kind: "lost", reason: expired, generation: latest.generation };
    }
    return { kind: "reuse" };
  }

  async function acquire<T>(
    request: McpPersistentSessionRequest<T>,
    hmacs: {
      scopeHmac: string;
      fingerprintHmac: string;
      authorizationHmac: string;
      configurationHmac: string;
    },
  ): Promise<LiveSession> {
    const scope = {
      companyId: request.scope.companyId,
      runId: request.scope.runId,
      agentId: request.scope.agentId,
    };
    const unreported = unreportedLoss.get(hmacs.scopeHmac);
    if (unreported) {
      unreportedLoss.delete(hmacs.scopeHmac);
      throw new McpSessionLostError(unreported.reason, unreported.generation);
    }
    const existing = live.get(hmacs.scopeHmac) ?? null;
    const atMs = now();
    // Held in a box: the plan is produced inside the transaction callback, and
    // the decision there is what the code after the transition acts on.
    const planned: { value: AcquirePlan } = {
      value: { kind: "lost", reason: "owner_lost", generation: 0 },
    };
    await options.lifecycle.transition({
      ...scope,
      scopeHmac: hmacs.scopeHmac,
      decide: ({ latest, runActive }) => {
        const plan = planAcquire({
          latest,
          runActive,
          session: existing,
          atMs,
          fingerprintHmac: hmacs.fingerprintHmac,
          authorizationHmac: hmacs.authorizationHmac,
        });
        planned.value = plan;
        if (plan.kind === "reuse") return { kind: "reuse" };
        const projection = {
          scopeHmac: hmacs.scopeHmac,
          generation: plan.generation,
          fingerprintHmac:
            plan.kind === "lost" && latest
              ? latest.fingerprintHmac
              : hmacs.fingerprintHmac,
          openedAtMs: existing?.openedAtMs ?? atMs,
          lastUsedAtMs: existing?.lastUsedAtMs ?? atMs,
          authorizationExpiresAtMs:
            request.authorizationExpiresAt?.getTime() ?? null,
        };
        if (plan.kind === "lost") {
          if (!latest || (latest.state !== "live" && latest.state !== "opening")) {
            // Nothing live to invalidate (for example a run that ended before
            // this scope ever had a session). Report the loss without writing
            // a redundant transition.
            return { kind: "reuse" };
          }
          return {
            kind: "append",
            record: lifecycleRecord(projection, "lost", plan.reason, atMs),
            message: `MCP session lost (${plan.reason})`,
          };
        }
        return {
          kind: "append",
          record: lifecycleRecord(
            projection,
            "opening",
            latest ? "rebuilt" : "established",
            atMs,
          ),
          message: `MCP session opening (generation ${plan.generation})`,
        };
      },
    });

    const plan = planned.value;
    if (plan.kind === "lost") {
      if (existing) await discardLive(existing);
      throw new McpSessionLostError(plan.reason, plan.generation);
    }
    if (plan.kind === "reuse") return existing!;

    if (existing) await discardLive(existing);
    const generation = plan.generation;
    let identity: McpHttpSessionIdentity;
    try {
      identity = await request.open();
    } catch (error) {
      const failed = {
        scopeHmac: hmacs.scopeHmac,
        generation,
        fingerprintHmac: hmacs.fingerprintHmac,
        openedAtMs: atMs,
        lastUsedAtMs: atMs,
        authorizationExpiresAtMs:
          request.authorizationExpiresAt?.getTime() ?? null,
      };
      try {
        await options.lifecycle.transition({
          ...scope,
          scopeHmac: hmacs.scopeHmac,
          decide: () => ({
            kind: "append",
            record: lifecycleRecord(failed, "lost", "open_failed", now()),
            message: "MCP session open failed",
          }),
        });
      } catch (writeError) {
        options.onLifecycleWriteFailure?.(writeError);
      }
      throw error;
    }

    const openedAtMs = now();
    const session: LiveSession = {
      scopeHmac: hmacs.scopeHmac,
      scope,
      generation,
      fingerprintHmac: hmacs.fingerprintHmac,
      authorizationHmac: hmacs.authorizationHmac,
      configurationHmac: hmacs.configurationHmac,
      identity,
      openedAtMs,
      lastUsedAtMs: openedAtMs,
      authorizationExpiresAtMs:
        request.authorizationExpiresAt?.getTime() ?? null,
      closeAttempted: false,
      closeSession: request.closeSession,
      ping: request.ping,
      keepAlive: null,
    };
    let conflict = false;
    try {
      await options.lifecycle.transition({
        ...scope,
        scopeHmac: hmacs.scopeHmac,
        decide: ({ latest }) => {
          if (
            !latest ||
            latest.generation !== generation ||
            latest.ownerInstanceId !== ownerInstanceId ||
            latest.ownerBootId !== ownerBootId
          ) {
            conflict = true;
            return { kind: "reuse" };
          }
          return {
            kind: "append",
            record: lifecycleRecord(session, "live", "opened", openedAtMs),
            message: `MCP session live (generation ${generation})`,
          };
        },
      });
    } catch (error) {
      // The session exists upstream but we could not claim it durably, so a
      // restart could not tell this apart from a first use. Close it instead.
      await discardLive(session);
      options.onLifecycleWriteFailure?.(error);
      throw error;
    }
    if (conflict) {
      await discardLive(session);
      throw new McpSessionLostError("owner_lost", generation);
    }
    live.set(hmacs.scopeHmac, session);
    scheduleKeepAlive(session);
    return session;
  }

  return {
    ownerInstanceId,
    ownerBootId,

    async withSession<T>(
      request: McpPersistentSessionRequest<T>,
    ): Promise<T> {
      const scopeHmac = digest("scope", [
        ["companyId", request.scope.companyId],
        ["runId", request.scope.runId],
        ["agentId", request.scope.agentId],
        ...request.scope.parts,
      ]);
      const authorizationHmac = digest("authorization", request.authorizationParts);
      const configurationHmac = digest("configuration", request.configurationParts);
      const fingerprintHmac = digest("fingerprint", [
        ["authorization", authorizationHmac],
        ["configuration", configurationHmac],
      ]);
      return enqueue(scopeHmac, async () => {
        const session = await acquire(request, {
          scopeHmac,
          fingerprintHmac,
          authorizationHmac,
          configurationHmac,
        });
        // Keep the probe/close closures bound to this call's freshly resolved
        // credentials instead of the ones captured when the session opened.
        session.closeSession = request.closeSession;
        session.ping = request.ping;
        const dispatched = await request.dispatch(session.identity);
        if (dispatched.outcome === "session_expired") {
          await invalidate(session, "upstream_session_expired", {
            surfaced: true,
          });
          throw new McpSessionLostError(
            "upstream_session_expired",
            session.generation,
          );
        }
        session.lastUsedAtMs = now();
        if (dispatched.closeSession) {
          // The caller asked for the close, so the next call may open a new
          // session without being told this one is gone.
          await invalidate(session, "explicit_close", { surfaced: true });
        }
        return dispatched.value;
      });
    },

    /** Non-secret view for diagnostics and tests. */
    describe() {
      return [...live.values()].map((session) => ({
        scopeHmac: session.scopeHmac,
        generation: session.generation,
        idleExpiresAt: new Date(
          session.lastUsedAtMs + idleTtlMs,
        ).toISOString(),
        absoluteExpiresAt: new Date(absoluteExpiryMs(session)).toISOString(),
      }));
    },

    async shutdown(): Promise<void> {
      const sessions = [...live.values()];
      for (const session of sessions) {
        await enqueue(session.scopeHmac, () =>
          invalidate(session, "shutdown"),
        );
      }
    },
  };
}

export type PersistentMcpSessionRegistry = ReturnType<
  typeof createPersistentMcpSessionRegistry
>;

function looksLikeJsonRpcMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "result" in record || "error" in record || "method" in record || "id" in record;
}

/**
 * Parse the body of an MCP Streamable HTTP response into its JSON-RPC payload.
 *
 * Handles both response shapes the transport allows:
 *  - `application/json`: the body is the JSON-RPC message directly.
 *  - `text/event-stream`: one or more SSE events; we return the JSON payload of
 *    the first `data:` event that parses as a JSON-RPC message.
 *
 * Falls back to a plain JSON parse when the content type is unknown so we stay
 * compatible with non-compliant servers that ignore the Accept header.
 */
export function parseMcpHttpResponseBody(bodyText: string, contentType: string | null): unknown {
  const isEventStream = (contentType ?? "").toLowerCase().includes("text/event-stream");
  if (!isEventStream) {
    return JSON.parse(bodyText) as unknown;
  }

  // Split the SSE stream into events on blank lines, then collect each event's
  // `data:` lines (which may span multiple lines per the SSE spec).
  const events = bodyText.replace(/\r\n/g, "\n").split(/\n\n+/);
  let lastError: unknown = null;
  let firstParsed: unknown;
  let sawData = false;
  for (const event of events) {
    const dataLines = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!sawData) {
      firstParsed = parsed;
      sawData = true;
    }
    if (looksLikeJsonRpcMessage(parsed)) {
      return parsed;
    }
  }
  if (sawData) return firstParsed;
  if (lastError) throw lastError;
  throw new SyntaxError("MCP SSE response contained no data events");
}
