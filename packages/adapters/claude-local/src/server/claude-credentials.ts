import fs from "node:fs/promises";

/**
 * The file the Claude CLI reads inside a `CLAUDE_CONFIG_DIR`, and the file it
 * rewrites in place every time it renews an expiring OAuth session.
 */
export const CLAUDE_CREDENTIALS_FILENAME = ".credentials.json";
/** The legacy filename some older CLI versions wrote. */
export const CLAUDE_LEGACY_CREDENTIALS_FILENAME = "credentials.json";

export interface ClaudeOauthCredential {
  accessToken: string;
  /** Present only when the login stored a renewable credential. */
  refreshToken: string | null;
  /** Epoch milliseconds, when the credential records one. */
  expiresAt: number | null;
}

/**
 * Parse one `.credentials.json` payload. Returns null for anything that is not
 * a usable `claudeAiOauth` record, so a caller can fall through to its next
 * credential source instead of carrying a half-parsed shape around.
 */
export function parseClaudeOauthCredential(raw: string): ClaudeOauthCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) return null;
  const record = oauth as Record<string, unknown>;
  const accessToken = record.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  const refreshToken = record.refreshToken;
  const expiresAt = record.expiresAt;
  return {
    accessToken,
    refreshToken:
      typeof refreshToken === "string" && refreshToken.trim().length > 0 ? refreshToken : null,
    expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

/**
 * A stored Claude subscription credential is either a whole
 * `.credentials.json` payload — the renewable form — or a bare access token,
 * the snapshot form earlier Paperclip versions saved and the only form a macOS
 * Keychain login or a `setup-token` login can produce. Every consumer that
 * needs a bearer token reads it through here so the two forms never have to be
 * told apart at the call site.
 */
export function claudeCredentialAccessToken(value: string): string | null {
  const parsed = parseClaudeOauthCredential(value);
  if (parsed) return parsed.accessToken;
  const token = value.trim();
  // A JSON payload that failed to parse is a broken credential, never a token.
  return token.length > 0 && !token.startsWith("{") ? token : null;
}

/**
 * True when the stored credential carries the refresh token the CLI needs to
 * renew the session itself. Only such a credential is worth writing into a run
 * as a credentials file; a snapshot has nothing to renew with.
 */
export function isRenewableClaudeCredential(value: string): boolean {
  return Boolean(parseClaudeOauthCredential(value)?.refreshToken);
}

/** Exit code: install the source credential over the destination. */
export const USE_SOURCE_EXIT = 10;
/** Exit code: keep the destination credential. */
export const KEEP_DESTINATION_EXIT = 20;
/** Exit code: keep the destination; an expiry was missing or unreadable. */
export const UNREADABLE_EXPIRY_EXIT = 21;
/** Exit code: keep the destination; the source expiry was implausibly far ahead. */
export const IMPLAUSIBLE_EXPIRY_EXIT = 22;

// A Claude OAuth session lasts hours, so an expiry that sits further ahead than
// this cannot have come from an honest refresh. The bound matches the Grok
// predicate's so the two providers fail the same way on a poisoned expiry.
export const MAX_PLAUSIBLE_EXPIRY_MS = 400 * 24 * 60 * 60 * 1000;

/**
 * Decide whether to replace the `destination` credential with the `source`
 * one, where source and destination are set purely by argument order, as in
 * `decideCodexAuthMerge` and `decideGrokAuthMerge`. The three predicates share
 * one exit-code contract so the write-back call site reads the same for every
 * provider; this one runs in process because the Claude credential has no
 * sandbox copy-out path that would need a standalone script.
 *
 * Guard order, first match wins:
 *   1. Either side is not a renewable credential -> KEEP_DESTINATION. A
 *      snapshot has no refresh token, so it can only ever be staler than the
 *      renewable copy it would overwrite.
 *   2. Either side has no readable `expiresAt` -> UNREADABLE_EXPIRY. Without
 *      both expiries there is no freshness to compare.
 *   3. The source expiry sits further ahead of `nowMs` than
 *      MAX_PLAUSIBLE_EXPIRY_MS -> IMPLAUSIBLE_EXPIRY. Only the source is
 *      bounded, and only against the caller's clock: the source is the side
 *      the run produced, so it must never supply the reference time.
 *   4. The source expiry is strictly later -> USE_SOURCE.
 *   5. Otherwise (a tie, or an older source) -> KEEP_DESTINATION, so a spent
 *      refresh token is never written over a good one.
 *
 * Unlike the Codex and Grok payloads, `.credentials.json` carries no account
 * identifier, so this predicate cannot also check that both sides describe the
 * same account. A run that signs the CLI into a different Claude account inside
 * its own managed home would therefore write that account's credential back to
 * the grant. The provider home is created per run and seeded only from the
 * stored credential, so this needs a deliberate in-run `claude auth login`.
 */
export function decideClaudeAuthMerge(
  source: ClaudeOauthCredential | null,
  destination: ClaudeOauthCredential | null,
  nowMs: number,
): number {
  if (!source?.refreshToken || !destination?.refreshToken) return KEEP_DESTINATION_EXIT;
  if (source.expiresAt === null || destination.expiresAt === null) return UNREADABLE_EXPIRY_EXIT;
  if (source.expiresAt - nowMs > MAX_PLAUSIBLE_EXPIRY_MS) return IMPLAUSIBLE_EXPIRY_EXIT;
  return source.expiresAt > destination.expiresAt ? USE_SOURCE_EXIT : KEEP_DESTINATION_EXIT;
}

async function readCredentialFile(filePath: string): Promise<ClaudeOauthCredential | null> {
  try {
    return parseClaudeOauthCredential(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** Run the merge decision over two credential files. Unreadable is unusable. */
export async function decideClaudeAuthMergeFiles(
  sourcePath: string,
  destinationPath: string,
): Promise<number> {
  const [source, destination] = await Promise.all([
    readCredentialFile(sourcePath),
    readCredentialFile(destinationPath),
  ]);
  return decideClaudeAuthMerge(source, destination, Date.now());
}
