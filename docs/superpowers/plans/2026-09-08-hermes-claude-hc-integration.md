# Hermes Agent ↔ claude-hc Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give claude-hc a machine-readable turn contract (`--json`, result files, session lock, `status`/`wait`, `--cwd`) and ship a Hermes skill that drives interactive Claude Code sessions from Kanban workers and chat relays without blocking Hermes.

**Architecture:** claude-hc stays a one-shot CLI; `src/claude-hc.ts` is split into `cli.ts` (arguments and dispatch), `session-store.ts` (result files and lock under `$CLAUDE_HC_HOME`), `output.ts` (text and JSON formatting), and `run.ts` (one `query()` turn with an injectable `query` for tests). Hermes launches claude-hc as a background process, reads the last stdout line (or the result file), and resumes with `-r`; the skill in `hermes/skills/claude-hc/SKILL.md` encodes the Kanban worker loop and the chat relay.

**Tech Stack:** TypeScript 7 compiled with `tsc` (`module: NodeNext`, CommonJS output, so relative imports use the `.js` suffix in source), Node 22 on the dev machine (`engines >= 18`), `@anthropic-ai/claude-agent-sdk` 0.3.x, `node:test` + `node:assert/strict` run through `tsx`, bash + `jq` for the contract script.

**Spec:** `docs/superpowers/specs/2026-09-08-hermes-claude-hc-integration-design.md` (read it first; the research behind it is in `docs/superpowers/research/2026-09-08-hermes-agent-integration-research.md`).

## Global Constraints

- Every invocation of claude-hc stays one-shot: print, exit. No mode keeps the process alive waiting for input (spec §1, §3.1).
- Exit codes: `0` success (answer or question), `1` non-success result / usage error / exception, `2` stream ended without a `result` message, `3` `session_busy` (spec §3.1).
- `--json` prints exactly one JSON line as the last line of stdout, keys in this order: `claude_hc, status, turn, summary, questions, result_subtype, exit_code, error, session_id, result_file` (spec §3.2).
- `summary` is at most 300 characters, whitespace collapsed, `...` appended when cut (spec §3.2).
- Result files: `$CLAUDE_HC_HOME/sessions/<session_id>/turn-NNNN.json` plus `latest.json`, `CLAUDE_HC_HOME` defaulting to `~/.claude-hc`, directories mode `0700`, written once at the end of the turn before the JSON line (spec §3.3).
- Lock: `$CLAUDE_HC_HOME/sessions/<session_id>/lock`, JSON `{"pid","started_at","turn"}`, exclusive create, stale (dead pid) locks are deleted, `EPERM` on the liveness probe counts as alive (spec §3.4).
- `session_busy` and usage errors never write a result file; `turn` and `result_file` are `null` in their JSON line (spec §3.2).
- `wait` default timeout 170 s, poll once per second, exit 3 while still in flight (spec §3.1, §3.5).
- The `AskUserQuestion` deny message stays verbatim: `Already shown to the user above — their reply will be your next message. End your turn now.` (spec §3.1).
- Text mode output is unchanged from v0.3.0 (spec §3.1).
- The Hermes skill requires Hermes v0.21.1 or newer, uses `process_manage` (mentioning the `process` alias), never `pty`, never `notify` in a Kanban worker, passes literal absolute paths as `workdir`, and feeds prompts through stdin from `DIR/.claude-hc/prompt.txt` (spec §4).
- Package version becomes `0.4.0` (spec §8).
- Commit after every task; commit messages end with `Claude-Session: https://claude.ai/code/session_012M9tZCAV69BZskTEKVPxy2`.

---

## File structure

| Path | Responsibility |
|---|---|
| `src/types.ts` (new) | Shared wire types: `TurnResult`, `TurnRecord`, `Question`, `SessionStatus`, lock types. No runtime code. |
| `src/output.ts` (new) | Pure formatting: summary collapsing, question extraction from `AskUserQuestion` input, text-mode question rendering, JSON line building, status derivation. |
| `src/session-store.ts` (new) | `SessionStore`: home resolution, session directories, turn numbering, result files, lock acquire/release/status/wait, pid liveness. |
| `src/run.ts` (new) | `runTurn()`: one SDK turn with injectable `query`; collects text and questions, handles result/no-result/exception, writes the result file, manages the lock. |
| `src/cli.ts` (new) | `parseArgs()`, `HELP_TEXT`, `main()`: subcommand dispatch, usage errors, JSON line on every path. |
| `src/claude-hc.ts` (modify) | Entry point only: re-exec guard, live-session refusal, signal handlers, real dependencies, final flush and exit. |
| `test/helpers/fake-query.ts` (new) | Scripted fake `query()` that replays SDK messages and invokes `canUseTool`. |
| `test/output.test.ts`, `test/session-store.test.ts`, `test/run.test.ts`, `test/cli.test.ts`, `test/skill.test.ts` (new) | Unit tests, one file per module plus the skill structure check. |
| `hermes/skills/claude-hc/SKILL.md` (new) | The Hermes skill. |
| `scripts/hermes-sim.sh` (new) | Contract test that plays Hermes against real Claude when `CLAUDE_HC_E2E=1`. |
| `package.json`, `tsconfig.test.json` (new), `README.md`, `CHANGELOG.md` | Scripts, test type-checking, docs, version. |

Import rule for every new source file: relative imports use the `.js` extension (`import { x } from "./output.js"`), because `tsconfig.json` uses `module: NodeNext`. `tsx` resolves those to the `.ts` files in tests.

---

### Task 1: Test harness, shared types, and `output.ts`

**Files:**
- Modify: `package.json` (scripts, devDependencies)
- Create: `tsconfig.test.json`
- Create: `src/types.ts`
- Create: `src/output.ts`
- Test: `test/output.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (used by every later task):
  - `src/types.ts`: `TurnStatus`, `ErrorCode`, `QuestionOption`, `Question`, `TurnError`, `TurnResult`, `TurnRecord`, `LockInfo`, `LockResult`, `SessionStatus` (exact definitions below).
  - `src/output.ts`: `SUMMARY_MAX = 300`, `collapseSummary(text: string, max?: number): string`, `extractQuestions(input: unknown): Question[]`, `formatQuestionsText(questions: Question[]): string`, `deriveStatus(exitCode: number, questions: Question[]): TurnStatus`, `buildJsonLine(result: TurnResult): string`.

- [ ] **Step 1: Add the test tooling to `package.json`**

Replace the `scripts` and `devDependencies` blocks (keep everything else as is):

```json
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "postbuild": "chmod +x dist/claude-hc.js",
    "prepare": "npm run build",
    "test": "node --import tsx --test test/*.test.ts",
    "test:e2e": "bash scripts/hermes-sim.sh",
    "check": "tsc --noEmit -p tsconfig.test.json"
  },
  "devDependencies": {
    "@types/node": "^26.3.0",
    "tsx": "^4.23.13",
    "typescript": "^7.0.2"
  }
```

Create `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src", "test"]
}
```

Run: `npm install`
Expected: `tsx` appears under `node_modules/tsx`, no errors.

- [ ] **Step 2: Create `src/types.ts`**

```ts
// Shared wire types for claude-hc. Field names are snake_case because these
// objects are serialized verbatim into the JSON line and the result files
// (see the design spec, sections 3.2 and 3.3).

export type TurnStatus = "done" | "needs_input" | "error";

export type ErrorCode =
  | "session_busy"
  | "no_result_message"
  | "non_success_result"
  | "usage"
  | "exception";

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface TurnError {
  code: ErrorCode;
  message: string;
}

/** Exactly the fields of the JSON line, in the order they are printed. */
export interface TurnResult {
  claude_hc: 1;
  status: TurnStatus;
  turn: number | null;
  summary: string;
  questions: Question[];
  result_subtype: string | null;
  exit_code: number;
  error: TurnError | null;
  session_id: string | null;
  result_file: string | null;
}

/** The result file: the JSON line fields plus the full record. */
export interface TurnRecord extends TurnResult {
  text: string;
  prompt: string;
  resume_from: string | null;
  cwd: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  num_turns: number | null;
  total_cost_usd: number | null;
  allowed_tools: string[];
  disallowed_tools: string[] | null;
  model: string | null;
  max_turns: number | null;
  claude_hc_version: string;
}

export interface LockInfo {
  pid: number;
  started_at: string;
  turn: number;
}

export type LockResult =
  | { acquired: true }
  | { acquired: false; pid: number; started_at: string };

export interface SessionStatus {
  claude_hc: 1;
  session_id: string;
  session_dir: string;
  in_flight: boolean;
  pid: number | null;
  lock_started_at: string | null;
  last: TurnRecord | null;
}
```

- [ ] **Step 3: Write the failing tests for `output.ts`**

Create `test/output.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUMMARY_MAX,
  buildJsonLine,
  collapseSummary,
  deriveStatus,
  extractQuestions,
  formatQuestionsText,
} from "../src/output.js";
import type { Question, TurnResult } from "../src/types.js";

const twoQuestions: Question[] = [
  {
    header: "Auth method",
    question: "Which auth method should we use?",
    options: [
      { label: "OAuth", description: "Browser login" },
      { label: "API key", description: "Static key" },
    ],
    multiSelect: false,
  },
  {
    header: "Scope",
    question: "Which features?",
    options: [
      { label: "Import", description: "" },
      { label: "Export", description: "" },
    ],
    multiSelect: true,
  },
];

test("collapseSummary collapses whitespace and keeps short text intact", () => {
  assert.equal(collapseSummary("  Hello\n\n   world \t!"), "Hello world !");
});

test("collapseSummary truncates to SUMMARY_MAX with an ellipsis", () => {
  const long = "word ".repeat(100); // 500 chars
  const out = collapseSummary(long);
  assert.equal(out.length, SUMMARY_MAX);
  assert.ok(out.endsWith("..."));
  assert.equal(collapseSummary("x".repeat(300)).length, 300);
  assert.equal(collapseSummary("x".repeat(301)).endsWith("..."), true);
});

test("extractQuestions copies AskUserQuestion input and drops preview", () => {
  const input = {
    questions: [
      {
        header: "Auth method",
        question: "Which auth method should we use?",
        options: [
          { label: "OAuth", description: "Browser login", preview: "<b>x</b>" },
          { label: "API key", description: "Static key" },
        ],
        multiSelect: false,
      },
    ],
  };
  const qs = extractQuestions(input);
  assert.deepEqual(qs, [twoQuestions[0]]);
});

test("extractQuestions tolerates missing fields and non-arrays", () => {
  assert.deepEqual(extractQuestions(null), []);
  assert.deepEqual(extractQuestions({ questions: "nope" }), []);
  assert.deepEqual(extractQuestions({ questions: [{ question: "Only text?" }] }), [
    { header: "", question: "Only text?", options: [], multiSelect: false },
  ]);
});

test("formatQuestionsText matches the v0.3.0 text layout", () => {
  const text = formatQuestionsText([twoQuestions[0]]);
  assert.equal(
    text,
    "\n[Auth method] Which auth method should we use?\n" +
      "  1. OAuth — Browser login\n" +
      "  2. API key — Static key\n",
  );
  assert.equal(
    formatQuestionsText([{ header: "", question: "Q?", options: [{ label: "A", description: "" }], multiSelect: false }]),
    "\nQ?\n  1. A\n",
  );
});

test("deriveStatus follows exit code first, then questions", () => {
  assert.equal(deriveStatus(0, []), "done");
  assert.equal(deriveStatus(0, twoQuestions), "needs_input");
  assert.equal(deriveStatus(1, twoQuestions), "error");
  assert.equal(deriveStatus(3, []), "error");
});

test("buildJsonLine emits one line with keys in the contract order", () => {
  const result: TurnResult = {
    claude_hc: 1,
    status: "needs_input",
    turn: 2,
    summary: "Two approaches fit.",
    questions: twoQuestions,
    result_subtype: "success",
    exit_code: 0,
    error: null,
    session_id: "9f2c",
    result_file: "/tmp/x/turn-0002.json",
  };
  const line = buildJsonLine(result);
  assert.equal(line.includes("\n"), false);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [
    "claude_hc", "status", "turn", "summary", "questions",
    "result_subtype", "exit_code", "error", "session_id", "result_file",
  ]);
  assert.equal(parsed.session_id, "9f2c");
  assert.ok(line.endsWith('"result_file":"/tmp/x/turn-0002.json"}'));
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../src/output.js'` (or equivalent resolution error).

- [ ] **Step 5: Create `src/output.ts`**

```ts
import type { Question, TurnResult, TurnStatus } from "./types.js";

export const SUMMARY_MAX = 300;

/** Collapse whitespace and cap the length, appending "..." when cut. */
export function collapseSummary(text: string, max: number = SUMMARY_MAX): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 3).trimEnd() + "...";
}

/** Copy the questions out of an AskUserQuestion tool input, verbatim minus `preview`. */
export function extractQuestions(input: unknown): Question[] {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const item = (q ?? {}) as Record<string, unknown>;
    const options = Array.isArray(item.options) ? item.options : [];
    return {
      header: typeof item.header === "string" ? item.header : "",
      question: typeof item.question === "string" ? item.question : "",
      options: options.map((o) => {
        const opt = (o ?? {}) as Record<string, unknown>;
        return {
          label: typeof opt.label === "string" ? opt.label : "",
          description: typeof opt.description === "string" ? opt.description : "",
        };
      }),
      multiSelect: item.multiSelect === true,
    };
  });
}

/** Text-mode rendering, byte-for-byte the v0.3.0 layout. */
export function formatQuestionsText(questions: Question[]): string {
  let out = "";
  for (const q of questions) {
    out += `\n${q.header ? `[${q.header}] ` : ""}${q.question}\n`;
    q.options.forEach((opt, idx) => {
      out += `  ${idx + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}\n`;
    });
  }
  return out;
}

export function deriveStatus(exitCode: number, questions: Question[]): TurnStatus {
  if (exitCode !== 0) return "error";
  return questions.length > 0 ? "needs_input" : "done";
}

/** One JSON line, keys in the contract order (session id and file path last). */
export function buildJsonLine(result: TurnResult): string {
  const ordered: TurnResult = {
    claude_hc: 1,
    status: result.status,
    turn: result.turn,
    summary: result.summary,
    questions: result.questions,
    result_subtype: result.result_subtype,
    exit_code: result.exit_code,
    error: result.error,
    session_id: result.session_id,
    result_file: result.result_file,
  };
  return JSON.stringify(ordered);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: all 7 tests in `test/output.test.ts` pass. Then run `npm run check` and expect no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.test.json src/types.ts src/output.ts test/output.test.ts
git commit -m "Add test harness, shared wire types, and output formatting module

Claude-Session: https://claude.ai/code/session_012M9tZCAV69BZskTEKVPxy2"
```

---

### Task 2: `session-store.ts` (result files and lock)

**Files:**
- Create: `src/session-store.ts`
- Test: `test/session-store.test.ts`

**Interfaces:**
- Consumes: `TurnRecord`, `LockInfo`, `LockResult`, `SessionStatus` from `src/types.ts`.
- Produces:
  - `resolveHome(env?: NodeJS.ProcessEnv): string`
  - `isPidAlive(pid: number): boolean`
  - `class SessionStore { constructor(home: string); readonly home; sessionDir(id): string; ensureSessionDir(id): string; nextTurnNumber(id): number; turnFilePath(id, turn): string; writeTurnResult(id, turn, record: TurnRecord): string; readLatest(id): TurnRecord | null; lockPath(id): string; readLock(id): LockInfo | null; acquireLock(id, turn): LockResult; releaseLock(id): void; status(id): SessionStatus; waitForRelease(id, timeoutMs, pollMs?): Promise<SessionStatus> }`

- [ ] **Step 1: Write the failing tests**

Create `test/session-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/session-store.test.ts`
Expected: FAIL with a module resolution error for `../src/session-store.js`.

- [ ] **Step 3: Create `src/session-store.ts`**

```ts
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LockInfo, LockResult, SessionStatus, TurnRecord } from "./types.js";

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_HC_HOME;
  if (configured && configured.trim()) return configured;
  return join(homedir(), ".claude-hc");
}

/** True when a signal-0 probe succeeds or is refused with EPERM (alive, other user). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const TURN_FILE = /^turn-\d{4}\.json$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeAtomically(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export class SessionStore {
  constructor(readonly home: string) {}

  sessionDir(id: string): string {
    return join(this.home, "sessions", id);
  }

  ensureSessionDir(id: string): string {
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  nextTurnNumber(id: string): number {
    const dir = this.sessionDir(id);
    if (!existsSync(dir)) return 1;
    return readdirSync(dir).filter((name) => TURN_FILE.test(name)).length + 1;
  }

  turnFilePath(id: string, turn: number): string {
    return join(this.sessionDir(id), `turn-${String(turn).padStart(4, "0")}.json`);
  }

  /** Write turn-NNNN.json and latest.json atomically; returns the turn file path. */
  writeTurnResult(id: string, turn: number, record: TurnRecord): string {
    this.ensureSessionDir(id);
    const file = this.turnFilePath(id, turn);
    const content = JSON.stringify({ ...record, result_file: file }, null, 2) + "\n";
    writeAtomically(file, content);
    writeAtomically(join(this.sessionDir(id), "latest.json"), content);
    return file;
  }

  readLatest(id: string): TurnRecord | null {
    try {
      return JSON.parse(readFileSync(join(this.sessionDir(id), "latest.json"), "utf8")) as TurnRecord;
    } catch {
      return null;
    }
  }

  lockPath(id: string): string {
    return join(this.sessionDir(id), "lock");
  }

  readLock(id: string): LockInfo | null {
    try {
      const parsed = JSON.parse(readFileSync(this.lockPath(id), "utf8")) as Partial<LockInfo>;
      if (typeof parsed.pid !== "number") return null;
      return {
        pid: parsed.pid,
        started_at: typeof parsed.started_at === "string" ? parsed.started_at : "",
        turn: typeof parsed.turn === "number" ? parsed.turn : 0,
      };
    } catch {
      return null;
    }
  }

  /** Exclusive create; a stale (dead pid) or malformed lock is replaced. */
  acquireLock(id: string, turn: number): LockResult {
    this.ensureSessionDir(id);
    const path = this.lockPath(id);
    const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), turn });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeSync(fd, payload);
        closeSync(fd);
        return { acquired: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const existing = this.readLock(id);
      if (existing && isPidAlive(existing.pid)) {
        return { acquired: false, pid: existing.pid, started_at: existing.started_at };
      }
      try {
        unlinkSync(path);
      } catch {
        // Someone else removed it first; the next create attempt decides.
      }
    }
    const last = this.readLock(id);
    return { acquired: false, pid: last?.pid ?? -1, started_at: last?.started_at ?? "" };
  }

  /** Remove the lock only when this process owns it. */
  releaseLock(id: string): void {
    const lock = this.readLock(id);
    if (lock && lock.pid === process.pid) {
      try {
        unlinkSync(this.lockPath(id));
      } catch {
        // Already gone.
      }
    }
  }

  status(id: string): SessionStatus {
    const lock = this.readLock(id);
    let inFlight = false;
    let pid: number | null = null;
    let startedAt: string | null = null;
    if (lock) {
      if (isPidAlive(lock.pid)) {
        inFlight = true;
        pid = lock.pid;
        startedAt = lock.started_at;
      } else {
        try {
          unlinkSync(this.lockPath(id));
        } catch {
          // Already gone.
        }
      }
    } else if (existsSync(this.lockPath(id))) {
      // Malformed lock file: treat as stale.
      try {
        unlinkSync(this.lockPath(id));
      } catch {
        // Already gone.
      }
    }
    return {
      claude_hc: 1,
      session_id: id,
      session_dir: this.sessionDir(id),
      in_flight: inFlight,
      pid,
      lock_started_at: startedAt,
      last: this.readLatest(id),
    };
  }

  async waitForRelease(id: string, timeoutMs: number, pollMs: number = 1000): Promise<SessionStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = this.status(id);
      if (!current.in_flight) return current;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return current;
      await sleep(Math.min(pollMs, remaining));
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests in both files pass. Run `npm run check`: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/session-store.ts test/session-store.test.ts
git commit -m "Add session store: per-session result files and pid lock

Claude-Session: https://claude.ai/code/session_012M9tZCAV69BZskTEKVPxy2"
```

---

### Task 3: `run.ts` (one turn with an injectable `query`)

**Files:**
- Create: `src/run.ts`
- Create: `test/helpers/fake-query.ts`
- Test: `test/run.test.ts`

**Interfaces:**
- Consumes: `SessionStore` (Task 2), `output.ts` functions (Task 1), types (Task 1), and from the SDK: `query`, `SDKMessage`, `Options`, `CanUseTool`.
- Produces:
  - `DENY_MESSAGE` (verbatim constant), `NO_RESULT_MESSAGE`
  - `interface TurnParams { prompt: string; resumeId: string | null; cwd: string; allowedTools: string[]; disallowedTools: string[] | null; model: string | null; maxTurns: number | null; jsonMode: boolean }`
  - `type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>`
  - `interface TurnDeps { query: QueryFn; store: SessionStore; stdout: (chunk: string) => void; stderr: (chunk: string) => void; now: () => Date; version: string }`
  - `runTurn(params: TurnParams, deps: TurnDeps): Promise<TurnResult>`
  - `releaseActiveLock(): void` (for signal handlers)

- [ ] **Step 1: Create the fake query helper**

Create `test/helpers/fake-query.ts`:

```ts
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../../src/run.js";

export type FakeStep =
  | { kind: "init"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "ask"; input: unknown }
  | { kind: "result"; subtype: string }
  | { kind: "throw"; message: string }
  | { kind: "end" };

export interface FakeQuery {
  query: QueryFn;
  calls: Array<{ prompt: string; options: Options | undefined }>;
  permissionResults: unknown[];
}

/** Replays scripted SDK messages; "ask" steps call options.canUseTool like the SDK would. */
export function makeFakeQuery(steps: FakeStep[]): FakeQuery {
  const fake: FakeQuery = { query: undefined as unknown as QueryFn, calls: [], permissionResults: [] };
  fake.query = (params) => {
    fake.calls.push({ prompt: params.prompt, options: params.options });
    const sessionIdOf = () => {
      const init = steps.find((s) => s.kind === "init");
      return init && init.kind === "init" ? init.sessionId : "unknown";
    };
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const step of steps) {
        switch (step.kind) {
          case "init":
            yield { type: "system", subtype: "init", session_id: step.sessionId, cwd: "/tmp", model: "fake-model" } as unknown as SDKMessage;
            break;
          case "text":
            yield {
              type: "assistant",
              session_id: sessionIdOf(),
              message: { role: "assistant", content: [{ type: "text", text: step.text }] },
            } as unknown as SDKMessage;
            break;
          case "tool":
            yield {
              type: "assistant",
              session_id: sessionIdOf(),
              message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: step.name, input: {} }] },
            } as unknown as SDKMessage;
            break;
          case "ask": {
            yield {
              type: "assistant",
              session_id: sessionIdOf(),
              message: { role: "assistant", content: [{ type: "tool_use", id: "tu_ask", name: "AskUserQuestion", input: step.input }] },
            } as unknown as SDKMessage;
            const canUseTool = params.options?.canUseTool;
            if (canUseTool) {
              const res = await canUseTool("AskUserQuestion", step.input as Record<string, unknown>, {
                signal: new AbortController().signal,
                suggestions: [],
              } as never);
              fake.permissionResults.push(res);
            }
            break;
          }
          case "result":
            yield {
              type: "result",
              subtype: step.subtype,
              session_id: sessionIdOf(),
              is_error: step.subtype !== "success",
              num_turns: 1,
              total_cost_usd: 0.01,
              duration_ms: 5,
              result: "",
            } as unknown as SDKMessage;
            break;
          case "throw":
            throw new Error(step.message);
          case "end":
            return;
        }
      }
    }
    return gen();
  };
  return fake;
}

export const askInput = {
  questions: [
    {
      header: "Color",
      question: "Which color?",
      options: [
        { label: "Red", description: "warm" },
        { label: "Blue", description: "cool" },
      ],
      multiSelect: false,
    },
  ],
};
```

- [ ] **Step 2: Write the failing tests**

Create `test/run.test.ts`:

```ts
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

test("an AskUserQuestion call yields needs_input, denies the tool, and keeps all questions", async () => {
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
  assert.equal(result.questions.length, 2);
  assert.equal(result.questions[0].header, "Color");
  assert.equal(result.summary, "Waiting for your answer.");
  assert.deepEqual(fake.permissionResults[0], { behavior: "deny", message: DENY_MESSAGE });
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --test test/run.test.ts`
Expected: FAIL, cannot resolve `../src/run.js`.

- [ ] **Step 4: Create `src/run.ts`**

```ts
import type { CanUseTool, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { collapseSummary, deriveStatus, extractQuestions, formatQuestionsText } from "./output.js";
import type { SessionStore } from "./session-store.js";
import type { Question, TurnError, TurnRecord, TurnResult } from "./types.js";

export const DENY_MESSAGE =
  "Already shown to the user above — their reply will be your next message. End your turn now.";

export const NO_RESULT_MESSAGE =
  "[claude-hc] the session ended without a result message — the turn's actual outcome is unknown " +
  "(possibly killed mid-turn during a long silent tool call; see README's Known limitations). " +
  "Re-run with -r to see if the session can still be resumed.";

export interface TurnParams {
  prompt: string;
  resumeId: string | null;
  cwd: string;
  allowedTools: string[];
  disallowedTools: string[] | null;
  model: string | null;
  maxTurns: number | null;
  jsonMode: boolean;
}

export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface TurnDeps {
  query: QueryFn;
  store: SessionStore;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  now: () => Date;
  version: string;
}

// The lock held by the turn currently running in this process, so a signal
// handler can release it before exiting.
let activeLock: { store: SessionStore; sessionId: string } | null = null;

export function releaseActiveLock(): void {
  if (activeLock) {
    activeLock.store.releaseLock(activeLock.sessionId);
    activeLock = null;
  }
}

/** Narrow view of the SDK result message; error variants share these fields. */
interface ResultLike {
  type: "result";
  subtype: string;
  session_id: string;
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
}

function busyResult(sessionId: string, pid: number, startedAt: string): TurnResult {
  return {
    claude_hc: 1,
    status: "error",
    turn: null,
    summary: "",
    questions: [],
    result_subtype: null,
    exit_code: 3,
    error: {
      code: "session_busy",
      message: `session ${sessionId} is in use by pid ${pid} since ${startedAt || "unknown"}`,
    },
    session_id: sessionId,
    result_file: null,
  };
}

export async function runTurn(params: TurnParams, deps: TurnDeps): Promise<TurnResult> {
  const startedAt = deps.now();
  const { store } = deps;
  let sessionId: string | null = params.resumeId;
  let turn: number | null = null;
  let lockHeld = false;

  if (params.resumeId) {
    turn = store.nextTurnNumber(params.resumeId);
    const lock = store.acquireLock(params.resumeId, turn);
    if (!lock.acquired) return busyResult(params.resumeId, lock.pid, lock.started_at);
    lockHeld = true;
    activeLock = { store, sessionId: params.resumeId };
  }

  const questions: Question[] = [];
  const allText: string[] = [];
  let lastMessageText = "";
  let sawResult = false;
  let resultSubtype: string | null = null;
  let numTurns: number | null = null;
  let totalCostUsd: number | null = null;
  let exitCode = 0;
  let error: TurnError | null = null;
  let busy: TurnResult | null = null;

  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName === "AskUserQuestion") {
      const extracted = extractQuestions(input);
      questions.push(...extracted);
      if (!params.jsonMode) deps.stdout(formatQuestionsText(extracted));
      return { behavior: "deny", message: DENY_MESSAGE };
    }
    return { behavior: "deny", message: `Tool "${toolName}" is not in --allowed-tools.` };
  };

  const options: Options = {
    allowedTools: params.allowedTools.filter((t) => t !== "AskUserQuestion"),
    cwd: params.cwd,
    canUseTool,
    ...(params.disallowedTools ? { disallowedTools: params.disallowedTools } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.maxTurns !== null ? { maxTurns: params.maxTurns } : {}),
    ...(params.resumeId ? { resume: params.resumeId } : {}),
  };

  try {
    for await (const message of deps.query({ prompt: params.prompt, options })) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        if (!params.resumeId) {
          turn = store.nextTurnNumber(sessionId);
          const lock = store.acquireLock(sessionId, turn);
          if (!lock.acquired) {
            busy = busyResult(sessionId, lock.pid, lock.started_at);
            break;
          }
          lockHeld = true;
          activeLock = { store, sessionId };
        }
      } else if (message.type === "assistant") {
        let messageText = "";
        for (const block of message.message.content) {
          if (block.type === "text") {
            messageText += block.text;
            allText.push(block.text);
            if (!params.jsonMode) deps.stdout(block.text);
          } else if (block.type === "tool_use") {
            deps.stderr(`\n[claude-hc] using tool: ${block.name}\n`);
          }
        }
        if (messageText) lastMessageText = messageText;
      } else if (message.type === "result") {
        const result = message as unknown as ResultLike;
        sawResult = true;
        resultSubtype = result.subtype;
        numTurns = typeof result.num_turns === "number" ? result.num_turns : null;
        totalCostUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : null;
        if (!params.jsonMode) deps.stdout("\n");
        if (result.subtype !== "success") {
          deps.stderr(`[claude-hc] stopped: ${result.subtype}\n`);
          exitCode = 1;
          error = { code: "non_success_result", message: `turn ended with ${result.subtype}` };
        }
      }
    }
    if (!busy && !sawResult && exitCode === 0) {
      deps.stderr(NO_RESULT_MESSAGE + "\n");
      exitCode = 2;
      error = { code: "no_result_message", message: "the session ended without a result message" };
    }
  } catch (err) {
    deps.stderr(`[claude-hc] error: ${String(err)}\n`);
    exitCode = 1;
    error = { code: "exception", message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (lockHeld && sessionId) store.releaseLock(sessionId);
    activeLock = null;
    if (!params.jsonMode && sessionId) deps.stderr(`[claude-hc] session_id: ${sessionId}\n`);
  }

  if (busy) return busy;

  const endedAt = deps.now();
  const status = deriveStatus(exitCode, questions);
  const base: TurnResult = {
    claude_hc: 1,
    status,
    turn,
    summary: collapseSummary(lastMessageText),
    questions,
    result_subtype: resultSubtype,
    exit_code: exitCode,
    error,
    session_id: sessionId,
    result_file: null,
  };
  if (!sessionId || turn === null) return base;

  const record: TurnRecord = {
    ...base,
    text: allText.join(""),
    prompt: params.prompt,
    resume_from: params.resumeId,
    cwd: params.cwd,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - startedAt.getTime(),
    num_turns: numTurns,
    total_cost_usd: totalCostUsd,
    allowed_tools: params.allowedTools,
    disallowed_tools: params.disallowedTools,
    model: params.model,
    max_turns: params.maxTurns,
    claude_hc_version: deps.version,
  };
  const resultFile = store.writeTurnResult(sessionId, turn, record);
  return { ...base, result_file: resultFile };
}
```

Notes for the implementer:
- `summary` comes from the last assistant message that contained text (the final answer), while the record's `text` is every text block concatenated, mirroring what text mode streams.
- The result file is written after the lock is released; nothing reads it before the JSON line is printed, and `status` reports `in_flight: false` by then, which is the intended order (spec §3.3).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests pass (output, session-store, run). Run `npm run check`: no type errors. If `message.message.content` block types fail to narrow, keep the `block.type === "text"` / `"tool_use"` checks exactly as written; the SDK's `BetaMessage` content union supports them.

- [ ] **Step 6: Commit**

```bash
git add src/run.ts test/helpers/fake-query.ts test/run.test.ts
git commit -m "Add runTurn: one SDK turn with structured outcome, result file, and lock

Claude-Session: https://claude.ai/code/session_012M9tZCAV69BZskTEKVPxy2"
```

---

### Task 4: `cli.ts` (argument parsing, subcommands, JSON on every path)

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `runTurn`, `TurnDeps`, `QueryFn` (Task 3); `SessionStore` (Task 2); `buildJsonLine` (Task 1).
- Produces:
  - `DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]`, `DEFAULT_WAIT_TIMEOUT_S = 170`, `HELP_TEXT`
  - `interface ParsedArgs { command: "turn" | "status" | "wait" | "help"; prompt: string | undefined; resumeId: string | undefined; allowedTools: string[]; disallowedTools: string[] | undefined; model: string | undefined; maxTurns: number | undefined; json: boolean; cwd: string | undefined; sessionId: string | undefined; timeoutSeconds: number | undefined; errors: string[] }`
  - `parseArgs(argv: string[]): ParsedArgs`
  - `interface MainDeps { query: QueryFn; store: SessionStore; stdout: (chunk: string) => void; stderr: (chunk: string) => void; readStdin: () => Promise<string>; defaultCwd: () => string; isDirectory: (path: string) => boolean; version: string; now: () => Date }`
  - `interface MainResult { code: number; lastLine?: string }`
  - `main(argv: string[], deps: MainDeps): Promise<MainResult>`

- [ ] **Step 1: Write the failing tests**

Create `test/cli.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/cli.test.ts`
Expected: FAIL, cannot resolve `../src/cli.js`.

- [ ] **Step 3: Create `src/cli.ts`**

```ts
import { buildJsonLine } from "./output.js";
import { runTurn } from "./run.js";
import type { QueryFn, TurnDeps } from "./run.js";
import type { SessionStore } from "./session-store.js";
import type { TurnResult } from "./types.js";

export const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];
export const DEFAULT_WAIT_TIMEOUT_S = 170;

export const HELP_TEXT = `claude-hc — headless Claude Code that can still ask clarifying questions

USAGE:
  claude-hc "prompt text" [options]
  echo "prompt text" | claude-hc [options]
  claude-hc status <session_id>
  claude-hc wait <session_id> [--timeout <seconds>]

OPTIONS:
  -r, --resume <session_id>   Resume a specific session by its session_id.
  --json                      Print one JSON line as the last line of stdout instead of
                              streaming text (status, questions, session_id, result_file).
  --cwd <dir>                 Working directory for the Claude session (default: current).
  --allowed-tools <a,b,c>     Comma-separated list of tools the agent may use
                              (default: ${DEFAULT_ALLOWED_TOOLS.join(",")})
                              "AskUserQuestion" is always routed through
                              canUseTool, so it doesn't need to (and can't) be
                              listed here.
  --disallowed-tools <a,b,c>  Comma-separated list of tools to block
  --model <name>              Model to use (e.g. claude-sonnet-5)
  --max-turns <n>             Cap on tool-use round-trips
  -h, --help                  Show this help

SUBCOMMANDS:
  status <session_id>         Print whether a turn is in flight and the latest result.
  wait <session_id>           Block until no turn is in flight or --timeout (default
                              ${DEFAULT_WAIT_TIMEOUT_S}s) passes, then print the status.

FILES:
  Every turn writes $CLAUDE_HC_HOME/sessions/<session_id>/turn-NNNN.json and latest.json
  (CLAUDE_HC_HOME defaults to ~/.claude-hc). A lock file in the same directory prevents
  two claude-hc processes from resuming the same session at once.

EXIT CODES:
  0  success (the agent answered or asked a question)
  1  non-success result, usage error, or claude-hc error
  2  the session ended without a result message (outcome unknown; try -r)
  3  session busy: another claude-hc process holds this session's lock

NOTES:
  - Tools in --allowed-tools are auto-approved without asking (same as 'claude -p').
  - IMPORTANT: --allowed-tools is NOT a fully reliable security sandbox. If you need a
    tool truly blocked, use --disallowed-tools.
  - Every invocation is one-shot: claude-hc prints and exits, whether the output is a
    final answer or a clarifying question. To answer, run claude-hc again with
    -r <session_id> and your answer as the new prompt.
  - claude-hc always re-execs itself once as a child process with the environment
    stripped of CLAUDE_CODE_* variables, so it isn't recognized as a "child" of any
    live Claude Code session that invoked it.`;

export interface ParsedArgs {
  command: "turn" | "status" | "wait" | "help";
  prompt: string | undefined;
  resumeId: string | undefined;
  allowedTools: string[];
  disallowedTools: string[] | undefined;
  model: string | undefined;
  maxTurns: number | undefined;
  json: boolean;
  cwd: string | undefined;
  sessionId: string | undefined;
  timeoutSeconds: number | undefined;
  errors: string[];
}

function splitList(raw: string | undefined): string[] {
  return raw?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: "turn",
    prompt: undefined,
    resumeId: undefined,
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    disallowedTools: undefined,
    model: undefined,
    maxTurns: undefined,
    json: false,
    cwd: undefined,
    sessionId: undefined,
    timeoutSeconds: undefined,
    errors: [],
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        args.command = "help";
        break;
      case "-r":
      case "--resume":
        args.resumeId = argv[++i];
        if (!args.resumeId) args.errors.push("-r/--resume requires a session_id");
        break;
      case "--json":
        args.json = true;
        break;
      case "--cwd":
        args.cwd = argv[++i];
        if (!args.cwd) args.errors.push("--cwd requires a directory");
        break;
      case "--allowed-tools":
        args.allowedTools = splitList(argv[++i]);
        break;
      case "--disallowed-tools":
        args.disallowedTools = splitList(argv[++i]);
        break;
      case "--model":
        args.model = argv[++i];
        break;
      case "--max-turns": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n)) args.maxTurns = n;
        else args.errors.push("--max-turns requires a number");
        break;
      }
      case "--timeout": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n >= 0) args.timeoutSeconds = n;
        else args.errors.push("--timeout requires a non-negative number of seconds");
        break;
      }
      default:
        positional.push(arg);
    }
  }

  if (args.command === "help") return args;

  if (positional[0] === "status" || positional[0] === "wait") {
    args.command = positional[0];
    args.sessionId = positional[1];
    if (!args.sessionId) args.errors.push(`${positional[0]} requires a session_id`);
    return args;
  }

  args.prompt = positional.join(" ").trim() || undefined;
  return args;
}

export interface MainDeps {
  query: QueryFn;
  store: SessionStore;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  readStdin: () => Promise<string>;
  defaultCwd: () => string;
  isDirectory: (path: string) => boolean;
  version: string;
  now: () => Date;
}

export interface MainResult {
  code: number;
  lastLine?: string;
}

const USAGE_LINE =
  'Usage: claude-hc "prompt" [-r <session_id>] [--json] [--cwd <dir>] [--allowed-tools a,b,c] ' +
  "[--model name] [--max-turns n] | claude-hc status <id> | claude-hc wait <id> [--timeout s]";

function usageResult(json: boolean, messages: string[], stderr: (c: string) => void): MainResult {
  const message = messages.join("; ");
  if (json) {
    const result: TurnResult = {
      claude_hc: 1,
      status: "error",
      turn: null,
      summary: "",
      questions: [],
      result_subtype: null,
      exit_code: 1,
      error: { code: "usage", message },
      session_id: null,
      result_file: null,
    };
    return { code: 1, lastLine: buildJsonLine(result) };
  }
  stderr(`${message}\n${USAGE_LINE}\nRun \`claude-hc --help\` for details.\n`);
  return { code: 1 };
}

export async function main(argv: string[], deps: MainDeps): Promise<MainResult> {
  const args = parseArgs(argv);

  if (args.command === "help") {
    deps.stdout(HELP_TEXT + "\n");
    return { code: 0 };
  }

  if (args.errors.length > 0) return usageResult(args.json, args.errors, deps.stderr);

  if (args.command === "status") {
    const status = deps.store.status(args.sessionId as string);
    return { code: 0, lastLine: JSON.stringify(status) };
  }

  if (args.command === "wait") {
    const timeoutMs = (args.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
    const status = await deps.store.waitForRelease(args.sessionId as string, timeoutMs);
    return { code: status.in_flight ? 3 : 0, lastLine: JSON.stringify(status) };
  }

  const prompt = args.prompt ?? (await deps.readStdin());
  if (!prompt) return usageResult(args.json, ["a prompt is required (argument or stdin)"], deps.stderr);

  const cwd = args.cwd ?? deps.defaultCwd();
  if (!deps.isDirectory(cwd)) {
    return usageResult(args.json, [`--cwd ${cwd} is not a directory`], deps.stderr);
  }

  const turnDeps: TurnDeps = {
    query: deps.query,
    store: deps.store,
    stdout: deps.stdout,
    stderr: deps.stderr,
    now: deps.now,
    version: deps.version,
  };
  const result = await runTurn(
    {
      prompt,
      resumeId: args.resumeId ?? null,
      cwd,
      allowedTools: args.allowedTools,
      disallowedTools: args.disallowedTools ?? null,
      model: args.model ?? null,
      maxTurns: args.maxTurns ?? null,
      jsonMode: args.json,
    },
    turnDeps,
  );
  return { code: result.exit_code, lastLine: args.json ? buildJsonLine(result) : undefined };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all four test files pass. Run `npm run check`: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "Add cli module: argument parsing, status/wait subcommands, JSON on every path

Claude-Session: https://claude.ai/code/session_012M9tZCAV69BZskTEKVPxy2"
```

---

### Task 5: Entry point rewrite, signals, build, smoke test

**Files:**
- Modify: `src/claude-hc.ts` (replace the whole file)

**Interfaces:**
- Consumes: `parseArgs`, `main` (Task 4); `SessionStore`, `resolveHome` (Task 2); `releaseActiveLock` (Task 3); SDK `query`.
- Produces: the executable `dist/claude-hc.js`, unchanged `bin` entry.

- [ ] **Step 1: Replace `src/claude-hc.ts`**

```ts
#!/usr/bin/env node
// claude-hc — headless Claude Code, but AskUserQuestion actually works
// (the agent can ask you a clarifying question instead of silently
// guessing, which is what plain `claude -p` does).
//
// Every invocation is one-shot, same as `-p`: it prints text (or, with
// --json, one JSON line) and exits. A clarifying question is just another
// piece of output; answering it means running claude-hc again with
// -r <session_id> and the answer as the new prompt.
//
// This file is only the entry point: re-exec guard, signal handling, real
// dependencies. The behavior lives in cli.ts, run.ts, session-store.ts and
// output.ts. Run `claude-hc --help` for the option list.
//
// Auth prerequisites (uses your Pro/Max subscription, not pay-per-token API
// billing):
//   npm install -g @anthropic-ai/claude-code
//   claude setup-token          // one-time browser login
//   # IMPORTANT: do NOT set ANTHROPIC_API_KEY — that overrides subscription
//   # auth and switches billing to the regular pay-per-token API.
//
// IMPORTANT caveat about --allowed-tools (confirmed through direct testing):
// query() boots your local Claude Code installation as-is, including every
// globally-enabled plugin/MCP server — it is not a clean SDK-only sandbox.
// A tool that is NOT in --allowed-tools/--disallowed-tools can still run in
// permissive setups; if you need a tool blocked, use --disallowed-tools.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { main, parseArgs } from "./cli.js";
import { releaseActiveLock } from "./run.js";
import { SessionStore, resolveHome } from "./session-store.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../package.json") as { version: string };

// claude-hc re-execs itself once as a fresh child process with the
// environment stripped of CLAUDE_CODE_* variables, so that query() inside it
// is not recognized as a "child" of whatever live Claude Code session called
// it. stdio stays 'inherit' so stdin redirects and output work normally.
// Guarded by CLAUDE_HC_DETACHED so it only re-execs once. status/wait/help
// never need the SDK, so they skip the re-exec.
const DETACH_MARKER = "CLAUDE_HC_DETACHED";
const ENV_VARS_TO_STRIP = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "AI_AGENT",
  "CLAUDE_EFFORT",
];

function relaunchDetached(): void {
  const cleanEnv = { ...process.env };
  for (const key of ENV_VARS_TO_STRIP) delete cleanEnv[key];
  cleanEnv[DETACH_MARKER] = "1";

  const child = spawn(process.execPath, [...process.execArgv, __filename, ...process.argv.slice(2)], {
    env: cleanEnv,
    stdio: "inherit",
    detached: true,
  });

  // Forward termination to the worker so a plain `kill <wrapper pid>` stops
  // the turn instead of orphaning it.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });

  child.on("error", (err) => {
    console.error("[claude-hc] failed to re-exec as a separate child process:", err);
    process.exit(1);
  });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function finish(code: number, lastLine?: string): void {
  // The write callback fires after every earlier stdout write has been
  // flushed, so the JSON line is always complete before the process exits.
  // The timer is a backstop in case the callback never fires (closed pipe).
  setTimeout(() => process.exit(code), 1000).unref();
  process.stdout.write(lastLine !== undefined ? lastLine + "\n" : "", () => process.exit(code));
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  // Check this BEFORE relaunchDetached() — CLAUDE_CODE_SESSION_ID is only
  // visible in the original process. Resuming into the live session that
  // spawned us could corrupt its transcript.
  const liveSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (liveSessionId && parsed.resumeId === liveSessionId) {
    console.error(
      `[claude-hc] -r ${parsed.resumeId} refused: that is the session_id of the live Claude ` +
        "Code session currently running this process. Resuming into the live session that " +
        "spawned us could corrupt its transcript.",
    );
    process.exit(1);
  }

  if (parsed.command === "turn" && process.env[DETACH_MARKER] !== "1") {
    relaunchDetached();
    return;
  }

  // Release our session lock on termination so a resumed worker is never
  // blocked by a dead pid longer than one liveness probe.
  process.on("SIGINT", () => {
    releaseActiveLock();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    releaseActiveLock();
    process.exit(143);
  });

  const result = await main(argv, {
    query: (params) => query(params),
    store: new SessionStore(resolveHome()),
    stdout: (chunk) => {
      process.stdout.write(chunk);
    },
    stderr: (chunk) => {
      process.stderr.write(chunk);
    },
    readStdin,
    defaultCwd: () => process.cwd(),
    isDirectory,
    version: pkg.version,
    now: () => new Date(),
  });
  finish(result.code, result.lastLine);
}

run().catch((err) => {
  console.error("[claude-hc] error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Build and type-check**

Run: `npm run build && npm run check && npm test`
Expected: build succeeds, `dist/claude-hc.js`, `dist/cli.js`, `dist/run.js`, `dist/session-store.js`, `dist/output.js`, `dist/types.js` exist, all tests pass. If `require` is flagged as undefined by the type checker, add `import { createRequire } from "node:module"; const require = createRequire(__filename);` above the `pkg` line instead of relying on the CommonJS global.

- [ ] **Step 3: Smoke test without Claude**

Run each and check the expected output:

```bash
node dist/claude-hc.js --help | head -3
# Expected: the first three lines of HELP_TEXT

node dist/claude-hc.js status not-a-session
# Expected: {"claude_hc":1,"session_id":"not-a-session","session_dir":"/Users/<you>/.claude-hc/sessions/not-a-session","in_flight":false,"pid":null,"lock_started_at":null,"last":null}

node dist/claude-hc.js --json
# Expected: one JSON line with "status":"error" and "code":"usage"; exit code 1
echo "exit=$?"

node dist/claude-hc.js --json --cwd /definitely/missing "hi"
# Expected: usage JSON line mentioning --cwd; exit 1

mkdir -p /tmp/hc-lock-test/sessions/busy-1 && \
  echo "{\"pid\": $$, \"started_at\": \"now\", \"turn\": 1}" > /tmp/hc-lock-test/sessions/busy-1/lock && \
  CLAUDE_HC_HOME=/tmp/hc-lock-test node dist/claude-hc.js wait busy-1 --timeout 1; echo "exit=$?"
# Expected: a status line with "in_flight":true and exit=3 (the shell's pid holds the lock)

CLAUDE_HC_HOME=/tmp/hc-lock-test node dist/claude-hc.js --json -r busy-1 "answer"; echo "exit=$?"
# Expected: {"claude_hc":1,"status":"error","turn":null,...,"error":{"code":"session_busy",...},"session_id":"busy-1","result_file":null} and exit=3
rm -rf /tmp/hc-lock-test
```

- [ ] **Step 4: Smoke test with Claude (needs a logged-in Claude Code install)**

```bash
cd /tmp && mkdir -p hc-smoke && cd hc-smoke
claude-hc --json "Reply with exactly the word pong and nothing else." --allowed-tools Read
# Expected: progress on stderr, then one JSON line: "status":"done", "summary":"pong", a session_id, and a result_file path; exit 0

claude-hc status <session_id> | jq '.in_flight, .last.status, .last.summary, .last.turn'
# Expected: false, "done", "pong", 1
```

Text mode regression: `claude-hc "Reply with exactly the word pong."` prints `pong`, a trailing newline, and `[claude-hc] session_id: ...` on stderr, exactly like v0.3.0.

- [ ] **Step 5: Commit**

```bash
git add src/claude-hc.ts
git commit -m "Rewire the entry point onto cli/run/session-store with lock-safe signal handling

Claude-Session: https://claude.ai/code/session_012M9tZCAV69BZskTEKVPxy2"
```

---

### Task 6: The Hermes skill

**Files:**
- Create: `hermes/skills/claude-hc/SKILL.md`
- Test: `test/skill.test.ts`

**Interfaces:**
- Consumes: the CLI contract from Tasks 4 and 5 (flags, JSON fields, exit codes, file paths).
- Produces: the installable skill; nothing else depends on it in code.

- [ ] **Step 1: Write the failing structure test**

Create `test/skill.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/skill.test.ts`
Expected: FAIL with ENOENT for `hermes/skills/claude-hc/SKILL.md`.

- [ ] **Step 3: Create `hermes/skills/claude-hc/SKILL.md`**

````markdown
---
name: claude-hc
description: Run Claude Code headlessly with claude-hc and drive its clarifying questions (brainstorming, design interviews) from Kanban workers or chat sessions.
version: 1.0.0
author: berangberangteknologi
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [Coding-Agent, Claude, Anthropic, Kanban, Interactive]
    related_skills: [claude-code, hermes-agent]
    requires_tools: [terminal]
---

# claude-hc — interactive Claude Code sessions from Hermes

claude-hc runs one Claude Code turn and exits. When Claude needs a decision it
calls `AskUserQuestion`; claude-hc records the question, ends the turn, and
you answer by running claude-hc again with `-r <session_id>`. Nothing stays
alive between turns, so Hermes never blocks on Claude.

## When to use

- Any Claude Code task that may need clarifying questions: design interviews,
  `superpowers:brainstorming`, refactors with real trade-offs, anything where
  guessing would be wrong.
- The reference case is `superpowers:brainstorming`: Claude interviews the
  user one question at a time, then writes a spec under
  `docs/superpowers/specs/` in the repository.
- For one-shot coding work that never needs a question, the bundled
  `claude-code` skill (`claude -p`) is enough.

## Prerequisites

- `claude-hc` on `PATH` (`npm link` from its checkout) and `claude-hc --help`
  works.
- Claude Code installed and logged in: `claude setup-token`. Never set
  `ANTHROPIC_API_KEY`; it switches billing away from the subscription.
- For brainstorming: the superpowers plugin installed in Claude Code.
- Hermes v0.21.1 or newer. The process tool is `process_manage` (older builds
  call it `process`; both names work upstream).

## Contract cheat sheet

Launch (always in the background, always `--json`, prompt via stdin):

```
claude-hc --json --cwd DIR < DIR/.claude-hc/prompt.txt
claude-hc --json --cwd DIR -r SESSION_ID < DIR/.claude-hc/prompt.txt
claude-hc status SESSION_ID
claude-hc wait SESSION_ID --timeout 170
```

The last line of stdout is one JSON object, keys in this order:

```
{"claude_hc":1,"status":"done|needs_input|error","turn":N,
 "summary":"first 300 chars of the final answer",
 "questions":[{"header":"...","question":"...",
   "options":[{"label":"...","description":"..."}],"multiSelect":false}],
 "result_subtype":"success","exit_code":0,
 "error":null | {"code":"session_busy|no_result_message|non_success_result|usage|exception","message":"..."},
 "session_id":"...","result_file":"/abs/path/turn-000N.json"}
```

`session_id` and `result_file` come last so a truncated tail still ends with
them. The full turn (all text, all questions) is in `result_file`; the same
content is always at `~/.claude-hc/sessions/SESSION_ID/latest.json`
(`$CLAUDE_HC_HOME` overrides `~/.claude-hc`).

Exit codes: `0` answered or asked (check `status`), `1` non-success result or
error, `2` stream ended without a result (resume with `-r`), `3` session busy
(another claude-hc process holds the session; use `claude-hc wait`).

`claude-hc status SESSION_ID` prints
`{"claude_hc":1,"session_id":...,"in_flight":true|false,"pid":...,"last":{...latest.json...}}`.

Answer text (the prompt for the `-r` turn):

```
Answers from the user:
[<header>] <question> -> <label or free text>
[<header>] <question> -> <label>, <label>
<optional free text the user added>
```

## Procedure A: Kanban worker

Use this when `HERMES_KANBAN_TASK` is set. Notifications are not available in
a worker, so poll; block the card when the human must decide.

1. `kanban_show()`. Note the repository path and the task prompt from the
   body. If the thread contains a `claude-hc session:` marker, jump to step 7.
2. Let `DIR` be the absolute repository path from the card body, or the
   absolute workspace path otherwise. Use the literal path everywhere below;
   Hermes does not expand `$HERMES_KANBAN_WORKSPACE` inside `workdir`.
   Write the prompt plus the hint from "Prompt hint" to
   `DIR/.claude-hc/prompt.txt` with `write_file`, then:
   ```
   terminal(command="claude-hc --json --cwd DIR < DIR/.claude-hc/prompt.txt",
            background=true, workdir=DIR)
   ```
   Do not pass `notify` (refused in workers) and never use a pseudo-terminal.
3. `process_manage(action="wait", session_id=<proc id>, timeout=180)`.
   - `status: "timeout"`: `kanban_heartbeat(note="claude-hc turn running, <uptime>s")`, then wait again.
   - `status: "interrupted"`: wait again.
   - `status: "exited"`: continue.
4. Take the last line of `output` and parse it as JSON. If it is not a
   complete object, take `session_id` from the tail and
   `read_file("~/.claude-hc/sessions/SESSION_ID/latest.json")`.
5. Branch on `status`:
   - `done`: step 9.
   - `needs_input`: apply "Answer-or-relay rule". Answering: step 6.
     Relaying: step 8.
   - `error` with `no_result_message`, or `non_success_result` where
     `result_subtype` is `error_max_turns`: step 6 with the answer text
     `The previous turn was interrupted. Continue where you left off.`
   - `error` with `session_busy`: run
     `terminal(command="claude-hc wait SESSION_ID --timeout 170", background=true, workdir=DIR)`,
     wait on it as in step 3, then retry the launch.
   - any other `error`: `kanban_comment(body="claude-hc failed: <message> (session SESSION_ID)")`
     then `kanban_block(reason="claude-hc failed: <message> (session SESSION_ID)", kind="transient")`
     and stop.
6. Resume: write the answer text to `DIR/.claude-hc/prompt.txt` and launch
   `claude-hc --json --cwd DIR -r SESSION_ID < DIR/.claude-hc/prompt.txt`
   exactly as in step 2, then go to step 3.
7. Resume after a respawn: read the newest `claude-hc session:` marker in
   the thread (session id, result file, block kind). Run
   `terminal(command="claude-hc status SESSION_ID", timeout=30)`. If
   `in_flight` is true, run `claude-hc wait SESSION_ID --timeout 170` in the
   background and wait on it until `in_flight` is false. Then read `last`:
   if its `status` is `done`, go to step 9. Otherwise the answer is the newest
   comment after the marker that was not written by this profile
   (`HERMES_PROFILE`); convert it to the answer text and go to step 6. If no
   such comment exists, post the question comment again and block (step 8).
8. Relay to the human: post one `kanban_comment` with the template below,
   then block and stop:
   ```
   kanban_block(reason="claude-hc needs a decision: <headers joined by ', '> (session SESSION_ID)", kind=K)
   ```
   `K` alternates so Hermes's unblock-loop breaker never trips: read the
   `block kind:` line of the newest `claude-hc session:` marker. If it says
   `needs_input`, omit `kind` this time (an untyped block) and write
   `block kind: untyped` in your comment. Otherwise (no marker, or `untyped`)
   use `kind="needs_input"` and write `block kind: needs_input`.
9. Complete:
   ```
   kanban_complete(summary=<final text, first 400 chars>,
                   metadata={"claude_session_id": SESSION_ID, "result_file": <path>, "turns": <n>, "spec_path": <path or null>},
                   artifacts=[<absolute spec path if a file was written under docs/superpowers/specs/>])
   ```

Comment template for step 8 (copy the structure exactly; it is what the next
worker parses):

```
claude-hc session: SESSION_ID
result file: /abs/path/turn-000N.json
turn: N
block kind: needs_input

Claude needs a decision before continuing:

1. [<header>] <question>
   Options (first = Claude's recommendation):
   - <label>: <description>
   - <label>: <description>
   (choose several)

Reply with one comment that answers each question by label or in free text,
then unblock this card:
/kanban comment TASK_ID "<your answers>"
/kanban unblock TASK_ID
```

Include the `(choose several)` line only when `multiSelect` is true.

## Procedure B: chat relay

Use this in an interactive session (CLI, TUI, Telegram, Discord, ...), either
to run claude-hc directly or when a Kanban `blocked` event wakes you.

Direct use:

1. Write the prompt to `DIR/.claude-hc/prompt.txt`, then
   `terminal(command="claude-hc --json --cwd DIR < DIR/.claude-hc/prompt.txt", background=true, notify=true, workdir=DIR)`
   and end your turn. Say that Claude is working and you will report back.
2. The completion arrives as `[IMPORTANT: Background process ... Output: <tail>]`.
   Parse the last line as JSON (or read `latest.json` for the session id in
   the tail).
3. `needs_input` and the rule says relay: call
   ```
   clarify(questions=[{id: "<header>", question: "[<header>] <question>\n<label>: <description>\n<label>: <description>", choices: ["<label>", "<label>"], multi_select: <multiSelect>}])
   ```
   Labels are the choices (buttons); descriptions ride in the question text
   because clarify choices are bare strings. Keep Claude's order (its
   recommendation first). At most 5 questions per clarify call; split longer
   lists. Build the answer text from the responses, write it to
   `DIR/.claude-hc/prompt.txt`, and launch the `-r` turn with `notify=true`.
4. `needs_input` and the rule says answer: write the answer text and launch
   the `-r` turn.
5. `done`: report `summary` and any spec path from `result_file`.
6. `error`: same table as Procedure A step 5, but tell the human instead of
   blocking a card; `session_busy` means wait with `claude-hc wait`.

Woken by a Kanban `blocked` event whose reason starts with
`claude-hc needs a decision`:

1. Read the card: `kanban_show(task_id=TASK_ID)` when the `kanban` toolset
   is enabled, otherwise `/kanban show TASK_ID`.
2. Find the newest comment that starts with `claude-hc session:` and present
   its questions with `clarify` exactly as above.
3. Post the answer text with `kanban_comment(task_id=TASK_ID, body=...)` and
   call `kanban_unblock(task_id=TASK_ID)`. Without the `kanban` toolset,
   reply with the two ready-to-send commands:
   `/kanban comment TASK_ID "<answer text>"` and `/kanban unblock TASK_ID`.

## Answer-or-relay rule

Answer on the human's behalf only when at least one holds:

- the card body, the thread, or the original request states the answer
  explicitly;
- the question is about your own execution context: paths, available tools,
  which repository, which branch.

Relay everything else: product, UX, scope, priority, naming, architecture,
and any question whose options are trade-offs. When you answer, use Claude's
first option unless the context contradicts it, and say in the answer text
that Hermes answered and why. Never invent a preference.

## Prompt hint

Append this line to the prompt on the first turn only:

```
Note: an automated relay (Hermes) forwards your questions to the user and each
question costs a round-trip. Batch independent clarifying questions into one
AskUserQuestion call (up to 4) when they do not depend on each other, and ask
only what the repository and the task description cannot answer.
```

## Pitfalls

- Never run claude-hc in the foreground: a turn takes minutes, foreground
  calls time out at 180 s by default, cap at 600 s, and any tool call is
  abandoned after 420 s.
- Never use a pseudo-terminal or stdin writes; claude-hc reads the answer as
  a new prompt, not from a live stdin.
- Never pass `notify` inside a Kanban worker; it is refused there. Poll.
- `session_busy` (exit 3) means another turn is running; wait, do not retry.
- Exit code 2 means the outcome is unknown; resume with `-r`.
- A cut JSON line is normal in a 2000-character tail; `latest.json` has it all.
- Brainstorming writes its spec into `docs/superpowers/specs/` in the
  repository; attach it on completion.
- Several sessions may run at once; locks are per session.
- Do not `kill` a running claude-hc unless the human asks; Claude's session
  survives on disk and resumes with `-r` anyway.

## Verification

- `claude-hc status SESSION_ID` shows `in_flight: false` and `last.status`
  `done`.
- The card thread contains a `claude-hc session:` marker for every question
  and one answer comment after each.
- The spec file exists when brainstorming reached that point, and its path is
  in the completion metadata.
````

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: `test/skill.test.ts` passes along with everything else.

- [ ] **Step 5: Commit**

```bash
git add hermes/skills/claude-hc/SKILL.md test/skill.test.ts
git commit -m "Add the claude-hc Hermes skill: Kanban worker loop and chat relay

Claude-Session: https://claude.ai/code/session_012M9tZCAV69BZskTEKVPxy2"
```

---

### Task 7: Contract test script (`scripts/hermes-sim.sh`)

**Files:**
- Create: `scripts/hermes-sim.sh`

**Interfaces:**
- Consumes: the built `dist/claude-hc.js` (Task 5) and `jq`.
- Produces: `npm run test:e2e` (script already registered in Task 1).

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
# Plays the Hermes side of the contract against real Claude:
# launch in the background, wait, parse the last line, answer with -r.
# Skipped unless CLAUDE_HC_E2E=1 (needs a logged-in Claude Code install and jq).
set -euo pipefail

if [ "${CLAUDE_HC_E2E:-}" != "1" ]; then
  echo "hermes-sim: skipped (set CLAUDE_HC_E2E=1 to run against real Claude)"
  exit 0
fi
command -v jq >/dev/null || { echo "hermes-sim: jq is required" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="node $ROOT/dist/claude-hc.js"
WORK="$(mktemp -d)"
export CLAUDE_HC_HOME="$WORK/home"
mkdir -p "$WORK/repo/.claude-hc"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "hermes-sim: FAIL: $*" >&2; exit 1; }

# Turn 1: force a clarifying question.
cat > "$WORK/repo/.claude-hc/prompt.txt" <<'EOF'
Before doing anything else, ask me exactly one clarifying question with the
AskUserQuestion tool: which color I prefer, with the options "Red" and "Blue".
Do not answer on my behalf and do not do anything else.
EOF

$BIN --json --cwd "$WORK/repo" --allowed-tools Read < "$WORK/repo/.claude-hc/prompt.txt" > "$WORK/out1.txt" 2> "$WORK/err1.txt" &
PID=$!
wait "$PID" && CODE=0 || CODE=$?
LINE="$(tail -n 1 "$WORK/out1.txt")"
echo "turn 1: exit=$CODE line=$LINE"
[ "$CODE" = "0" ] || fail "turn 1 exit code $CODE"
[ "$(echo "$LINE" | jq -r .status)" = "needs_input" ] || fail "turn 1 status"
[ "$(echo "$LINE" | jq '.questions | length')" -ge 1 ] || fail "turn 1 has no questions"
SESSION="$(echo "$LINE" | jq -r .session_id)"
RESULT_FILE="$(echo "$LINE" | jq -r .result_file)"
[ -f "$RESULT_FILE" ] || fail "result file missing: $RESULT_FILE"
[ "$(jq -r .status "$CLAUDE_HC_HOME/sessions/$SESSION/latest.json")" = "needs_input" ] || fail "latest.json status"
[ "$(echo "$LINE" | jq -c 'keys_unsorted')" = '["claude_hc","status","turn","summary","questions","result_subtype","exit_code","error","session_id","result_file"]' ] || fail "key order"

# status: nothing in flight between turns.
STATUS="$($BIN status "$SESSION")"
[ "$(echo "$STATUS" | jq -r .in_flight)" = "false" ] || fail "status in_flight"

# Turn 2: answer.
HEADER="$(echo "$LINE" | jq -r '.questions[0].header')"
QUESTION="$(echo "$LINE" | jq -r '.questions[0].question')"
cat > "$WORK/repo/.claude-hc/prompt.txt" <<EOF
Answers from the user:
[$HEADER] $QUESTION -> Red
Now reply with exactly the sentence: You chose Red.
EOF

$BIN --json --cwd "$WORK/repo" --allowed-tools Read -r "$SESSION" < "$WORK/repo/.claude-hc/prompt.txt" > "$WORK/out2.txt" 2> "$WORK/err2.txt" &
PID=$!
wait "$PID" && CODE=0 || CODE=$?
LINE2="$(tail -n 1 "$WORK/out2.txt")"
echo "turn 2: exit=$CODE line=$LINE2"
[ "$CODE" = "0" ] || fail "turn 2 exit code $CODE"
[ "$(echo "$LINE2" | jq -r .status)" = "done" ] || fail "turn 2 status"
[ "$(echo "$LINE2" | jq -r .turn)" = "2" ] || fail "turn 2 number"
[ "$(echo "$LINE2" | jq -r .session_id)" = "$SESSION" ] || fail "turn 2 session id"
[ -f "$CLAUDE_HC_HOME/sessions/$SESSION/turn-0002.json" ] || fail "turn-0002.json missing"
[ ! -f "$CLAUDE_HC_HOME/sessions/$SESSION/lock" ] || fail "lock left behind"

echo "hermes-sim: PASS (session $SESSION)"
```

- [ ] **Step 2: Make it executable and run the skipped path**

Run: `chmod +x scripts/hermes-sim.sh && npm run test:e2e`
Expected: `hermes-sim: skipped (set CLAUDE_HC_E2E=1 to run against real Claude)`, exit 0.

- [ ] **Step 3: Run it for real once**

Run: `npm run build && CLAUDE_HC_E2E=1 npm run test:e2e`
Expected: two `turn N:` lines and `hermes-sim: PASS (session <uuid>)`. If turn 1 comes back `done` because the model answered instead of asking, rerun once; the prompt is deliberately blunt and normally produces the question.

- [ ] **Step 4: Commit**

```bash
git add scripts/hermes-sim.sh
git commit -m "Add hermes-sim contract test that drives claude-hc like a Hermes worker

Claude-Session: https://claude.ai/code/session_012M9tZCAV69BZskTEKVPxy2"
```

---

### Task 8: Docs, version bump, final verification

**Files:**
- Modify: `package.json` (version), `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Bump the version**

In `package.json` set `"version": "0.4.0"`.

- [ ] **Step 2: Update `README.md`**

Replace the `## Usage` section's first paragraph and the CLI reference and exit-code tables, and add a Hermes section. Concretely:

1. In `### Examples`, append:

```bash
# Machine-readable mode: one JSON line as the last line of stdout
claude-hc --json --cwd /path/to/repo "brainstorm a caching layer" --allowed-tools Read,Glob,Grep

# Feed the prompt through stdin (safest when it contains quotes or newlines)
claude-hc --json --cwd /path/to/repo < prompt.txt

# Is a turn still running on this session? What did the last one produce?
claude-hc status <session_id>
claude-hc wait <session_id> --timeout 170
```

2. Replace the `## CLI reference` table with:

```markdown
| Flag | Description |
|---|---|
| `-r, --resume <session_id>` | Resume a specific session by its `session_id`. |
| `--json` | Print one JSON line as the last line of stdout instead of streaming text. See [JSON mode](#json-mode). |
| `--cwd <dir>` | Working directory for the Claude session (default: current directory). |
| `--allowed-tools <a,b,c>` | Comma-separated tools the agent may use without prompting (default: `Read,Write,Edit,Bash,Glob,Grep`). `AskUserQuestion` is always handled separately and doesn't need to be listed. |
| `--disallowed-tools <a,b,c>` | Comma-separated tools to block. See [Known limitations](#known-limitations) — this is the flag that's actually enforced. |
| `--model <name>` | Model to use (e.g. `claude-sonnet-5`). |
| `--max-turns <n>` | Cap on tool-use round-trips. |
| `-h, --help` | Show help. |

| Subcommand | Description |
|---|---|
| `status <session_id>` | Print whether a turn is in flight (with its pid) and the latest result. |
| `wait <session_id> [--timeout <s>]` | Block until no turn is in flight or the timeout (default 170 s) passes, then print the status. Exit 3 while still in flight. |
```

3. Replace the `### Exit codes` table with:

```markdown
| Code | Meaning |
|---|---|
| `0` | Success: the agent answered or asked a question (check `status` in JSON mode). |
| `1` | Non-success result (e.g. `--max-turns` hit), usage error, or a claude-hc error. |
| `2` | The session ended without ever producing a result message — the turn's outcome is unknown. See [Known limitations](#known-limitations). |
| `3` | Session busy: another claude-hc process holds this session's lock. Use `claude-hc wait`. |
```

4. Add, right after the exit-code table, the sections:

```markdown
### JSON mode

With `--json`, streaming text is suppressed and the last line of stdout is one
JSON object (progress still goes to stderr):

```json
{"claude_hc":1,"status":"needs_input","turn":2,"summary":"Two approaches fit...",
 "questions":[{"header":"Auth method","question":"Which auth method should we use?",
  "options":[{"label":"OAuth","description":"Browser login"},{"label":"API key","description":"Static key"}],
  "multiSelect":false}],
 "result_subtype":"success","exit_code":0,"error":null,
 "session_id":"9f2c...","result_file":"/Users/you/.claude-hc/sessions/9f2c.../turn-0002.json"}
```

`status` is `done`, `needs_input`, or `error`; `questions` mirrors the
`AskUserQuestion` input; `error` is `null` or `{"code","message"}` with codes
`session_busy`, `no_result_message`, `non_success_result`, `usage`,
`exception`. `session_id` and `result_file` are the last keys so a truncated
tail still ends with them.

### Result files and the session lock

Every turn (JSON or text mode) writes
`$CLAUDE_HC_HOME/sessions/<session_id>/turn-NNNN.json` and a `latest.json`
copy with the full text, the questions, timing, and cost. `CLAUDE_HC_HOME`
defaults to `~/.claude-hc`. A `lock` file in the same directory holds the pid
of the running turn; resuming a session while its lock pid is alive fails
with exit code 3 instead of interleaving two turns into one transcript. Stale
locks (dead pid) are cleared automatically.

## Driving claude-hc from another agent (Hermes)

`hermes/skills/claude-hc/SKILL.md` is a Hermes Agent skill that runs
claude-hc as a background process, polls or gets notified when a turn ends,
relays Claude's questions to the human (through the Kanban board or
`clarify`), and resumes with `-r`. Install it on each Hermes profile that
needs it:

```bash
hermes -p <profile> skills install berangberangteknologi-id/claude-hc/hermes/skills/claude-hc
```

It requires Hermes v0.21.1 or newer. The design behind it is in
`docs/superpowers/specs/2026-09-08-hermes-claude-hc-integration-design.md`.
```

5. In `## How it works`, add a bullet:

```markdown
- **Session lock and result files**: a turn holds `~/.claude-hc/sessions/<id>/lock`
  while it runs and writes `turn-NNNN.json` plus `latest.json` when it ends,
  so an orchestrator can always find out what happened without parsing prose.
```

- [ ] **Step 3: Update `CHANGELOG.md`**

Insert above the `## [0.3.0]` entry:

```markdown
## [0.4.0] - 2026-09-08

### Added

- `--json`: one machine-readable JSON line as the last line of stdout with
  `status` (`done` / `needs_input` / `error`), the `AskUserQuestion`
  questions verbatim, a 300-character summary, the session id, and the result
  file path. Streaming text is suppressed in this mode; progress still goes
  to stderr.
- Result files: every turn writes
  `$CLAUDE_HC_HOME/sessions/<session_id>/turn-NNNN.json` and `latest.json`
  (`CLAUDE_HC_HOME` defaults to `~/.claude-hc`).
- Session lock: resuming a session while another claude-hc process is still
  running it fails fast with the new exit code `3` (`session_busy`) instead of
  interleaving two turns into one transcript. Stale locks are cleared
  automatically; the lock is released on SIGINT/SIGTERM.
- `claude-hc status <session_id>` and `claude-hc wait <session_id> [--timeout s]`.
- `--cwd <dir>` to bind the Claude session to a repository regardless of the
  launch directory.
- The wrapper process now forwards SIGINT/SIGTERM to the worker.
- A Hermes Agent skill (`hermes/skills/claude-hc/SKILL.md`) that drives
  claude-hc from Kanban workers and chat sessions, and `scripts/hermes-sim.sh`,
  a contract test that plays the Hermes side against real Claude
  (`CLAUDE_HC_E2E=1 npm run test:e2e`).
- Unit tests (`npm test`) with an injectable fake `query()`.

### Changed

- `src/claude-hc.ts` is now only the entry point; behavior moved to
  `cli.ts`, `run.ts`, `session-store.ts`, and `output.ts`. Text-mode output
  is unchanged.

[0.4.0]: https://github.com/berangberangteknologi-id/claude-hc/compare/v0.3.0...v0.4.0
```

- [ ] **Step 4: Full verification**

Run: `npm run build && npm run check && npm test && npm run test:e2e && node dist/claude-hc.js --help | grep -c "status <session_id>"`
Expected: build ok, no type errors, all tests pass, e2e prints the skipped line (or PASS when `CLAUDE_HC_E2E=1`), and the grep prints `2` (usage line and subcommand line).

- [ ] **Step 5: Commit**

```bash
git add package.json README.md CHANGELOG.md
git commit -m "Release v0.4.0: JSON mode, result files, session lock, status/wait, Hermes skill

Claude-Session: https://claude.ai/code/session_012M9tZCAV69BZskTEKVPxy2"
```

---

## Manual validation checklist (after the tasks, on Hermes v0.21.1 or newer)

Not part of the automated plan; documented so the executor and the reviewer
know what "done" looks like end to end. Requires `hermes update` on the
validation machine first.

1. Install the skill on the chat profile and on a worker profile, e.g. `coder`:
   `hermes -p coder skills install berangberangteknologi-id/claude-hc/hermes/skills/claude-hc`
   (or symlink `hermes/skills/claude-hc` into `~/.hermes/profiles/coder/skills/software-development/`).
2. CLI chat session: ask Hermes to "use the claude-hc skill to brainstorm a
   caching layer in <repo>"; confirm the launch uses `background=true,
   notify=true`, the completion wakes Hermes, and `clarify` shows the question.
3. Telegram chat session: same, with inline buttons.
4. Kanban: `/kanban create "Brainstorm: caching layer" --assignee coder --skill claude-hc --body "<repo path>; run superpowers:brainstorming for a caching layer"`
   from Telegram; answer at least three consecutive questions with
   `/kanban comment` and `/kanban unblock`; confirm the card never reaches
   `triage` (alternating block kinds), heartbeats keep the claim alive, and
   `kanban_complete` metadata carries `claude_session_id` and `result_file`.
