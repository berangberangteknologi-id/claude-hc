import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { SessionStore, isPidAlive, resolveHome } from "../src/session-store.js";
import type { TurnRecord } from "../src/types.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "claude-hc-test-"));
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return child.pid as number;
}

function record(sessionId: string, turn: number, text = "hello"): TurnRecord {
  return {
    claude_hc: 1,
    status: "done",
    turn,
    summary: text,
    questions: [],
    result_subtype: "success",
    exit_code: 0,
    error: null,
    session_id: sessionId,
    result_file: null,
    text,
    prompt: "p",
    resume_from: null,
    cwd: "/tmp",
    started_at: "2026-09-08T00:00:00.000Z",
    ended_at: "2026-09-08T00:00:01.000Z",
    duration_ms: 1000,
    num_turns: 1,
    total_cost_usd: 0.01,
    allowed_tools: ["Read"],
    disallowed_tools: null,
    model: null,
    max_turns: null,
    claude_hc_version: "0.4.0",
  };
}

test("resolveHome prefers CLAUDE_HC_HOME and defaults to ~/.claude-hc", () => {
  assert.equal(resolveHome({ CLAUDE_HC_HOME: "/x/y" }), "/x/y");
  assert.equal(resolveHome({ CLAUDE_HC_HOME: "   " }).endsWith("/.claude-hc"), true);
  assert.equal(resolveHome({}).endsWith("/.claude-hc"), true);
});

test("isPidAlive is true for this process and false for a dead pid", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(deadPid()), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-5), false);
});

test("turn numbering and result files", () => {
  const store = new SessionStore(tempHome());
  const id = "sess-1";
  assert.equal(store.nextTurnNumber(id), 1);
  const f1 = store.writeTurnResult(id, 1, record(id, 1, "one"));
  assert.equal(f1, join(store.sessionDir(id), "turn-0001.json"));
  assert.equal(store.nextTurnNumber(id), 2);
  store.writeTurnResult(id, 2, record(id, 2, "two"));
  assert.equal(existsSync(join(store.sessionDir(id), "turn-0002.json")), true);
  const latest = store.readLatest(id);
  assert.equal(latest?.text, "two");
  assert.equal(latest?.turn, 2);
  assert.equal(existsSync(join(store.sessionDir(id), "turn-0002.json.tmp")), false);
  assert.equal(store.readLatest("never-seen"), null);
});

test("acquireLock succeeds on a fresh session and writes our pid", () => {
  const store = new SessionStore(tempHome());
  const res = store.acquireLock("sess-2", 1);
  assert.deepEqual(res, { acquired: true });
  const lock = store.readLock("sess-2");
  assert.equal(lock?.pid, process.pid);
  assert.equal(lock?.turn, 1);
  assert.ok(lock?.started_at);
  store.releaseLock("sess-2");
  assert.equal(store.readLock("sess-2"), null);
});

test("acquireLock reports busy when the lock pid is alive", () => {
  const store = new SessionStore(tempHome());
  const id = "sess-3";
  store.ensureSessionDir(id);
  writeFileSync(store.lockPath(id), JSON.stringify({ pid: process.pid, started_at: "2026-09-08T00:00:00.000Z", turn: 4 }));
  const res = store.acquireLock(id, 5);
  assert.equal(res.acquired, false);
  if (!res.acquired) {
    assert.equal(res.pid, process.pid);
    assert.equal(res.started_at, "2026-09-08T00:00:00.000Z");
  }
});

test("acquireLock replaces a stale lock and malformed locks", () => {
  const store = new SessionStore(tempHome());
  const id = "sess-4";
  store.ensureSessionDir(id);
  writeFileSync(store.lockPath(id), JSON.stringify({ pid: deadPid(), started_at: "x", turn: 1 }));
  assert.deepEqual(store.acquireLock(id, 2), { acquired: true });
  assert.equal(store.readLock(id)?.pid, process.pid);
  store.releaseLock(id);
  writeFileSync(store.lockPath(id), "not json");
  assert.deepEqual(store.acquireLock(id, 3), { acquired: true });
  store.releaseLock(id);
});

test("releaseLock only removes a lock owned by this process", () => {
  const store = new SessionStore(tempHome());
  const id = "sess-5";
  store.ensureSessionDir(id);
  writeFileSync(store.lockPath(id), JSON.stringify({ pid: process.pid + 100000, started_at: "x", turn: 1 }));
  store.releaseLock(id);
  assert.equal(existsSync(store.lockPath(id)), true);
});

test("status reports in-flight, cleans stale locks, and includes latest", () => {
  const store = new SessionStore(tempHome());
  const id = "sess-6";
  assert.deepEqual(store.status(id), {
    claude_hc: 1,
    session_id: id,
    session_dir: store.sessionDir(id),
    in_flight: false,
    pid: null,
    lock_started_at: null,
    last: null,
  });
  store.writeTurnResult(id, 1, record(id, 1));
  store.acquireLock(id, 2);
  const busy = store.status(id);
  assert.equal(busy.in_flight, true);
  assert.equal(busy.pid, process.pid);
  assert.equal(busy.last?.turn, 1);
  store.releaseLock(id);
  writeFileSync(store.lockPath(id), JSON.stringify({ pid: deadPid(), started_at: "x", turn: 2 }));
  const cleaned = store.status(id);
  assert.equal(cleaned.in_flight, false);
  assert.equal(existsSync(store.lockPath(id)), false);
});

test("waitForRelease returns when the lock goes away or the timeout passes", async () => {
  const store = new SessionStore(tempHome());
  const id = "sess-7";
  store.acquireLock(id, 1);
  const stillBusy = await store.waitForRelease(id, 60, 10);
  assert.equal(stillBusy.in_flight, true);
  setTimeout(() => store.releaseLock(id), 30);
  const released = await store.waitForRelease(id, 2000, 10);
  assert.equal(released.in_flight, false);
});

test("ensureSessionDir creates the directory with mode 0700", () => {
  const store = new SessionStore(tempHome());
  const dir = store.ensureSessionDir("sess-8");
  assert.equal(existsSync(dir), true);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});
