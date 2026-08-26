import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";
import { grantsForHumanRole, normalizeHumanRole } from "./company-member-roles.js";

type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export type PrincipalAccessCompatibilityBackfillStats = {
  agentMembershipsInserted: number;
  humanGrantsInserted: number;
};

export async function insertMissingPrincipalGrants(
  db: Db,
  input: {
    companyId: string;
    principalType: PrincipalType;
    principalId: string;
    grants: GrantInput[];
    grantedByUserId: string | null;
  },
): Promise<number> {
  if (input.grants.length === 0) return 0;

  const now = new Date();
  const inserted = await db
    .insert(principalPermissionGrants)
    .values(
      input.grants.map((grant) => ({
        companyId: input.companyId,
        principalType: input.principalType,
        principalId: input.principalId,
        permissionKey: grant.permissionKey,
        scope: grant.scope ?? null,
        grantedByUserId: input.grantedByUserId,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing({
      target: [
        principalPermissionGrants.companyId,
        principalPermissionGrants.principalType,
        principalPermissionGrants.principalId,
        principalPermissionGrants.permissionKey,
      ],
    })
    .returning({ id: principalPermissionGrants.id });

  return inserted.length;
}

export async function ensureHumanRoleDefaultGrants(
  db: Db,
  input: {
    companyId: string;
    principalId: string;
    membershipRole: string | null | undefined;
    grantedByUserId: string | null;
  },
): Promise<number> {
  const role = normalizeHumanRole(input.membershipRole, "operator");
  return insertMissingPrincipalGrants(db, {
    companyId: input.companyId,
    principalType: "user",
    principalId: input.principalId,
    grants: grantsForHumanRole(role),
    grantedByUserId: input.grantedByUserId,
  });
}

export type HumanRoleGrantSyncResult = {
  addedKeys: PermissionKey[];
  removedKeys: PermissionKey[];
};

const EMPTY_ROLE_GRANT_SYNC: HumanRoleGrantSyncResult = { addedKeys: [], removedKeys: [] };

/**
 * Re-align a human principal's role-default grants after their membership role changed.
 *
 * Both directions run off the same difference of the two role default sets, so no caller
 * has to classify the change as an upgrade or a downgrade first:
 *   - keys the new role defaults to but the old one did not are inserted additively
 *     (`insertMissingPrincipalGrants`, so an existing row always wins and keeps its scope);
 *   - keys the old role defaulted to but the new one does not are deleted.
 *
 * Manual extra grants are never touched: a key outside both default sets is not in either
 * side of the difference, so it is never inserted, never deleted, and never even read.
 * Pass a transaction as `db` to keep this atomic with the membership row update.
 */
export async function syncHumanRoleDefaultGrants(
  db: Db,
  input: {
    companyId: string;
    principalId: string;
    previousMembershipRole: string | null | undefined;
    nextMembershipRole: string | null | undefined;
    grantedByUserId: string | null;
  },
): Promise<HumanRoleGrantSyncResult> {
  const previousRole = normalizeHumanRole(input.previousMembershipRole, "operator");
  const nextRole = normalizeHumanRole(input.nextMembershipRole, "operator");
  // Normalizing first means aliases that collapse to the same role (e.g. "member" ->
  // "operator") are correctly treated as a no-op rather than churning grants.
  if (previousRole === nextRole) return EMPTY_ROLE_GRANT_SYNC;

  const previousDefaults = grantsForHumanRole(previousRole);
  const nextDefaults = grantsForHumanRole(nextRole);
  const previousKeys = new Set(previousDefaults.map((grant) => grant.permissionKey));
  const nextKeys = new Set(nextDefaults.map((grant) => grant.permissionKey));

  const grantsToAdd = nextDefaults.filter((grant) => !previousKeys.has(grant.permissionKey));
  const keysToRemove = [...previousKeys].filter((key) => !nextKeys.has(key));

  await insertMissingPrincipalGrants(db, {
    companyId: input.companyId,
    principalType: "user",
    principalId: input.principalId,
    grants: grantsToAdd,
    grantedByUserId: input.grantedByUserId,
  });

  if (keysToRemove.length > 0) {
    await db
      .delete(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, input.companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, input.principalId),
          inArray(principalPermissionGrants.permissionKey, keysToRemove),
        ),
      );
  }

  return {
    addedKeys: grantsToAdd.map((grant) => grant.permissionKey),
    removedKeys: keysToRemove,
  };
}

export async function backfillPrincipalAccessCompatibility(
  db: Db,
): Promise<PrincipalAccessCompatibilityBackfillStats> {
  const now = new Date();
  const nonTerminalAgents = await db
    .select({
      companyId: agents.companyId,
      principalId: agents.id,
    })
    .from(agents)
    .where(notInArray(agents.status, ["pending_approval", "terminated"]));

  const agentMembershipsInserted = nonTerminalAgents.length > 0
    ? await db
      .insert(companyMemberships)
      .values(
        nonTerminalAgents.map((agent) => ({
          companyId: agent.companyId,
          principalType: "agent",
          principalId: agent.principalId,
          status: "active",
          membershipRole: "member",
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing({
        target: [
          companyMemberships.companyId,
          companyMemberships.principalType,
          companyMemberships.principalId,
        ],
      })
      .returning({ id: companyMemberships.id })
      .then((rows) => rows.length)
    : 0;

  const activeHumanMemberships = await db
    .select({
      companyId: companyMemberships.companyId,
      principalId: companyMemberships.principalId,
      membershipRole: companyMemberships.membershipRole,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    );

  let humanGrantsInserted = 0;
  for (const membership of activeHumanMemberships) {
    humanGrantsInserted += await ensureHumanRoleDefaultGrants(db, {
      companyId: membership.companyId,
      principalId: membership.principalId,
      membershipRole: membership.membershipRole,
      grantedByUserId: null,
    });
  }

  return {
    agentMembershipsInserted,
    humanGrantsInserted,
  };
}
