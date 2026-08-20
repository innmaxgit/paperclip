import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import type { PermissionKey, PermissionEscalationContact } from "@paperclipai/shared";

/**
 * Who a member should ask when they hit a "missing permission" wall.
 *
 * Two sources, unioned: company owners (who can always re-grant) and anyone
 * already holding `users:manage_permissions`. Names and emails here are no
 * wider a disclosure than `GET /companies/:companyId/user-directory`, which any
 * company member can already read.
 */
export async function listPermissionEscalationContacts(
  db: Db,
  companyId: string,
): Promise<PermissionEscalationContact[]> {
  const grantKey: PermissionKey = "users:manage_permissions";

  const [memberships, grants] = await Promise.all([
    db
      .select({
        principalId: companyMemberships.principalId,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      ),
    db
      .select({ principalId: principalPermissionGrants.principalId })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.permissionKey, grantKey),
        ),
      ),
  ]);

  const canManagePermissions = new Set(grants.map((grant) => grant.principalId));
  const candidates = memberships.filter(
    (membership) =>
      membership.membershipRole === "owner" || canManagePermissions.has(membership.principalId),
  );
  if (candidates.length === 0) return [];

  const profiles = await db
    .select({
      id: authUsers.id,
      name: authUsers.name,
      email: authUsers.email,
    })
    .from(authUsers)
    .where(inArray(authUsers.id, candidates.map((candidate) => candidate.principalId)))
    .then((rows) => new Map(rows.map((row) => [row.id, row])));

  return candidates
    .map((candidate) => {
      const profile = profiles.get(candidate.principalId);
      return {
        userId: candidate.principalId,
        name: profile?.name ?? null,
        email: profile?.email ?? null,
        membershipRole: candidate.membershipRole ?? null,
        isCompanyOwner: candidate.membershipRole === "owner",
        canManagePermissions: canManagePermissions.has(candidate.principalId),
      } satisfies PermissionEscalationContact;
    })
    // Owners first, then permission managers, then a stable tiebreak so the UI
    // renders the same order on every fetch.
    .sort((left, right) => {
      if (left.isCompanyOwner !== right.isCompanyOwner) return left.isCompanyOwner ? -1 : 1;
      return (left.name ?? left.email ?? left.userId).localeCompare(
        right.name ?? right.email ?? right.userId,
      );
    });
}
