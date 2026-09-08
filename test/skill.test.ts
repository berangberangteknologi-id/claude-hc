import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skillPath = join(__dirname, "..", "hermes", "skills", "claude-hc", "SKILL.md");

test("SKILL.md has the required frontmatter", () => {
  const text = readFileSync(skillPath, "utf8");
  assert.ok(text.startsWith("---\n"));
  const end = text.indexOf("\n---\n", 4);
  assert.ok(end > 0, "frontmatter must be closed");
  const front = text.slice(4, end);
  assert.match(front, /^name: claude-hc$/m);
  assert.match(front, /^description: .+/m);
  assert.match(front, /^version: 1\.0\.0$/m);
  assert.match(front, /^\s+tags: \[.*Kanban.*\]$/m);
  assert.match(front, /^\s+related_skills: \[claude-code, hermes-agent\]$/m);
  assert.match(front, /^\s+requires_tools: \[terminal\]$/m);
});

test("SKILL.md has every section the design requires, in order", () => {
  const text = readFileSync(skillPath, "utf8");
  const headings = [
    "## When to use",
    "## Prerequisites",
    "## Contract cheat sheet",
    "## Procedure A: Kanban worker",
    "## Procedure B: chat relay",
    "## Answer-or-relay rule",
    "## Prompt hint",
    "## Pitfalls",
    "## Verification",
  ];
  let last = -1;
  for (const h of headings) {
    const idx = text.indexOf(`\n${h}\n`);
    assert.ok(idx > last, `missing or out of order: ${h}`);
    last = idx;
  }
});

test("SKILL.md never passes a shell variable as workdir and never uses pty", () => {
  const text = readFileSync(skillPath, "utf8");
  assert.doesNotMatch(text, /workdir="\$/);
  assert.doesNotMatch(text, /pty=true/);
  assert.ok(text.includes("process_manage"));
  assert.ok(text.includes("--json"));
  assert.ok(text.includes("kind=\"needs_input\""));
});
