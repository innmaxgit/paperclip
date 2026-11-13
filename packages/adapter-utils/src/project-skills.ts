import fs from "node:fs/promises";
import path from "node:path";
import { materializePaperclipSkillCopy } from "./server-utils.js";

/**
 * Project skill sources in precedence order. When the same skill name exists
 * in more than one source, the first source wins (`.claude/skills` is the
 * Claude-native location; `.agents/skills` is the cross-tool/Codex location).
 */
export const PROJECT_SKILL_SOURCE_DIRS = [".claude/skills", ".agents/skills"] as const;

export interface ProjectSkillEntry {
  name: string;
  /** Real (symlink-resolved) directory that holds SKILL.md. */
  source: string;
  origin: (typeof PROJECT_SKILL_SOURCE_DIRS)[number];
}

export interface ProjectSkillDiscovery {
  entries: ProjectSkillEntry[];
  /** Same-name skills hidden by a higher-precedence source. */
  shadowed: Array<{ name: string; origin: string; winner: string }>;
  /** Candidates ignored, with the reason (no SKILL.md, escapes project, ...). */
  skipped: Array<{ name: string; origin: string; reason: string }>;
}

const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Find project skills under `<projectRoot>/.claude/skills` and
 * `<projectRoot>/.agents/skills`. Symlinks are resolved to their real source,
 * which must stay inside the project so a crafted link cannot pull unrelated
 * host directories into a run.
 */
export async function discoverProjectSkills(projectRoot: string): Promise<ProjectSkillDiscovery> {
  const result: ProjectSkillDiscovery = { entries: [], shadowed: [], skipped: [] };
  const realRoot = await fs.realpath(projectRoot).catch(() => null);
  if (!realRoot) return result;
  const winners = new Map<string, { origin: string; source: string }>();
  for (const origin of PROJECT_SKILL_SOURCE_DIRS) {
    const dirents = await fs.readdir(path.join(realRoot, origin), { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = dirent.name;
      if (name.startsWith(".")) continue;
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
      if (!SAFE_SKILL_NAME.test(name)) {
        result.skipped.push({ name, origin, reason: "invalid skill name" });
        continue;
      }
      const real = await fs.realpath(path.join(realRoot, origin, name)).catch(() => null);
      if (!real) {
        result.skipped.push({ name, origin, reason: "broken symlink" });
        continue;
      }
      if (!isWithin(realRoot, real)) {
        result.skipped.push({ name, origin, reason: "resolves outside the project" });
        continue;
      }
      const stat = await fs.stat(path.join(real, "SKILL.md")).catch(() => null);
      if (!stat?.isFile()) {
        result.skipped.push({ name, origin, reason: "no SKILL.md" });
        continue;
      }
      const winner = winners.get(name);
      if (winner) {
        // A `.claude/skills/x -> ../../.agents/skills/x` link is one skill, not a conflict.
        if (winner.source !== real) result.shadowed.push({ name, origin, winner: winner.origin });
        continue;
      }
      winners.set(name, { origin, source: real });
      result.entries.push({ name, source: real, origin });
    }
  }
  return result;
}

export interface SyncProjectSkillsInput {
  projectRoot: string;
  /** Destination skills directory (e.g. `$CLAUDE_CONFIG_DIR/skills`). */
  skillsDir: string;
  /** Only sync skills from these sources (default: all). */
  origins?: readonly ProjectSkillEntry["origin"][];
  /**
   * Skip skills whose real source lives under this project-relative directory
   * (e.g. `.agents/skills` for Codex, which already discovers it natively and
   * would otherwise list a symlinked skill twice).
   */
  excludeSourceUnder?: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  label: string;
}

/**
 * Copy discovered project skills into `skillsDir`. Only skill directories are
 * copied (never settings, credentials or other project files). Existing
 * same-name entries are replaced, so project skills take precedence over
 * user-level skills and a leftover from an earlier run cannot go stale.
 */
export async function syncProjectSkills(input: SyncProjectSkillsInput): Promise<string[]> {
  const discovery = await discoverProjectSkills(input.projectRoot);
  await fs.mkdir(input.skillsDir, { recursive: true });
  const synced: string[] = [];
  const excludeRoot = input.excludeSourceUnder
    ? await fs.realpath(path.join(input.projectRoot, input.excludeSourceUnder)).catch(() => null)
    : null;
  for (const entry of discovery.entries) {
    if (excludeRoot && isWithin(excludeRoot, entry.source)) continue;
    if (input.origins && !input.origins.includes(entry.origin)) continue;
    const target = path.join(input.skillsDir, entry.name);
    try {
      await fs.rm(target, { recursive: true, force: true });
      await materializePaperclipSkillCopy(entry.source, target);
      synced.push(entry.name);
    } catch (err) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      await input.onLog(
        "stderr",
        `[paperclip] Failed to sync project skill "${entry.name}" (${entry.origin}) for ${input.label}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  for (const item of discovery.skipped) {
    await input.onLog("stderr", `[paperclip] Skipped project skill "${item.name}" in ${item.origin}: ${item.reason}\n`);
  }
  for (const item of discovery.shadowed) {
    await input.onLog("stdout", `[paperclip] Project skill "${item.name}" in ${item.origin} is shadowed by ${item.winner}\n`);
  }
  if (synced.length > 0) {
    await input.onLog(
      "stdout",
      `[paperclip] Synced ${synced.length} project skill(s) into ${input.skillsDir} for ${input.label}: ${synced.sort().join(", ")}\n`,
    );
  }
  return synced.sort();
}
