import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/session-store.js";
import { DENY_MESSAGE, releaseActiveLock, runTurn } from "../src/run.js";
import type { TurnDeps, TurnParams } from "../src/run.js";
import { askInput, makeFakeQuery } from "./helpers/fake-query.js";
import type { FakeStep } from "./helpers/fake-query.js";

function setup(steps: FakeStep[], overrides: Partial<TurnParams> = {}) {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "claude-hc-run-")));
  const fake = makeFakeQuery(steps);
  const out: string[] = [];
  const err: string[] = [];
  const deps: TurnDeps = {
    query: fake.query,
    store,
    stdout: (c) => out.push(c),
    stderr: (c) => err.push(c),
    now: () => new Date("2026-09-08T00:00:00.000Z"),
    version: "0.4.0-test",
  };
  const params: TurnParams = {
    prompt: "do the thing",
    resumeId: null,
    cwd: "/tmp",
    allowedTools: ["Read"],
    disallowedTools: null,
    model: null,
    maxTurns: null,
    jsonMode: true,
    ...overrides,
  };
  return { store, fake, out, err, deps, params };
}

test("a plain turn ends done with exit 0 and a result file", async () => {
  const { store, deps, params } = setup([
    { kind: "init", sessionId: "s1" },
    { kind: "text", text: "Hello " },
    { kind: "text", text: "world" },
    { kind: "result", subtype: "success" },
  ]);
  const result = await runTurn(params, deps);
  assert.equal(result.status, "done");
  assert.equal(result.exit_code, 0);
  assert.equal(result.session_id, "s1");
  assert.equal(result.turn, 1);
  assert.equal(result.summary, "world");
  assert.equal(result.result_file, store.turnFilePath("s1", 1));
  const record = store.readLatest("s1");
  assert.equal(record?.text, "Hello world");
  assert.equal(record?.prompt, "do the thing");
  assert.equal(record?.num_turns, 1);
  assert.equal(record?.claude_hc_version, "0.4.0-test");
  assert.equal(store.readLock("s1"), null);
});

test("an AskUserQuestion call yields needs_input, denies the tool, and dedupes identical repeated questions", async () => {
  // The underlying model sometimes calls AskUserQuestion twice with identical
  // content in one turn before actually ending it, despite the deny message
  // telling it to stop (observed in practice) — both calls must still be
  // denied, but the caller should see the question only once.
  const { fake, deps, params } = setup([
    { kind: "init", sessionId: "s2" },
    { kind: "text", text: "Let me ask." },
    { kind: "ask", input: askInput },
    { kind: "ask", input: askInput },
    { kind: "text", text: "Waiting for your answer." },
    { kind: "result", subtype: "success" },
  ]);
  const result = await runTurn(params, deps);
  assert.equal(result.status, "needs_input");
  assert.equal(result.exit_code, 0);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].header, "Color");
  assert.equal(result.summary, "Waiting for your answer.");
  assert.deepEqual(fake.permissionResults[0], { behavior: "deny", message: DENY_MESSAGE });
  assert.deepEqual(fake.permissionResults[1], { behavior: "deny", message: DENY_MESSAGE });
});

test("distinct AskUserQuestion calls in one turn are all collected, not deduped", async () => {
  const secondAsk = {
    questions: [
      {
        header: "Size",
        question: "Which size?",
        options: [
          { label: "Small", description: "" },
          { label: "Large", description: "" },
        ],
        multiSelect: false,
      },
    ],
  };
  const { deps, params } = setup([
    { kind: "init", sessionId: "s2b" },
    { kind: "ask", input: askInput },
    { kind: "ask", input: secondAsk },
    { kind: "result", subtype: "success" },
  ]);
  const result = await runTurn(params, deps);
  assert.equal(result.status, "needs_input");
  assert.equal(result.questions.length, 2);
  assert.equal(result.questions[0].header, "Color");
  assert.equal(result.questions[1].header, "Size");
});

test("text mode does not print a duplicated question block twice", async () => {
  const { out, deps, params } = setup(
    [
      { kind: "init", sessionId: "s2c" },
      { kind: "ask", input: askInput },
      { kind: "ask", input: askInput },
      { kind: "result", subtype: "success" },
    ],
    { jsonMode: false },
  );
  await runTurn(params, deps);
  const stdout = out.join("");
  const occurrences = stdout.split("Which color?").length - 1;
  assert.equal(occurrences, 1);
});

test("a stream that ends without a result exits 2", async () => {
  const { deps, params, err } = setup([
    { kind: "init", sessionId: "s3" },
    { kind: "text", text: "partial" },
    { kind: "end" },
  ]);
  const result = await runTurn(params, deps);
  assert.equal(result.exit_code, 2);
  assert.equal(result.status, "error");
  assert.equal(result.error?.code, "no_result_message");
  assert.ok(err.join("").includes("without a result message"));
  assert.equal(existsSync(deps.store.turnFilePath("s3", 1)), true);
});

test("a non-success result exits 1 with non_success_result", async () => {
  const { deps, params } = setup([
    { kind: "init", sessionId: "s4" },
    { kind: "result", subtype: "error_max_turns" },
  ]);
  const result = await runTurn(params, deps);
  assert.equal(result.exit_code, 1);
  assert.equal(result.result_subtype, "error_max_turns");
  assert.equal(result.error?.code, "non_success_result");
});

test("an exception from the SDK exits 1 with exception", async () => {
  const { deps, params } = setup([
    { kind: "init", sessionId: "s5" },
    { kind: "throw", message: "boom" },
  ]);
  const result = await runTurn(params, deps);
  assert.equal(result.exit_code, 1);
  assert.equal(result.error?.code, "exception");
  assert.ok(result.error?.message.includes("boom"));
  assert.equal(deps.store.readLock("s5"), null);
});

test("resuming a busy session exits 3 without touching files or calling query", async () => {
  const { store, fake, deps, params } = setup([{ kind: "init", sessionId: "s6" }], { resumeId: "s6" });
  store.ensureSessionDir("s6");
  writeFileSync(store.lockPath("s6"), JSON.stringify({ pid: process.pid, started_at: "2026-09-08T00:00:00.000Z", turn: 1 }));
  const result = await runTurn(params, deps);
  assert.equal(result.exit_code, 3);
  assert.equal(result.status, "error");
  assert.equal(result.error?.code, "session_busy");
  assert.equal(result.turn, null);
  assert.equal(result.result_file, null);
  assert.equal(result.session_id, "s6");
  assert.equal(fake.calls.length, 0);
  assert.equal(store.readLatest("s6"), null);
});

test("a fresh session that loses the lock race exits 3 without writing a result or touching the lock", async () => {
  const { store, deps, params } = setup([
    { kind: "init", sessionId: "s11" },
    { kind: "text", text: "should never be processed" },
    { kind: "result", subtype: "success" },
  ]);
  store.ensureSessionDir("s11");
  writeFileSync(store.lockPath("s11"), JSON.stringify({ pid: process.pid, started_at: "2026-09-08T00:00:00.000Z", turn: 1 }));
  const result = await runTurn(params, deps);
  assert.equal(result.exit_code, 3);
  assert.equal(result.status, "error");
  assert.equal(result.error?.code, "session_busy");
  assert.equal(result.turn, null);
  assert.equal(result.result_file, null);
  assert.equal(result.session_id, "s11");
  assert.equal(store.readLatest("s11"), null);
  const lock = store.readLock("s11");
  assert.equal(lock?.pid, process.pid);
});

test("resuming numbers turns and passes resume to the SDK", async () => {
  const { store, fake, deps, params } = setup([
    { kind: "init", sessionId: "s7" },
    { kind: "result", subtype: "success" },
  ]);
  await runTurn(params, deps);
  const second = await runTurn({ ...params, resumeId: "s7", prompt: "answer" }, deps);
  assert.equal(second.turn, 2);
  assert.equal(fake.calls[1].options?.resume, "s7");
  assert.equal(fake.calls[1].options?.cwd, "/tmp");
  assert.equal(store.readLatest("s7")?.resume_from, "s7");
});

test("text mode streams text and questions to stdout and the session id to stderr", async () => {
  const { out, err, deps, params } = setup(
    [
      { kind: "init", sessionId: "s8" },
      { kind: "text", text: "Hi. " },
      { kind: "ask", input: askInput },
      { kind: "tool", name: "Read" },
      { kind: "result", subtype: "success" },
    ],
    { jsonMode: false },
  );
  await runTurn(params, deps);
  const stdout = out.join("");
  assert.ok(stdout.startsWith("Hi. "));
  assert.ok(stdout.includes("\n[Color] Which color?\n  1. Red — warm\n  2. Blue — cool\n"));
  assert.ok(stdout.endsWith("\n"));
  const stderr = err.join("");
  assert.ok(stderr.includes("[claude-hc] using tool: Read"));
  assert.ok(stderr.includes("[claude-hc] session_id: s8"));
});

test("json mode writes nothing to stdout during the turn", async () => {
  const { out, deps, params } = setup([
    { kind: "init", sessionId: "s9" },
    { kind: "text", text: "Hi" },
    { kind: "ask", input: askInput },
    { kind: "result", subtype: "success" },
  ]);
  await runTurn(params, deps);
  assert.deepEqual(out, []);
});

test("releaseActiveLock is a no-op after a completed turn", async () => {
  const { deps, params } = setup([
    { kind: "init", sessionId: "s10" },
    { kind: "result", subtype: "success" },
  ]);
  await runTurn(params, deps);
  releaseActiveLock();
  assert.equal(deps.store.readLock("s10"), null);
});
