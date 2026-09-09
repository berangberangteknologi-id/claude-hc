import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_ALLOWED_TOOLS, main, parseArgs } from "../src/cli.js";
import type { MainDeps } from "../src/cli.js";
import { SessionStore } from "../src/session-store.js";
import { askInput, makeFakeQuery } from "./helpers/fake-query.js";
import type { FakeStep } from "./helpers/fake-query.js";

/**
 * A SessionStore rooted at a *file* (not a directory) so any attempt to
 * create a session directory under it fails with a real, deterministic,
 * cross-platform ENOTDIR — exercising the same "filesystem error escapes
 * runTurn's lock acquisition" path as a broken CLAUDE_HC_HOME in production,
 * without depending on a platform-specific path like /dev/null/nope.
 */
function brokenHomeStore(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "claude-hc-cli-broken-"));
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x");
  return new SessionStore(blocker);
}

function deps(steps: FakeStep[] = [], stdin = ""): MainDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    query: makeFakeQuery(steps).query,
    store: new SessionStore(mkdtempSync(join(tmpdir(), "claude-hc-cli-"))),
    stdout: (c) => out.push(c),
    stderr: (c) => err.push(c),
    readStdin: async () => stdin,
    defaultCwd: () => "/tmp",
    isDirectory: (p) => p === "/tmp" || p === "/tmp/repo",
    version: "0.4.0-test",
    now: () => new Date("2026-09-08T00:00:00.000Z"),
    out,
    err,
  };
}

test("parseArgs: turn with flags", () => {
  const a = parseArgs(["do", "it", "-r", "abc", "--json", "--cwd", "/tmp/repo", "--allowed-tools", "Read, Edit", "--model", "m", "--max-turns", "5"]);
  assert.equal(a.command, "turn");
  assert.equal(a.prompt, "do it");
  assert.equal(a.resumeId, "abc");
  assert.equal(a.json, true);
  assert.equal(a.cwd, "/tmp/repo");
  assert.deepEqual(a.allowedTools, ["Read", "Edit"]);
  assert.equal(a.model, "m");
  assert.equal(a.maxTurns, 5);
  assert.deepEqual(a.errors, []);
});

test("parseArgs: defaults and help", () => {
  const a = parseArgs([]);
  assert.equal(a.command, "turn");
  assert.equal(a.prompt, undefined);
  assert.deepEqual(a.allowedTools, DEFAULT_ALLOWED_TOOLS);
  assert.equal(a.json, false);
  assert.equal(parseArgs(["--help"]).command, "help");
  assert.equal(parseArgs(["-h"]).command, "help");
});

test("default allowed tools include mcp__* so already-connected MCP servers work without extra flags", () => {
  // Found via a real end-to-end Hermes-driven run: an MCP server (Playwright)
  // was globally connected but its tools were denied because the default
  // --allowed-tools only ever listed the six built-ins.
  assert.ok(DEFAULT_ALLOWED_TOOLS.includes("mcp__*"));
});

test("parseArgs: status and wait subcommands", () => {
  const s = parseArgs(["status", "sess-1"]);
  assert.equal(s.command, "status");
  assert.equal(s.sessionId, "sess-1");
  const w = parseArgs(["wait", "sess-2", "--timeout", "5"]);
  assert.equal(w.command, "wait");
  assert.equal(w.sessionId, "sess-2");
  assert.equal(w.timeoutSeconds, 5);
  assert.ok(parseArgs(["status"]).errors.length > 0);
  assert.ok(parseArgs(["wait", "x", "--timeout", "nope"]).errors.length > 0);
});

test("parseArgs: --max-turns must be a number", () => {
  assert.ok(parseArgs(["p", "--max-turns", "abc"]).errors.length > 0);
});

test("main: help prints the help text", async () => {
  const d = deps();
  const r = await main(["--help"], d);
  assert.equal(r.code, 0);
  assert.ok(d.out.join("").includes("USAGE:"));
});

test("main: status on an unknown session", async () => {
  const d = deps();
  const r = await main(["status", "nope"], d);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.lastLine ?? "{}");
  assert.equal(parsed.session_id, "nope");
  assert.equal(parsed.in_flight, false);
  assert.equal(parsed.last, null);
});

test("main: wait exits 3 while a live lock is held and 0 once released", async () => {
  const d = deps();
  d.store.ensureSessionDir("busy");
  writeFileSync(d.store.lockPath("busy"), JSON.stringify({ pid: process.pid, started_at: "x", turn: 1 }));
  const busy = await main(["wait", "busy", "--timeout", "0.05"], d);
  assert.equal(busy.code, 3);
  assert.equal(JSON.parse(busy.lastLine ?? "{}").in_flight, true);
  const free = await main(["wait", "free", "--timeout", "0.05"], d);
  assert.equal(free.code, 0);
});

test("main: usage error in json mode still prints a JSON line", async () => {
  const d = deps();
  const r = await main(["--json"], d);
  assert.equal(r.code, 1);
  const parsed = JSON.parse(r.lastLine ?? "{}");
  assert.equal(parsed.status, "error");
  assert.equal(parsed.error.code, "usage");
  assert.equal(parsed.session_id, null);
  assert.equal(parsed.turn, null);
});

test("main: usage error in text mode goes to stderr with no last line", async () => {
  const d = deps();
  const r = await main([], d);
  assert.equal(r.code, 1);
  assert.equal(r.lastLine, undefined);
  assert.ok(d.err.join("").includes("Usage:"));
});

test("main: --cwd must be a directory", async () => {
  const d = deps();
  const r = await main(["hi", "--json", "--cwd", "/nope"], d);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.lastLine ?? "{}").error.code, "usage");
});

test("main: a json turn returns the JSON line and reads the prompt from stdin", async () => {
  const d = deps(
    [
      { kind: "init", sessionId: "s1" },
      { kind: "text", text: "Done." },
      { kind: "result", subtype: "success" },
    ],
    "prompt from stdin",
  );
  const r = await main(["--json", "--cwd", "/tmp/repo"], d);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.lastLine ?? "{}");
  assert.equal(parsed.status, "done");
  assert.equal(parsed.session_id, "s1");
  assert.equal(d.store.readLatest("s1")?.prompt, "prompt from stdin");
  assert.equal(d.store.readLatest("s1")?.cwd, "/tmp/repo");
  assert.deepEqual(d.out, []);
});

test("main: a text turn streams and returns no last line", async () => {
  const d = deps([
    { kind: "init", sessionId: "s2" },
    { kind: "text", text: "Hi" },
    { kind: "ask", input: askInput },
    { kind: "result", subtype: "success" },
  ]);
  const r = await main(["hello"], d);
  assert.equal(r.code, 0);
  assert.equal(r.lastLine, undefined);
  assert.ok(d.out.join("").includes("[Color] Which color?"));
});

test("main: an exception during lock acquisition still prints a JSON error line in --json mode", async () => {
  const d = deps();
  d.store = brokenHomeStore();
  const r = await main(["--json", "-r", "some-session", "hi"], d);
  assert.equal(r.code, 1);
  const parsed = JSON.parse(r.lastLine ?? "{}");
  assert.equal(parsed.error.code, "exception");
  assert.equal(parsed.turn, null);
  assert.equal(parsed.result_file, null);
});

test("main: the same exception in text mode returns { code: 1 } with no last line", async () => {
  const d = deps();
  d.store = brokenHomeStore();
  const r = await main(["-r", "some-session", "hi"], d);
  assert.equal(r.code, 1);
  assert.equal(r.lastLine, undefined);
});
