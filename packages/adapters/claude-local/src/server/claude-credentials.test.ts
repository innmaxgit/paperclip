import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CREDENTIALS_FILENAME,
  IMPLAUSIBLE_EXPIRY_EXIT,
  KEEP_DESTINATION_EXIT,
  MAX_PLAUSIBLE_EXPIRY_MS,
  UNREADABLE_EXPIRY_EXIT,
  USE_SOURCE_EXIT,
  claudeCredentialAccessToken,
  decideClaudeAuthMerge,
  decideClaudeAuthMergeFiles,
  isRenewableClaudeCredential,
  parseClaudeOauthCredential,
} from "./claude-credentials.js";

const NOW = Date.UTC(2026, 9, 20, 12);
const credential = (input: { marker: string; expiresAt?: number | null; refreshToken?: string | null }) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `access-${input.marker}`,
      ...(input.refreshToken === null ? {} : { refreshToken: input.refreshToken ?? `refresh-${input.marker}` }),
      ...(input.expiresAt === null ? {} : { expiresAt: input.expiresAt ?? NOW + 36e5 }),
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
    },
  });

describe("stored Claude subscription credential", () => {
  const directories: string[] = [];
  afterEach(async () => {
    while (directories.length) await rm(directories.pop()!, { recursive: true, force: true }).catch(() => undefined);
  });

  it("reads a bearer token out of either accepted form and rejects neither-form values", () => {
    expect(claudeCredentialAccessToken(credential({ marker: "a" }))).toBe("access-a");
    expect(claudeCredentialAccessToken("sk-ant-oat01-bare")).toBe("sk-ant-oat01-bare");
    // A JSON payload that does not parse is a broken credential, not a token.
    expect(claudeCredentialAccessToken('{"claudeAiOauth":')).toBeNull();
    expect(claudeCredentialAccessToken(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBeNull();
    expect(claudeCredentialAccessToken("  ")).toBeNull();
  });

  it("treats only a payload carrying a refresh token as renewable", () => {
    expect(isRenewableClaudeCredential(credential({ marker: "a" }))).toBe(true);
    expect(isRenewableClaudeCredential(credential({ marker: "a", refreshToken: null }))).toBe(false);
    expect(isRenewableClaudeCredential(credential({ marker: "a", refreshToken: "   " }))).toBe(false);
    expect(isRenewableClaudeCredential("sk-ant-oat01-bare")).toBe(false);
    expect(parseClaudeOauthCredential(credential({ marker: "a" }))).toEqual({
      accessToken: "access-a", refreshToken: "refresh-a", expiresAt: NOW + 36e5,
    });
  });

  it("installs only a strictly fresher renewable source", () => {
    const parse = (raw: string) => parseClaudeOauthCredential(raw);
    const stored = parse(credential({ marker: "stored", expiresAt: NOW + 36e5 }))!;
    expect(decideClaudeAuthMerge(parse(credential({ marker: "refreshed", expiresAt: NOW + 72e5 })), stored, NOW))
      .toBe(USE_SOURCE_EXIT);
    // A tie or an older source keeps the stored credential, so a spent
    // refresh token never lands on top of a good one.
    expect(decideClaudeAuthMerge(parse(credential({ marker: "same", expiresAt: NOW + 36e5 })), stored, NOW))
      .toBe(KEEP_DESTINATION_EXIT);
    expect(decideClaudeAuthMerge(parse(credential({ marker: "older", expiresAt: NOW + 18e5 })), stored, NOW))
      .toBe(KEEP_DESTINATION_EXIT);
  });

  it("fails closed on a snapshot, an unreadable expiry, or an implausible expiry", () => {
    const parse = (raw: string) => parseClaudeOauthCredential(raw);
    const stored = parse(credential({ marker: "stored", expiresAt: NOW + 36e5 }))!;
    const fresher = credential({ marker: "refreshed", expiresAt: NOW + 72e5 });
    expect(decideClaudeAuthMerge(null, stored, NOW)).toBe(KEEP_DESTINATION_EXIT);
    expect(decideClaudeAuthMerge(parse(fresher), null, NOW)).toBe(KEEP_DESTINATION_EXIT);
    expect(decideClaudeAuthMerge(parse(credential({ marker: "snapshot", refreshToken: null, expiresAt: NOW + 72e5 })), stored, NOW))
      .toBe(KEEP_DESTINATION_EXIT);
    expect(decideClaudeAuthMerge(parse(credential({ marker: "undated", expiresAt: null })), stored, NOW))
      .toBe(UNREADABLE_EXPIRY_EXIT);
    expect(decideClaudeAuthMerge(parse(fresher), parse(credential({ marker: "undated", expiresAt: null })), NOW))
      .toBe(UNREADABLE_EXPIRY_EXIT);
    // Exactly at the bound is still plausible; one millisecond past it is not.
    expect(decideClaudeAuthMerge(parse(credential({ marker: "edge", expiresAt: NOW + MAX_PLAUSIBLE_EXPIRY_MS })), stored, NOW))
      .toBe(USE_SOURCE_EXIT);
    expect(decideClaudeAuthMerge(parse(credential({ marker: "forged", expiresAt: NOW + MAX_PLAUSIBLE_EXPIRY_MS + 1 })), stored, NOW))
      .toBe(IMPLAUSIBLE_EXPIRY_EXIT);
  });

  it("decides over two credential files and treats an unreadable file as unusable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "claude-credential-merge-"));
    directories.push(directory);
    const source = path.join(directory, CLAUDE_CREDENTIALS_FILENAME);
    const destination = path.join(directory, "current-auth.json");
    await writeFile(destination, credential({ marker: "stored", expiresAt: Date.now() + 36e5 }));
    await expect(decideClaudeAuthMergeFiles(source, destination)).resolves.toBe(KEEP_DESTINATION_EXIT);
    await writeFile(source, credential({ marker: "refreshed", expiresAt: Date.now() + 72e5 }));
    await expect(decideClaudeAuthMergeFiles(source, destination)).resolves.toBe(USE_SOURCE_EXIT);
  });
});
