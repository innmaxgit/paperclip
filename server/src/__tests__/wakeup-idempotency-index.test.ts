import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

async function planFor(db: ReturnType<typeof createDb>, query: ReturnType<typeof sql>) {
  return db.transaction(async (tx) => {
    // Tiny test tables always favour a seq scan; disable it to prove an index can serve the query.
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const rows = await tx.execute(sql`EXPLAIN ${query}`);
    return Array.from(rows as Iterable<Record<string, string>>)
      .map((row) => row["QUERY PLAN"])
      .join("\n");
  });
}

describePg("wakeup lookup indexes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wakeup-index-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => tempDb?.cleanup());

  it("serves company + idempotency key lookups from an index", async () => {
    const plan = await planFor(
      db,
      sql`SELECT id FROM agent_wakeup_requests
          WHERE company_id = '00000000-0000-0000-0000-000000000000'
            AND idempotency_key IN ('a', 'b')`,
    );
    expect(plan).toContain("agent_wakeup_requests_company_idempotency_idx");
  });

  it("serves heartbeat run lookups by wakeup request from an index", async () => {
    const plan = await planFor(
      db,
      sql`SELECT 1 FROM heartbeat_runs WHERE wakeup_request_id = '00000000-0000-0000-0000-000000000000'`,
    );
    expect(plan).toContain("heartbeat_runs_wakeup_request_idx");
  });
});
