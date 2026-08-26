import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, companyId: string, userId: string) {
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId,
      source: "local_implicit",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function createCompanyWithOwner(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `Access Routes ${randomUUID()}`,
      issuePrefix: `AR${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const owner = await db
    .insert(companyMemberships)
    .values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    })
    .returning()
    .then((rows) => rows[0]!);
  return { company, owner };
}

describeEmbeddedPostgres("access routes permissions upgrade compatibility", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-routes-permissions-upgrade-");
    db = createDb(tempDb.connectionString);
    // Pay the routes module's (multi-second) load cost once here instead of billing it to
    // whichever test happens to run first and pushing it over its own timeout.
    process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
    process.env.PAPERCLIP_IN_WORKTREE = "false";
    await import("../routes/access.js");
  }, 40_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rejects owner self-lockout through the member route after the permissions upgrade", async () => {
    const { company, owner } = await createCompanyWithOwner(db);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${owner.id}`)
      .send({ membershipRole: "admin" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("You cannot remove yourself");

    const unchanged = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(unchanged.membershipRole).toBe("owner");
  }, 10_000);

  it("keeps custom grants when the role-only member route changes a member role", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `admin-${randomUUID()}`,
        status: "active",
        membershipRole: "admin",
      })
      .returning()
      .then((rows) => rows[0]!);
    const customScope = { projectIds: ["project-1"] };
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: member.principalId,
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}`)
      .send({ membershipRole: "operator" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.membershipRole).toBe("operator");

    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, company.id),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, member.principalId),
        ),
      );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });
  });

  async function createMember(
    db: Db,
    companyId: string,
    membershipRole: string,
    grantKeys: string[],
  ) {
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType: "user",
        principalId: `member-${randomUUID()}`,
        status: "active",
        membershipRole,
      })
      .returning()
      .then((rows) => rows[0]!);
    if (grantKeys.length > 0) {
      await db.insert(principalPermissionGrants).values(
        grantKeys.map((permissionKey) => ({
          companyId,
          principalType: "user" as const,
          principalId: member.principalId,
          permissionKey: permissionKey as any,
          scope: null,
          grantedByUserId: null,
        })),
      );
    }
    return member;
  }

  async function grantKeysFor(db: Db, companyId: string, principalId: string) {
    const rows = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      );
    return rows.map((row) => row.permissionKey).sort();
  }

  const ADMIN_DEFAULT_KEYS = [
    "agents:create",
    "agents:configure",
    "skills:create",
    "environments:manage",
    "users:invite",
    "tasks:assign",
    "joins:approve",
  ];

  it("adds the keys the new role introduces when a member is upgraded admin -> owner", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    // A manual extra grant that no role default set contains: it must survive the upgrade.
    const member = await createMember(db, company.id, "admin", [
      ...ADMIN_DEFAULT_KEYS,
      "tasks:assign_scope",
    ]);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}`)
      .send({ membershipRole: "owner" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.membershipRole).toBe("owner");

    const keys = await grantKeysFor(db, company.id, member.principalId);
    // owner adds users:manage_permissions on top of the admin default set...
    expect(keys).toContain("users:manage_permissions");
    // ...every admin default key is still there (owner is a superset of admin)...
    for (const key of ADMIN_DEFAULT_KEYS) expect(keys).toContain(key);
    // ...and the manual grant is untouched.
    expect(keys).toContain("tasks:assign_scope");
    expect(keys).toHaveLength(ADMIN_DEFAULT_KEYS.length + 2);
  }, 10_000);

  // The HTTP route cannot reach an owner -> admin downgrade: getProtectedMemberReason
  // rejects a target whose role ranks at or above the actor's, and the actor role tops
  // out at "owner". So the downgrade recompute is exercised here at the seam the route
  // calls, against the same database.
  it("removes only old-role-exclusive default keys when a member is downgraded owner -> admin", async () => {
    const { company } = await createCompanyWithOwner(db);
    const member = await createMember(db, company.id, "owner", [
      ...ADMIN_DEFAULT_KEYS,
      "users:manage_permissions",
      "tasks:assign_scope",
    ]);

    const { syncHumanRoleDefaultGrants } = await import(
      "../services/principal-access-compatibility.js"
    );
    const result = await syncHumanRoleDefaultGrants(db, {
      companyId: company.id,
      principalId: member.principalId,
      previousMembershipRole: "owner",
      nextMembershipRole: "admin",
      grantedByUserId: null,
    });

    // users:manage_permissions is the only key owner defaults to that admin does not.
    expect(result.removedKeys).toEqual(["users:manage_permissions"]);
    expect(result.addedKeys).toEqual([]);

    const keys = await grantKeysFor(db, company.id, member.principalId);
    expect(keys).not.toContain("users:manage_permissions");
    // Keys shared by both default sets stay.
    for (const key of ADMIN_DEFAULT_KEYS) expect(keys).toContain(key);
    // The manual grant is in neither default set, so the downgrade must not reach it.
    expect(keys).toContain("tasks:assign_scope");
    expect(keys).toHaveLength(ADMIN_DEFAULT_KEYS.length + 1);
  }, 10_000);

  it("keeps manual extra grants across a downgrade that strips most role defaults", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await createMember(db, company.id, "admin", [
      ...ADMIN_DEFAULT_KEYS,
      "tasks:assign_scope",
      "pipelines:write",
    ]);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}`)
      .send({ membershipRole: "operator" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.membershipRole).toBe("operator");

    const keys = await grantKeysFor(db, company.id, member.principalId);
    // operator defaults to tasks:assign only; every other admin default key is dropped.
    expect(keys).toEqual(["pipelines:write", "tasks:assign", "tasks:assign_scope"].sort());

    // The role change and its grant recomputation are recorded on one activity_log row.
    const logs = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, company.id),
          eq(activityLog.action, "company_member.updated"),
        ),
      );
    expect(logs).toHaveLength(1);
    expect((logs[0]!.details as any).roleGrantsRemoved).toEqual(
      expect.arrayContaining(["agents:create", "agents:configure", "joins:approve"]),
    );
  }, 10_000);
});
