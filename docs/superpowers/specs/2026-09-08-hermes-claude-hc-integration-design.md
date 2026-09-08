# Design: driving claude-hc from Hermes Agent (Kanban workers and chat relays)

Date: 2026-09-08
Status: approved in brainstorming, awaiting spec review
Research: `docs/superpowers/research/2026-09-08-hermes-agent-integration-research.md`

## 1. Goal and scope

Let any Hermes Agent (upstream v0.21.1 or newer) run an interactive Claude Code
session through `claude-hc` without blocking Hermes while Claude works. The
reference scenario is `superpowers:brainstorming`, where Claude interviews the
human one question at a time, but the protocol is generic: any claude-hc turn
that ends in `AskUserQuestion` is handled the same way.

The primary caller is a **Hermes Kanban worker** (a one-shot `chat -q`
subprocess spawned by the dispatcher). Human input reaches the worker through
the board: comment, block, unblock, respawn. A second caller is an interactive
**chat session** (CLI or a messaging platform such as Telegram) that is woken
by a background-process completion or by a Kanban `blocked` event and relays
the question to the human with `clarify`.

Decisions taken during brainstorming:

| Decision | Choice |
|---|---|
| Who answers a question | Hermes decides per question: answers itself when the context determines the answer, otherwise relays to the human |
| Surfaces | Kanban worker first; CLI and one messaging platform (Telegram assumed) as the human-facing side, both validated from day one |
| Scope | Generic interactive sessions, brainstorming as the reference case, including its spec-review gate and hand-off to writing-plans inside the same Claude session |
| Execution ownership | Approach A: Hermes owns background execution; claude-hc owns the output contract |
| Human loop on Kanban | comment + `kanban_block(kind=needs_input)` + unblock + respawn |
| Unblock-loop breaker | Alternate the block kind (`needs_input`, untyped, `needs_input`, ...) |

Non-goals: a claude-hc job runner with its own detached workers (Approach B),
a persistent stdin-driven process (Approach C), answering `AskUserQuestion`
in-process via `updatedInput`, and a Kanban worker lane that wraps Claude Code
directly (Hermes documents that path as unpaved).

## 2. Architecture

Three components, one contract:

- **claude-hc** (this repo) stays a one-shot CLI. New: a `--json` output mode,
  per-session result files, a per-session lock, `status` and `wait`
  subcommands, and `--cwd`.
- **The `claude-hc` Hermes skill** (`hermes/skills/claude-hc/SKILL.md` in this
  repo) teaches two procedures: the Kanban worker loop and the chat relay.
- **State**, each piece owned by exactly one store:
  - the conversation: Claude Code's own session transcript
    (`~/.claude/projects/<cwd-slug>/<session_id>.jsonl`);
  - the last turn's output: claude-hc result files under
    `$CLAUDE_HC_HOME/sessions/<session_id>/`;
  - the interview record: the Kanban card thread (questions, answers, session
    id, block kind) and the completion `metadata`.

Constraints the design honors (see research section 4): Hermes tool calls
have hard ceilings (180 s default, 600 s foreground cap, 420 s sequential
deadline), so claude-hc always runs as a Hermes background process; a
completion notification carries only the last 2000 characters of merged
stdout and stderr; Kanban workers cannot receive notifications and must poll;
background stdin is `/dev/null`; `clarify` is unavailable in workers and
subagents; Hermes may kill processes on session close or inactivity reaping.

## 3. claude-hc changes

### 3.1 CLI surface

```
claude-hc "prompt" [-r <session_id>] [--json] [--cwd <dir>]
          [--allowed-tools a,b] [--disallowed-tools a,b] [--model m] [--max-turns n]
echo "prompt" | claude-hc [options]
claude-hc status <session_id>
claude-hc wait <session_id> [--timeout <seconds>]
claude-hc --help
```

New flags and subcommands:

| Item | Behavior |
|---|---|
| `--json` | Suppress streaming assistant text on stdout; print exactly one JSON line as the last line of stdout when the turn ends (section 3.2). Tool-use progress lines still go to stderr. The `[claude-hc] session_id:` stderr line is omitted in this mode. |
| `--cwd <dir>` | Passed as the SDK `cwd` option. Must exist; otherwise usage error (exit 1). Default: the process working directory. |
| `status <id>` | Print the session status JSON (section 3.5). Exit 0. |
| `wait <id> [--timeout s]` | Block until the session lock is released or the timeout (default 170 s) passes, polling once per second, then print the status JSON. Exit 0 when no turn is in flight, 3 when one still is. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Turn ended with `result.subtype === "success"`, whether Claude answered or asked a question |
| 1 | Non-success result (for example `error_max_turns`), usage error, or an exception |
| 2 | The SDK stream ended without a `result` message (outcome unknown) |
| 3 | `session_busy`: another claude-hc process holds this session's lock |

Existing behavior that does not change: one-shot execution, the
`AskUserQuestion` deny message, tool auto-approval semantics, the self re-exec
with `CLAUDE_CODE_*` stripped, text-mode output, `-r` requiring an explicit
session id.

### 3.2 JSON output contract (`--json`)

One line, UTF-8, no pretty-printing, written to stdout after the result file
has been written, followed by a newline, then the process exits. Keys are
emitted in this order so that a tail cut at 2000 characters still ends with the
session id and the result file path:

```json
{"claude_hc":1,
 "status":"needs_input",
 "turn":2,
 "summary":"Two approaches fit. Before choosing I need to know which auth ...",
 "questions":[{"header":"Auth method","question":"Which auth method should we use?",
   "options":[{"label":"OAuth","description":"Browser login, refresh tokens"},
              {"label":"API key","description":"Static key in the environment"}],
   "multiSelect":false}],
 "result_subtype":"success",
 "exit_code":0,
 "error":null,
 "session_id":"9f2c1c7e-...",
 "result_file":"/Users/me/.claude-hc/sessions/9f2c1c7e-.../turn-0002.json"}
```

Field rules:

- `claude_hc`: schema version, integer, `1`.
- `status`: `"error"` when `exit_code` is not 0; else `"needs_input"` when
  `questions` is non-empty; else `"done"`.
- `turn`: 1-based count of claude-hc invocations on this session (section 3.3),
  or `null` when no turn was started (`session_busy`, usage error).
- `summary`: the final assistant text of the turn, whitespace collapsed,
  truncated to 300 characters with a trailing `...` when cut; `""` when there
  is no text.
- `questions`: every `AskUserQuestion` call seen in the turn, concatenated in
  call order, each question copied verbatim from the tool input: `header`,
  `question`, `options[{label, description}]` (the optional `preview` is
  dropped), `multiSelect`. Empty array when none.
- `result_subtype`: the SDK result subtype, or `null` when no result arrived.
- `exit_code`: the process exit code.
- `error`: `null`, or `{"code": <code>, "message": <text>}` with `code` one of
  `session_busy`, `no_result_message`, `non_success_result`, `usage`,
  `exception`.
- `session_id`: the Claude session id, or `null` when it was never learned
  (for example a usage error before `init`).
- `result_file`: absolute path of this turn's result file, or `null` when none
  was written (no session id).

The JSON line is printed on every exit path in `--json` mode, including usage
errors and `session_busy`, so a caller never has to parse prose. The write is
flushed before `process.exit`. A refused run (`session_busy`) or a usage error
never writes a result file, so the in-flight turn's `latest.json` is never
clobbered; `turn` and `result_file` are `null` in that line.

### 3.3 Result files

Location: `$CLAUDE_HC_HOME/sessions/<session_id>/`, with `CLAUDE_HC_HOME`
defaulting to `~/.claude-hc`. Created on first use with mode `0700`.

Per turn, `turn-NNNN.json` (zero-padded to 4 digits) and an identical copy
`latest.json`. `NNNN` is the number of existing `turn-*.json` files plus one,
computed when the session id becomes known (immediately for `-r`, at the
`system/init` message for a new session). Files are written in every mode,
not only `--json`, so `status` and `wait` work regardless of how the turn was
launched.

Content: every field of the JSON line, plus:

| Field | Value |
|---|---|
| `text` | full final assistant text of the turn (all text blocks, concatenated) |
| `prompt` | the prompt as sent |
| `resume_from` | the `-r` value, or `null` |
| `cwd` | the effective working directory |
| `started_at`, `ended_at` | ISO-8601 timestamps |
| `duration_ms` | wall-clock duration |
| `num_turns`, `total_cost_usd` | from the result message when present |
| `allowed_tools`, `disallowed_tools`, `model`, `max_turns` | as configured |
| `claude_hc_version` | package version |

The file is written once, at the end of the turn, before the JSON line is
printed. Consumers therefore never observe a partial file.

### 3.4 Session lock

Path: `$CLAUDE_HC_HOME/sessions/<session_id>/lock`, JSON content
`{"pid": <worker pid>, "started_at": "<ISO>", "turn": <n>}`. The pid is the
re-exec'd worker (the process that runs `query()`), not the wrapper.

- Acquisition: for `-r`, before `query()` starts; for a new session, at the
  `init` message. Creation uses an exclusive create (`wx`). If the file exists,
  read its pid: if the pid is alive, fail with `session_busy` (exit 3, JSON
  error containing the pid and `started_at`); if the pid is dead, delete the
  stale lock and retry the exclusive create once.
- Release: on every exit path (`finally`), and from `SIGINT` and `SIGTERM`
  handlers, which remove the lock and then exit with 130 or 143.
- Liveness check: `process.kill(pid, 0)`, treating `EPERM` as alive.
- The lock guards only against two claude-hc processes on the same session; it
  does not lock Claude Code's own store.

### 3.5 `status` and `wait` output

```json
{"claude_hc":1,"session_id":"9f2c...","session_dir":"/Users/me/.claude-hc/sessions/9f2c...",
 "in_flight":true,"pid":48213,"lock_started_at":"2026-09-08T04:10:00Z",
 "last":{ ...contents of latest.json or null... }}
```

`in_flight` is true when the lock exists and its pid is alive (a stale lock is
deleted and reported as not in flight). `last` is `null` when the session
directory does not exist. `wait` polls every second until `in_flight` is false
or the timeout elapses, then prints the same object; exit 0 when not in
flight, 3 otherwise. `status` and `wait` never start Claude and never need
network access.

### 3.6 Code structure

`src/claude-hc.ts` is split into modules with one responsibility each:

| Module | Responsibility | Depends on |
|---|---|---|
| `cli.ts` | argument parsing, help text, subcommand dispatch, exit codes | `run.ts`, `session-store.ts`, `output.ts` |
| `session-store.ts` | home directory, session directories, turn numbering, result files, lock acquire/release, liveness | `node:fs`, `node:path`, `node:os` |
| `output.ts` | text-mode printing (unchanged behavior), JSON line building and key ordering, summary truncation, question extraction | none |
| `run.ts` | the `query()` loop for one turn, `canUseTool`, collection of text and questions, result handling | `@anthropic-ai/claude-agent-sdk`, `session-store.ts` |
| `claude-hc.ts` | entry point: re-exec guard, then `cli.ts` | `cli.ts` |

`run.ts` accepts its `query` function as a parameter (defaulting to the SDK's)
so tests can inject a fake that replays scripted `SDKMessage`s. The build stays
`tsc -p tsconfig.json`; the `bin` entry stays `dist/claude-hc.js`.

## 4. The Hermes skill

### 4.1 Location, install, frontmatter

Path in this repo: `hermes/skills/claude-hc/SKILL.md`. Install on every
profile that needs it (profiles keep separate skill sets):

```
hermes -p <worker-profile> skills install berangberangteknologi-id/claude-hc/hermes/skills/claude-hc
hermes -p <chat-profile>   skills install berangberangteknologi-id/claude-hc/hermes/skills/claude-hc
```

A symlink into `~/.hermes/skills/<category>/claude-hc/` works for local
development. Cards pin the skill with `--skill claude-hc`; otherwise the model
finds it in the skill index by description.

```yaml
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
```

### 4.2 Body sections, in order

1. **When to use.** Any Claude Code task that may ask clarifying questions;
   `superpowers:brainstorming` as the worked example. For pure one-shot
   `claude -p` work, point to the bundled `claude-code` skill.
2. **Prerequisites.** `claude-hc` on `PATH`, `claude setup-token` done,
   `ANTHROPIC_API_KEY` unset, the superpowers plugin installed in Claude Code,
   Hermes v0.21.1 or newer (`process` is an alias of `process_manage` on
   slightly older builds).
3. **Contract cheat sheet.** The command lines of section 3.1, the JSON fields
   and their order, exit codes, the result file path pattern, `status` and
   `wait`, and the answer text format (section 4.5).
4. **Procedure A: Kanban worker** (section 4.3).
5. **Procedure B: chat relay** (section 4.4).
6. **Answer-or-relay rule** (section 4.6).
7. **Prompt hint for relayed sessions** (section 4.7).
8. **Pitfalls.** Never foreground (180 s default, 600 s cap, 420 s tool
   deadline); never `pty`; never `notify` in a Kanban worker (it is refused);
   `session_busy` means wait, not retry; exit code 2 means resume; a cut JSON
   line means read `latest.json`; spec files land in `docs/superpowers/specs/`
   inside the workspace; parallel sessions are fine because locks are per
   session; never `kill` a running claude-hc unless the human asks.
9. **Verification.** `claude-hc status <id>` shows `done`; the card thread has
   the session id and every answer; the spec file exists when brainstorming
   reached that point.

### 4.3 Procedure A: Kanban worker

1. `kanban_show()`. Read the body (repo path, prompt) and the thread. If the
   thread contains a `claude-hc session:` marker, this is a resume (step 7).
2. Launch the first turn. Let `DIR` be the absolute repo directory named in
   the card body, or the absolute workspace path otherwise (the literal path,
   not `$HERMES_KANBAN_WORKSPACE`; Hermes does not expand variables in
   `workdir`). Write the prompt (plus the hint from section 4.7) to
   `DIR/.claude-hc/prompt.txt` with `write_file`, so quoting and newlines never
   go through the shell, then:
   ```
   terminal(command="claude-hc --json --cwd DIR < DIR/.claude-hc/prompt.txt",
            background=true, workdir=DIR)
   ```
   claude-hc reads the prompt from stdin when no positional prompt is given.
   Do not pass `notify` (refused in workers) and do not pass `pty`.
3. Wait: `process_manage(action="wait", session_id=<proc id>, timeout=180)`.
   On `status: "timeout"` call `kanban_heartbeat(note="claude-hc turn <n> running <uptime>s")`
   and wait again. On `status: "interrupted"` wait again. On `status: "exited"`
   continue.
4. Read the result: the last line of `output` is the JSON line. If it does not
   parse as a complete object, extract `session_id` from the tail and
   `read_file("$CLAUDE_HC_HOME/sessions/<session_id>/latest.json")`.
5. Branch on `status`:
   - `done`: go to step 9.
   - `needs_input`: apply the answer-or-relay rule (section 4.6). If answering,
     go to step 6. If relaying, go to step 8.
   - `error`: `no_result_message` or `non_success_result` with
     `result_subtype: "error_max_turns"` → resume (step 6) with the text
     "The previous turn was interrupted. Continue where you left off." or
     "Continue." `session_busy` → run `claude-hc wait <id> --timeout 170` as
     a background process, wait on it, then retry. Any other error → post a
     `kanban_comment` with the error and `kanban_block(reason="claude-hc failed: <message> (session <id>)", kind="transient")`.
6. Resume: write the answer text (section 4.5) to `DIR/.claude-hc/prompt.txt`
   and launch `claude-hc --json --cwd DIR -r <session_id> < DIR/.claude-hc/prompt.txt`
   exactly as in step 2, then go to step 3.
7. Resume after respawn: take the newest `claude-hc session:` marker in the
   thread (session id, result file, block kind used). Run
   `claude-hc status <session_id>` in the foreground (`timeout=30`); if
   `in_flight` is true, run `claude-hc wait <session_id> --timeout 170` in the
   background and wait on it until `in_flight` is false. Then read `last`: if
   its `status` is `done`, go to step 9; otherwise the human's answer is the
   newest comment after the marker that is not authored by this profile;
   convert it to the answer text (section 4.5) and go to step 6. If no such
   comment exists, re-post the question comment and block again (step 8).
8. Relay: post one `kanban_comment` using the template below, then
   `kanban_block(reason="claude-hc needs a decision: <headers joined by ', '> (session <id>)", kind=<K>)`
   and stop. `K` alternates: read the `block kind:` line of the newest
   `claude-hc session:` marker in the thread; if it says `needs_input`, omit
   `kind` this time; otherwise (no marker, or `untyped`) use
   `kind="needs_input"`. Record the kind used in the comment.
9. Complete: `kanban_complete(summary=<final text, first 400 chars>, metadata={"claude_session_id": <id>, "result_file": <path>, "turns": <n>, "spec_path": <path or null>}, artifacts=[<spec path if it exists>])`.

Comment template (step 8):

```
claude-hc session: <session_id>
result file: <result_file>
turn: <n>
block kind: needs_input | untyped

Claude needs a decision before continuing:

1. [<header>] <question>
   Options (first = Claude's recommendation):
   - <label>: <description>
   - <label>: <description>
   (choose several) ← only when multiSelect is true

Reply with one comment that answers each question by label or in free text,
then unblock this card (/kanban comment <task_id> "..." and /kanban unblock <task_id>).
```

### 4.4 Procedure B: chat relay

Used by an interactive session on the CLI or a messaging platform.

Direct use (no Kanban): write the prompt to `DIR/.claude-hc/prompt.txt` and
launch `terminal(command="claude-hc --json --cwd DIR < DIR/.claude-hc/prompt.txt", background=true, notify=true, workdir=DIR)`,
then end the turn. The completion arrives as
`[IMPORTANT: Background process ... Output: <tail>]`; parse the JSON line (or
`latest.json`), then:

- `needs_input` and the answer-or-relay rule says relay: call
  `clarify(questions=[{id: <header>, question: "[<header>] <question>\n<label>: <description>\n...", choices: [<labels in Claude's order>], multi_select: <multiSelect>}])`.
  `clarify` choices are bare strings, so the labels are the choices (kept
  short for buttons) and the descriptions ride in the question text as a
  legend. One entry per question; at most 5 per call, so split when longer.
  Convert the responses to the answer text and launch the resume turn with
  `notify=true`.
- `needs_input` and the rule says answer: launch the resume turn directly.
- `done`: report the summary and where the spec was written.
- `error`: follow the same table as step 5 of Procedure A, but tell the human
  instead of blocking a card.

Woken by a Kanban `blocked` event (the reason starts with
`claude-hc needs a decision`): read the card (`kanban_show(task_id=...)` when
the `kanban` toolset is enabled, else `/kanban show <id>`), find the newest
comment with the template above, present the questions with `clarify` exactly
as above, then post the answer text with `kanban_comment(task_id, body=...)`
and call `kanban_unblock(task_id)`. Without the `kanban` toolset, reply to the
human with the ready-to-send commands:
`/kanban comment <id> "<answer text>"` and `/kanban unblock <id>`.

### 4.5 Answer text format

The resume prompt is plain text. Both procedures format it as:

```
Answers from the user:
[<header>] <question> -> <label or free text>
[<header>] <question> -> <label>, <label>
<optional free text the user added>
```

Multi-select answers are comma-separated labels. A free-text answer is copied
verbatim after the arrow. The format is a convention for Claude's benefit;
claude-hc does not parse it.

### 4.6 Answer-or-relay rule

Answer without the human only when at least one of these holds:

- the card body, the thread, or the original request states the answer
  explicitly;
- the question is about the agent's own execution context (paths, available
  tools, which repository, which branch).

Everything else is relayed: product, UX, scope, priority, naming, architecture,
and any question whose options are trade-offs. When answering, use Claude's
first option unless the context contradicts it, and say in the answer text that
Hermes answered on the human's behalf and why. Never invent a preference.

### 4.7 Prompt hint

On the first turn only, the worker appends this line to the prompt:

```
Note: an automated relay (Hermes) forwards your questions to the user and each
question costs a round-trip. Batch independent clarifying questions into one
AskUserQuestion call (up to 4) when they do not depend on each other, and ask
only what the repository and the task description cannot answer.
```

## 5. Sequence: brainstorming on a Kanban card

1. Human: `/kanban create "Brainstorm: <topic>" --assignee coder --skill claude-hc --body "<repo path>; run superpowers:brainstorming for <topic>"` from Telegram (chat auto-subscribed with notify+wake).
2. Dispatcher spawns the worker; steps 1 to 4 of Procedure A run; claude-hc turn 1 ends with `needs_input`.
3. Worker cannot answer, posts the comment, blocks with `kind=needs_input`, exits. Dispatcher records the run as `blocked`.
4. Notifier delivers the `blocked` reason to Telegram and wakes the chat agent; the agent shows `clarify` buttons; the human taps; the agent comments and unblocks (or the human runs the two `/kanban` commands).
5. Dispatcher respawns; the new worker follows step 7, resumes with `-r`, claude-hc turn 2 ends with `needs_input` again.
6. Worker blocks untyped this time (kind alternation), and so on.
7. Eventually turn N ends with `done` (design approved, spec written to `docs/superpowers/specs/` in the repo). Worker completes the card with the session id, result path, and the spec as an artifact.
8. Human continues in the same Claude session later with `claude-hc -r <id> "..."` or a new card that carries the session id in its body.

## 6. Error handling matrix

| Situation | Signal | Handling |
|---|---|---|
| Worker killed mid-turn (stale lock) | next `-r` finds a dead pid | lock cleared automatically; resume with the "previous turn was interrupted" note |
| Worker killed, claude-hc still running | `session_busy` (exit 3) | `claude-hc wait`, then resume |
| Stream ended without result | exit 2, `no_result_message` | resume with `-r` |
| `error_max_turns` | exit 1, `non_success_result` | resume with "Continue." |
| Provider or SDK error | exit 1, `exception` or `non_success_result` | block with `kind="transient"` and the message; human retries with unblock |
| JSON line cut in a notification or wait tail | last line not parseable | read `latest.json` from the session id in the tail |
| Session id lost | no marker in the thread | list `$CLAUDE_HC_HOME/sessions/` by mtime as a last resort; the comment template exists to prevent this |
| Human comments during a running turn | steer text in the next tool result | treat as the answer if a question is pending, else prepend to the next prompt |
| Loop breaker | `block_loop_detected`, card in `triage` | should not occur with kind alternation; if it does, the human moves the card from the dashboard and the worker resumes normally |
| Several cards at once | none | independent sessions and locks; shared `$CLAUDE_HC_HOME` is safe |

## 7. Testing

Unit tests (`node:test`, run with `tsx`, no network), with `query` injected as
a fake that replays scripted `SDKMessage`s:

- `cli.ts`: flag parsing including `--json`, `--cwd`, subcommands, usage
  errors and their exit codes.
- `output.ts`: JSON line content and exact key order for `done`,
  `needs_input`, and `error`; summary truncation at 300 characters; question
  extraction from one and from several `AskUserQuestion` calls; text mode
  output unchanged against a golden string.
- `session-store.ts`: home override via `CLAUDE_HC_HOME`, turn numbering,
  `latest.json` copy, lock acquire on a fresh session, `session_busy` on a live
  pid, stale-lock recovery, release on signal.
- `run.ts`: a scripted turn that asks a question yields `needs_input`, a plain
  turn yields `done`, a stream without result yields exit 2, a non-success
  result yields exit 1, and the result file is written before the JSON line.

Contract test (`scripts/hermes-sim.sh`): a shell script that plays Hermes,
launches claude-hc in the background, waits, parses the last line with `jq`,
answers with `-r`, and asserts the `needs_input` to `done` transition and the
files on disk. It runs against real Claude only when `CLAUDE_HC_E2E=1` is set
and is skipped otherwise.

Manual checklist (documented in the README) on Hermes v0.21.1 or newer, after
`hermes update` on the validation machine:

1. CLI chat session: launch with `notify=true`, confirm the completion wakes
   the agent and `clarify` shows the questions.
2. Telegram chat session: same, with inline buttons.
3. Kanban card created from Telegram, answered with `/kanban comment` and
   `/kanban unblock` for at least three consecutive questions; confirm the card
   never reaches `triage`, heartbeats keep the claim alive, and the completion
   metadata carries the session id and result path.

## 8. Compatibility and requirements

- claude-hc: Node 18 or newer, `@anthropic-ai/claude-agent-sdk` 0.3.x, a
  logged-in Claude Code install. Version bump to 0.4.0 (additive).
- Hermes: v0.21.1 (2026-09-07) or newer for the skill as written. On v0.21.0
  the tool is still called `process` (alias kept upstream). Older builds lack
  `notify`, `process_manage`, and the loop-breaker semantics described here;
  the skill states the minimum version.
- Nothing depends on a specific profile, platform, or board configuration.
  Telegram is the assumed messaging platform for validation only.

## 9. Follow-ups outside this design

- Upstream issue for Hermes: exempt `needs_input` re-blocks with a different
  reason from the unblock-loop breaker, or key the counter on the reason.
- Approach B (a claude-hc job runner) if killed turns prove common in practice.
- An in-run wait variant for boards whose worker profiles have messaging tools.
