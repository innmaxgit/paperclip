import { and, eq, inArray, isNull, lt, notExists } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/** Skipped wakeups older than this are deleted. */
export const SKIPPED_WAKEUP_RETENTION_DAYS = 14;

/**
 * Rows deleted per sweep. heartbeat_runs.wakeup_request_id has no index, so
 * every deleted row costs one foreign-key check scan of heartbeat_runs; a
 * single bounded batch per sweep keeps that cost small while a large backlog
 * drains over several days.
 */
export const SKIPPED_WAKEUP_DELETE_BATCH_SIZE = 5_000;

const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Delete one batch of `skipped` wakeup requests whose last update is older
 * than the retention window. Skipped rows never count toward dedupe or
 * delivery state (every idempotency lookup excludes them), but they made up
 * most of agent_wakeup_requests and slowed its idempotency-key scans. Rows
 * still referenced by a heartbeat run are kept.
 *
 * @returns The number of rows deleted.
 */
export async function pruneSkippedWakeupRequests(
  db: Db,
  options: { now?: Date; retentionDays?: number; batchSize?: number } = {},
): Promise<number> {
  const retentionDays = options.retentionDays ?? SKIPPED_WAKEUP_RETENTION_DAYS;
  const batchSize = options.batchSize ?? SKIPPED_WAKEUP_DELETE_BATCH_SIZE;
  const cutoff = new Date((options.now ?? new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1_000);

  const candidates = db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.status, "skipped"),
        lt(agentWakeupRequests.updatedAt, cutoff),
        isNull(agentWakeupRequests.runId),
        notExists(
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id)),
        ),
      ),
    )
    .limit(batchSize);
  const count = await db
    .delete(agentWakeupRequests)
    .where(inArray(agentWakeupRequests.id, candidates))
    .returning({ id: agentWakeupRequests.id })
    .then((rows) => rows.length);
  if (count > 0) {
    logger.info({ deleted: count, retentionDays }, "Pruned skipped wakeup requests");
  }
  return count;
}

/**
 * Wrap the prune in an hourly throttle so it can ride an existing, more
 * frequent scheduler tick (and its shutdown tracking) instead of owning a timer.
 */
export function createSkippedWakeupRetentionSweep(
  db: Db,
  intervalMs: number = SWEEP_INTERVAL_MS,
): (now?: Date) => Promise<number> {
  let lastStartedAt: number | null = null;
  let running = false;
  return async (now = new Date()) => {
    if (running) return 0;
    if (lastStartedAt !== null && now.getTime() - lastStartedAt < intervalMs) return 0;
    running = true;
    lastStartedAt = now.getTime();
    try {
      return await pruneSkippedWakeupRequests(db, { now });
    } finally {
      running = false;
    }
  };
}
