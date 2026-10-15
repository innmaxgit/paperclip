import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maybeEnableUiDevMiddleware } from "../commands/ui-dev-middleware.js";

describe("maybeEnableUiDevMiddleware", () => {
  let root: string;
  let entry: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ui-dev-"));
    fs.mkdirSync(path.join(root, "server/src"), { recursive: true });
    entry = path.join(root, "server/src/index.ts");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeBuiltUi() {
    fs.mkdirSync(path.join(root, "ui/dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "ui/dist/index.html"), "<html></html>");
  }

  it("enables Vite for a source checkout without a built UI", () => {
    const env: NodeJS.ProcessEnv = {};
    maybeEnableUiDevMiddleware(entry, env);
    expect(env.PAPERCLIP_UI_DEV_MIDDLEWARE).toBe("true");
  });

  it("serves the built UI when ui/dist exists", () => {
    writeBuiltUi();
    const env: NodeJS.ProcessEnv = {};
    maybeEnableUiDevMiddleware(entry, env);
    expect(env.PAPERCLIP_UI_DEV_MIDDLEWARE).toBeUndefined();
  });

  it("never enables Vite when NODE_ENV is production", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    maybeEnableUiDevMiddleware(entry, env);
    expect(env.PAPERCLIP_UI_DEV_MIDDLEWARE).toBeUndefined();
  });

  it("respects an explicit setting", () => {
    writeBuiltUi();
    const env: NodeJS.ProcessEnv = { PAPERCLIP_UI_DEV_MIDDLEWARE: "true" };
    maybeEnableUiDevMiddleware(entry, env);
    expect(env.PAPERCLIP_UI_DEV_MIDDLEWARE).toBe("true");
  });

  it("ignores non-source entrypoints", () => {
    const env: NodeJS.ProcessEnv = {};
    maybeEnableUiDevMiddleware("@paperclipai/server", env);
    expect(env.PAPERCLIP_UI_DEV_MIDDLEWARE).toBeUndefined();
  });
});
