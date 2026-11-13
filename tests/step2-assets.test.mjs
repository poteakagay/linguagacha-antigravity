import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PLUGIN = path.join(ROOT, "plugins", "linguagacha");

function walkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}

test("Step 2.1: plugin.json manifest has valid schema and required fields", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, "plugin.json"), "utf8"));
  assert.equal(manifest.name, "linguagacha");
  assert.equal(manifest.suggestedPrompts.length, 3);
  assert.ok(fs.existsSync(path.join(PLUGIN, manifest.logo)), "logo asset must exist");
});

test("Step 2.2: rules/AGENTS.md preserves 100% verbatim system.md + personality.md + charter", () => {
  const agentsMd = fs.readFileSync(path.join(PLUGIN, "rules", "AGENTS.md"), "utf8");
  const sys = fs.readFileSync(path.join(PLUGIN, "presets", "agent", "system.md"), "utf8").trim();
  const pers = fs.readFileSync(path.join(PLUGIN, "presets", "agent", "personality.md"), "utf8").trim();
  const expectedCore = sys.replace("{{agent_personality}}", () => pers);
  assert.ok(agentsMd.startsWith(expectedCore), "AGENTS.md must start with verbatim merged system + personality");
  assert.ok(agentsMd.includes("自称「我」「人家」，中文称呼用户为「搭档」"));
  assert.ok(agentsMd.includes("反重力（Antigravity）宿主环境工具映射附录"));
});

test("Step 2.3: all 23 upstream skill packages (agent-charter + 22 domain/format skills) have valid frontmatter & syntax-valid .mjs scripts", () => {
  const skillDirs = fs.readdirSync(path.join(PLUGIN, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.equal(skillDirs.length, 23);

  let mjsCount = 0;
  for (const dir of skillDirs) {
    const skillMdPath = path.join(PLUGIN, "skills", dir.name, "SKILL.md");
    assert.ok(fs.existsSync(skillMdPath), `Missing SKILL.md in ${dir.name}`);
    const content = fs.readFileSync(skillMdPath, "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(match, `Invalid YAML frontmatter in ${dir.name}/SKILL.md`);
    assert.ok(match[1].includes(`name: ${dir.name}`), `Mismatched skill name in ${dir.name}/SKILL.md`);
    assert.ok(match[1].includes("description:"), `Missing description in ${dir.name}/SKILL.md`);

    for (const file of walkFiles(path.join(PLUGIN, "skills", dir.name))) {
      if (file.endsWith(".mjs")) {
        execFileSync(process.execPath, ["--check", file]);
        mjsCount++;
      }
    }
  }
  assert.ok(mjsCount > 0, "Expected at least one .mjs skill script to be syntax-checked");
});

test("Step 2.4: all preset JSON and prompt TXT templates are intact and valid", () => {
  const presetFiles = walkFiles(path.join(PLUGIN, "presets"));
  let jsonCount = 0;
  let txtCount = 0;
  for (const file of presetFiles) {
    if (file.endsWith(".json")) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.ok(parsed !== null && typeof parsed === "object");
      jsonCount++;
    } else if (file.endsWith(".txt")) {
      const txt = fs.readFileSync(file, "utf8");
      assert.ok(txt.length > 0, `Empty template file: ${file}`);
      txtCount++;
    }
  }
  assert.ok(jsonCount >= 10, `Expected >= 10 preset JSON files, got ${jsonCount}`);
  assert.ok(txtCount >= 8, `Expected >= 8 prompt TXT files, got ${txtCount}`);
});
