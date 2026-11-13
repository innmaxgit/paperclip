import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverProjectSkills, syncProjectSkills } from "./project-skills.js";

let root: string;
const logs: string[] = [];
const onLog = async (_s: "stdout" | "stderr", c: string) => { logs.push(c); };

async function skill(dir: string, name: string, body = name) {
  await fs.mkdir(path.join(dir, name), { recursive: true });
  await fs.writeFile(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n${body}\n`);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "project-skills-"));
  logs.length = 0;
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("project skills", () => {
  it("discovers real directories and symlinks from both sources", async () => {
    await skill(path.join(root, ".agents/skills"), "pm-responsibility");
    await skill(path.join(root, ".claude/skills"), "openspec-explore");
    await fs.symlink("../../.agents/skills/pm-responsibility", path.join(root, ".claude/skills/linked"));
    const found = await discoverProjectSkills(root);
    expect(found.entries.map((e) => e.name).sort()).toEqual(["linked", "openspec-explore", "pm-responsibility"]);
    const linked = found.entries.find((e) => e.name === "linked")!;
    expect(linked.source).toBe(await fs.realpath(path.join(root, ".agents/skills/pm-responsibility")));
  });

  it("prefers .claude/skills over .agents/skills for the same name", async () => {
    await skill(path.join(root, ".claude/skills"), "dup", "from-claude");
    await skill(path.join(root, ".agents/skills"), "dup", "from-agents");
    const found = await discoverProjectSkills(root);
    expect(found.entries).toHaveLength(1);
    expect(found.entries[0]!.origin).toBe(".claude/skills");
    expect(found.shadowed).toEqual([{ name: "dup", origin: ".agents/skills", winner: ".claude/skills" }]);
  });

  it("skips symlinks that escape the project, broken links and dirs without SKILL.md", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
    await skill(outside, "secret");
    await fs.mkdir(path.join(root, ".agents/skills"), { recursive: true });
    await fs.symlink(path.join(outside, "secret"), path.join(root, ".agents/skills/escape"));
    await fs.symlink("../nope", path.join(root, ".agents/skills/broken"));
    await fs.mkdir(path.join(root, ".agents/skills/empty"));
    const found = await discoverProjectSkills(root);
    expect(found.entries).toEqual([]);
    expect(found.skipped.map((s) => s.reason).sort()).toEqual(["broken symlink", "no SKILL.md", "resolves outside the project"]);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("syncs only skill directories, overrides user skills, and is repeatable", async () => {
    await skill(path.join(root, ".agents/skills"), "pm-responsibility", "project");
    await fs.writeFile(path.join(root, ".agents/skills/.openspec-target"), "x");
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.writeFile(path.join(root, ".claude/settings.local.json"), "{\"secret\":1}");
    const home = path.join(root, "home");
    await skill(path.join(home, "skills"), "pm-responsibility", "user");
    await fs.writeFile(path.join(home, ".credentials.json"), "token");
    for (let i = 0; i < 2; i += 1) {
      const synced = await syncProjectSkills({ projectRoot: root, skillsDir: path.join(home, "skills"), onLog, label: "test" });
      expect(synced).toEqual(["pm-responsibility"]);
    }
    expect(await fs.readFile(path.join(home, "skills/pm-responsibility/SKILL.md"), "utf8")).toContain("project");
    expect((await fs.readdir(path.join(home, "skills"))).sort()).toEqual(["pm-responsibility"]);
    expect(await fs.readFile(path.join(home, ".credentials.json"), "utf8")).toBe("token");
  });

  it("restricts sync to the requested origins", async () => {
    await skill(path.join(root, ".claude/skills"), "a");
    await skill(path.join(root, ".agents/skills"), "b");
    const out = path.join(root, "out");
    expect(await syncProjectSkills({ projectRoot: root, skillsDir: out, origins: [".agents/skills"], onLog, label: "t" })).toEqual(["b"]);
  });
});
