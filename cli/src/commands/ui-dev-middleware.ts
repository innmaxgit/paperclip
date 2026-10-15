import fs from "node:fs";
import path from "node:path";

/**
 * Decide whether a source-checkout server start should embed the Vite dev
 * server. Vite (rolldown, tailwind oxide, file watcher, HMR port) adds several
 * GB of RSS, so it is only enabled when there is no built UI to serve and the
 * process is not marked as production. An explicit
 * PAPERCLIP_UI_DEV_MIDDLEWARE value always wins.
 */
export function maybeEnableUiDevMiddleware(
  entrypoint: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.PAPERCLIP_UI_DEV_MIDDLEWARE !== undefined) return;
  const normalized = entrypoint.replaceAll("\\", "/");
  const isSourceEntry =
    normalized.endsWith("/server/src/index.ts") || normalized.endsWith("@paperclipai/server/src/index.ts");
  if (!isSourceEntry) return;
  if (env.NODE_ENV === "production") return;
  const builtUiIndex = path.resolve(path.dirname(entrypoint), "../../ui/dist/index.html");
  if (fs.existsSync(builtUiIndex)) return;
  env.PAPERCLIP_UI_DEV_MIDDLEWARE = "true";
}
