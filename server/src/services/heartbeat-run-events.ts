import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { nativeSha256 } from "./native-runtime/canonical.js";
import type {
  McpSessionLifecyclePort,
  McpSessionLifecycleRecord,
} from "./mcp-http.js";

export interface AppendHeartbeatRunEventInput {
  companyId: string;
  runId: string;
  agentId: string;
  eventType: string;
  stream?: string | null;
  level?: string | null;
  color?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
  /** Reuse an existing exhaustion receipt, including receipts from older builds. */
  retryExhaustion?: {
    retryReason: string;
    scheduledRetryAttempt: number;
    maxAttempts: number;
  };
  nativeSource?: {
    sourceInstanceId: string;
    sourceEventId: string;
    sourceSeq: number;
    protocolSchemaVersion: number;
    canonicalPayload: Record<string, unknown>;
  };
}

export interface AppendHeartbeatRunEventResult {
  row: typeof heartbeatRunEvents.$inferSelect;
  disposition: "committed" | "duplicate";
  highestContiguousSourceSeq: number;
}

export class HeartbeatRunEventConflictError extends Error {
  readonly code = "native_event_replay_conflict" as const;
  constructor() {
    super("native_event_replay_conflict");
    this.name = "HeartbeatRunEventConflictError";
  }
}

/**
 * Atomically reserve the next event sequence on the run row. Both native PRP
 * ingestion and legacy/direct-adapter writers use this allocator so the
 * database uniqueness invariant cannot turn a concurrent log/cancel/recovery
 * race into a failed run.
 */
export async function allocateHeartbeatRunEventSeq(
  db: Db,
  runId: string,
): Promise<number> {
  const [updated] = await db
    .update(heartbeatRuns)
    .set({
      nextEventSeq: sql`${heartbeatRuns.nextEventSeq} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(heartbeatRuns.id, runId))
    .returning({ nextEventSeq: heartbeatRuns.nextEventSeq });
  if (!updated) throw new Error("heartbeat_run_event_binding_mismatch");
  return Number(updated.nextEventSeq) - 1;
}

export async function appendHeartbeatRunEvent(
  db: Db,
  input: AppendHeartbeatRunEventInput,
): Promise<AppendHeartbeatRunEventResult> {
  return db.transaction(async (tx) => {
    const run = await tx
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId) {
      throw new Error("heartbeat_run_event_binding_mismatch");
    }

    if (input.retryExhaustion && !input.nativeSource) {
      // The run lock also serializes concurrent recovery checks across server
      // instances. Reusing the receipt must not allocate a sequence or publish
      // another live event on each scheduler tick.
      const existing = await tx
        .select()
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.companyId, input.companyId),
          eq(heartbeatRunEvents.runId, input.runId),
          eq(heartbeatRunEvents.agentId, input.agentId),
          eq(heartbeatRunEvents.eventType, "lifecycle"),
          sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
          sql`${heartbeatRunEvents.payload} @> ${JSON.stringify(input.retryExhaustion)}::jsonb`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) {
        return {
          row: existing,
          disposition: "duplicate" as const,
          highestContiguousSourceSeq: 0,
        };
      }
    }

    const sourceHash = input.nativeSource
      ? nativeSha256(input.nativeSource.canonicalPayload)
      : null;
    if (input.nativeSource) {
      const existing = await tx
        .select()
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.runId, input.runId),
          or(
            eq(heartbeatRunEvents.sourceEventId, input.nativeSource.sourceEventId),
            and(
              eq(heartbeatRunEvents.sourceInstanceId, input.nativeSource.sourceInstanceId),
              eq(heartbeatRunEvents.sourceSeq, input.nativeSource.sourceSeq),
            ),
          ),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) {
        if (existing.sourcePayloadSha256 !== sourceHash) {
          throw new HeartbeatRunEventConflictError();
        }
        return {
          row: existing,
          disposition: "duplicate" as const,
          highestContiguousSourceSeq: await contiguousCursor(
            tx as unknown as Db,
            input.runId,
            input.nativeSource.sourceInstanceId,
          ),
        };
      }
    }

    const seq = await allocateHeartbeatRunEventSeq(
      tx as unknown as Db,
      input.runId,
    );
    const [row] = await tx.insert(heartbeatRunEvents).values({
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      seq,
      eventType: input.eventType,
      stream: input.stream ?? null,
      level: input.level ?? null,
      color: input.color ?? null,
      message: input.message ?? null,
      payload: input.payload ?? null,
      sourceInstanceId: input.nativeSource?.sourceInstanceId ?? null,
      sourceEventId: input.nativeSource?.sourceEventId ?? null,
      sourceSeq: input.nativeSource?.sourceSeq ?? null,
      sourcePayloadSha256: sourceHash,
      protocolSchemaVersion: input.nativeSource?.protocolSchemaVersion ?? null,
    }).returning();
    if (!row) throw new Error("heartbeat_run_event_not_persisted");
    return {
      row,
      disposition: "committed" as const,
      highestContiguousSourceSeq: input.nativeSource
        ? await contiguousCursor(
            tx as unknown as Db,
            input.runId,
            input.nativeSource.sourceInstanceId,
          )
        : 0,
    };
  });
}

/** Run statuses during which a run may still execute tool calls. */
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "scheduled_retry"]);

/** The run-log event type carrying persistent MCP session transitions. */
export const MCP_SESSION_LIFECYCLE_EVENT_TYPE = "tool_mcp_session";

/**
 * Durable lifecycle log for persistent MCP sessions, on the existing run log.
 *
 * The run row lock that serializes event-sequence allocation also serializes
 * this read-then-append, so a scope's latest state and the transition derived
 * from it cannot be interleaved with another writer. Only the caller's
 * irreversible digests, owner identity, state/reason, and expiry bounds are
 * stored — never the upstream session id, a token, or tool content.
 */
export async function transitionMcpSessionLifecycle(
  db: Db,
  input: Parameters<McpSessionLifecyclePort["transition"]>[0],
): Promise<void> {
  await db.transaction(async (tx) => {
    const run = await tx
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !run ||
      run.companyId !== input.companyId ||
      run.agentId !== input.agentId
    ) {
      throw new Error("heartbeat_run_event_binding_mismatch");
    }
    const [latestRow] = await tx
      .select()
      .from(heartbeatRunEvents)
      .where(and(
        eq(heartbeatRunEvents.companyId, input.companyId),
        eq(heartbeatRunEvents.runId, input.runId),
        eq(heartbeatRunEvents.eventType, MCP_SESSION_LIFECYCLE_EVENT_TYPE),
        sql`${heartbeatRunEvents.payload}->>'scopeHmac' = ${input.scopeHmac}`,
      ))
      .orderBy(desc(heartbeatRunEvents.seq))
      .limit(1);
    const decision = input.decide({
      latest:
        (latestRow?.payload as unknown as McpSessionLifecycleRecord | undefined) ??
        null,
      runActive: ACTIVE_RUN_STATUSES.has(run.status),
    });
    if (decision.kind === "reuse") return;
    const seq = await allocateHeartbeatRunEventSeq(
      tx as unknown as Db,
      input.runId,
    );
    await tx.insert(heartbeatRunEvents).values({
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      seq,
      eventType: MCP_SESSION_LIFECYCLE_EVENT_TYPE,
      level: "debug",
      message: decision.message ?? null,
      payload: { ...decision.record },
    });
  });
}

async function contiguousCursor(db: Db, runId: string, sourceInstanceId: string): Promise<number> {
  const rows = await db
    .select({ sourceSeq: heartbeatRunEvents.sourceSeq })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.sourceInstanceId, sourceInstanceId),
    ))
    .orderBy(asc(heartbeatRunEvents.sourceSeq));
  let cursor = 0;
  for (const row of rows) {
    if (row.sourceSeq === cursor + 1) cursor += 1;
    else if (row.sourceSeq !== null && row.sourceSeq > cursor + 1) break;
  }
  return cursor;
}
