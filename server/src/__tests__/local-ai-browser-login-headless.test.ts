import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalBrowserLogin } from "../services/local-ai-browser-login.js";

// Simulated provider CLI: a fake `claude` on PATH. This proves the server's PTY
// bridge + prompt parsing + failure states on a headless host. It is NOT a real
// provider sign-in; the output shape mirrors a captured Claude Code 2.1.330 run
// with a synthetic opaque token.
const OPAQUE = "https://claude.ai/oauth/authorize?Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3";
const dirs: string[] = [];
const originalPath = process.env.PATH;
afterEach(async () => { process.env.PATH = originalPath; await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function fakeClaude(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "fake-claude-"));
  dirs.push(dir);
  await writeFile(join(dir, "claude"), `#!/bin/sh\n${body}\n`);
  await chmod(join(dir, "claude"), 0o755);
  process.env.PATH = `${dir}:${originalPath}`;
  return dir;
}
async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise(r => setTimeout(r, 50)); }
}

describe("local Claude browser login on a headless host", () => {
  it("surfaces the opaque-query authorization URL without a browser", async () => {
    await fakeClaude(`printf "Browser didn't open? Use the URL below to sign in (c to copy)\\r\\n\\r\\n\\033]8;;${OPAQUE}\\007${OPAQUE}\\033]8;;\\007\\r\\n\\r\\nPaste code here if prompted\\r\\n"; sleep 30`);
    const home = await mkdtemp(join(tmpdir(), "login-home-")); dirs.push(home);
    const state = startLocalBrowserLogin("anthropic", home);
    try {
      await until(() => Boolean(state.authorizationUrl));
      expect(state.authorizationUrl).toBe(OPAQUE);
      expect(state.outcome).toBeUndefined();
    } finally { state.abort(); }
  });

  it("fails fast with an explicit error when no sign-in link is produced", async () => {
    await fakeClaude(`printf "Welcome\\r\\n"; sleep 30`);
    const home = await mkdtemp(join(tmpdir(), "login-home-")); dirs.push(home);
    const state = startLocalBrowserLogin("anthropic", home, { promptTimeoutMs: 400 });
    await until(() => state.outcome === "failure");
    expect(state.authorizationUrl).toBeUndefined();
    expect(state.error).toMatch(/did not produce a sign-in link/);
  });

  it("reports an explicit error when the CLI exits before a link", async () => {
    await fakeClaude(`exit 1`);
    const home = await mkdtemp(join(tmpdir(), "login-home-")); dirs.push(home);
    const state = startLocalBrowserLogin("anthropic", home);
    await until(() => state.outcome === "failure");
    expect(state.error).toMatch(/before a sign-in link/);
  });
});
