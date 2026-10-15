import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  createSkippedWakeupRetentionSweep,
  pruneSkippedWakeupRequests,
} from "../services/wakeup-request-retention.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("skipped wakeup request retention", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const now = new Date("2026-10-15T00:00:00.000Z");
  const old = new Date("2026-09-01T00:00:00.000Z");
  const recent = new Date("2026-10-10T00:00:00.000Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wakeup-retention-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Retention",
      issuePrefix: `W${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const wake = (status: string, updatedAt: Date) => ({
      id: randomUUID(),
      companyId,
      agentId,
      source: "test",
      status,
      requestedAt: updatedAt,
      updatedAt,
    });
    return { companyId, agentId, wake };
  }

  it("deletes only old skipped wakeups that no run references", async () => {
    const { companyId, agentId, wake } = await seed();
    const oldSkipped = wake("skipped", old);
    const recentSkipped = wake("skipped", recent);
    const oldCompleted = wake("completed", old);
    const referencedSkipped = wake("skipped", old);
    await db.insert(agentWakeupRequests).values([oldSkipped, recentSkipped, oldCompleted, referencedSkipped]);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      wakeupRequestId: referencedSkipped.id,
    });

    await expect(pruneSkippedWakeupRequests(db, { now })).resolves.toBe(1);

    const remaining = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests);
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [recentSkipped.id, oldCompleted.id, referencedSkipped.id].sort(),
    );
  });

  it("deletes at most one batch per call", async () => {
    const { wake } = await seed();
    await db.insert(agentWakeupRequests).values(Array.from({ length: 5 }, () => wake("skipped", old)));

    await expect(pruneSkippedWakeupRequests(db, { now, batchSize: 2 })).resolves.toBe(2);
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(3);
  });

  it("throttles the scheduled sweep to its interval", async () => {
    const { wake } = await seed();
    await db.insert(agentWakeupRequests).values([wake("skipped", old), wake("skipped", old)]);
    const sweep = createSkippedWakeupRetentionSweep(db, 60_000);

    await expect(sweep(now)).resolves.toBe(2);
    await db.insert(agentWakeupRequests).values(wake("skipped", old));
    await expect(sweep(new Date(now.getTime() + 30_000))).resolves.toBe(0);
    await expect(sweep(new Date(now.getTime() + 60_000))).resolves.toBe(1);
  });
});
