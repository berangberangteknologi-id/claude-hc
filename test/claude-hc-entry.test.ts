// Black-box process-level tests for the real, compiled entry point
// (dist/claude-hc.js). Unlike cli.test.ts and run.test.ts, which exercise
// main()/runTurn() in-process against fakes, this spawns the actual built
// binary as a child process so the re-exec guard, the signal-safe finish()
// flush, and (after the --json exception fix) the exception-to-JSON path
// are all exercised at the real process boundary.
//
// Requires `npm run build` to have run first. In a fresh checkout (no
// dist/) these tests skip rather than fail, so `npm test` alone still
// passes before the first build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const BIN = path.join(__dirname, "..", "dist", "claude-hc.js");
const SKIP_REASON = "dist/claude-hc.js not built yet — run `npm run build` first";
const skip = !existsSync(BIN) && SKIP_REASON;

function freshHome(): string {
  return mkdtempSync(path.join(tmpdir(), "claude-hc-entry-"));
}

function run(args: string[], input = ""): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    input,
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, CLAUDE_HC_HOME: freshHome() },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("entry: --json with empty stdin exits 1 with a usage JSON line", { skip }, () => {
  const { code, stdout } = run(["--json"], "");
  assert.equal(code, 1);
  const lines = stdout.trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.error.code, "usage");
});

test("entry: status on a fresh session id exits 0 with in_flight false and last null", { skip }, () => {
  const { code, stdout } = run(["status", "some-fresh-id"]);
  assert.equal(code, 0);
  const lines = stdout.trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.in_flight, false);
  assert.equal(last.last, null);
});

test("entry: --help exits 0 and prints usage text", { skip }, () => {
  const { code, stdout } = run(["--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("USAGE:"));
});
