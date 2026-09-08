# Research: driving claude-hc from Hermes Agent (background, interactive)

Date: 2026-09-08
Goal: let a Hermes Agent session call `claude-hc` to run an interactive skill such
as `superpowers:brainstorming`, where Claude interviews the human one question at
a time, without blocking Hermes while Claude works.

Sources of truth used:

- claude-hc `v0.3.0` (this repo) and the installed `@anthropic-ai/claude-agent-sdk`
  `0.3.246` type definitions (`node_modules/.../sdk.d.ts`, `sdk-tools.d.ts`).
- Hermes Agent upstream `main` as of 2026-09-08 (`v0.21.1`, commit `520e63661c`),
  read from the GitHub tarball. The locally installed Hermes (`v0.20.5`,
  2026-08-19) is ~8k commits behind; where the two differ the upstream behavior is
  recorded and the local one is noted.
- Official Claude Code / Agent SDK docs (via a research agent, URLs inline).
- Hermes online docs (https://hermes-agent.nousresearch.com/docs/, built from
  `website/docs` on `main`) and the GitHub release notes for v2026.8.27,
  v2026.8.31 (v0.21.0) and v2026.9.7 (v0.21.1), via a second research agent.
  Where docs and code disagree (tool name `process`, delegation defaults,
  clarify timeouts) the code is recorded here.

## 1. What claude-hc does today

- One-shot: runs one turn via `query()`, streams assistant text to stdout, exits.
- `AskUserQuestion` is routed through `canUseTool`, printed as text (question,
  numbered options), then **denied** with the message "Already shown to the user
  above — their reply will be your next message. End your turn now." The turn ends
  normally (`result.subtype === "success"`).
- The answer is delivered by re-running `claude-hc "<answer>" -r <session_id>`.
- `session_id` is printed to **stderr** as `[claude-hc] session_id: <uuid>`.
- Exit codes: `0` success, `1` non-success result or error, `2` stream ended
  without a `result` message (outcome unknown, session may still be resumable).
- Re-execs itself once with `CLAUDE_CODE_*` env stripped, `detached: true`,
  `stdio: inherit`, so it is not treated as a child of a live Claude Code session.
- Tools in `--allowed-tools` are bare-listed (auto-approved); every other tool
  falls through to `canUseTool` and is denied. `AskUserQuestion` is never listed.
- Uses the local Claude Code install as-is (plugins, MCP servers, settings), so
  the superpowers plugin skills (including `brainstorming`) are available inside
  a claude-hc session.

## 2. Claude Agent SDK facts that matter (types in `0.3.246`)

`AskUserQuestionInput` (`sdk-tools.d.ts`):

```ts
{
  questions: [ {                // 1-4 questions
    question: string;           // full question text
    header: string;             // chip label, max 12 chars
    options: [ {                // 2-4 options
      label: string; description: string; preview?: string;
    } ];
    multiSelect: boolean;
  } ];
  answers?: { [questionText: string]: string };   // filled by the host
  annotations?: { [questionText: string]: { preview?: string; notes?: string } };
}
```

The permission-component variant of the same schema documents `answers` as
"question text -> answer string; multi-select answers are comma-separated" and
adds `response?: string` for freeform text the user typed instead of an option.

`PermissionResult` (`sdk.d.ts:2242`):

```ts
| { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: ...; toolUseID?: string }
| { behavior: 'deny';  message: string; interrupt?: boolean; toolUseID?: string }
```

So a host can answer in-process by returning `allow` with
`updatedInput: { questions, answers }`. claude-hc deliberately does not (it
denies and exits) so that every invocation stays one-shot.

`Options` keys relevant here: `cwd`, `env`, `resume`, `sessionId`,
`forkSession`, `persistSession`, `maxTurns`, `maxBudgetUsd`, `permissionMode`,
`allowedTools`, `disallowedTools`, `canUseTool`, `outputFormat` (JSON schema
structured output, lands in `result.structured_output`), `systemPrompt`,
`settingSources`, `includePartialMessages`, `hooks`, `stderr` callback,
`abortController`, `pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess`.

`Query` methods: `interrupt()`, `streamInput(asyncIterable)` (multi-turn in one
process), `close()`, `setPermissionMode()`, `setModel()`.

`SDKResultMessage` fields: `subtype` (`success` or `error_*`), `result`,
`session_id`, `num_turns`, `total_cost_usd`, `stop_reason`, `terminal_reason`,
`permission_denials`, `structured_output?`.

Docs (https://code.claude.com/docs/en/agent-sdk/user-input.md,
https://code.claude.com/docs/en/sessions.md):

- Plain `claude -p` denies `AskUserQuestion`; the SDK without `canUseTool` too.
- Sessions live in `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`;
  `--resume <id>` is looked up across projects, so resuming from another cwd
  works. Nothing documents locking: two concurrent resumes interleave.
- `AskUserQuestion` is not available inside subagents.

## 3. Hermes Agent facts (upstream `main`, v0.21.1)

### 3.1 Tool-call loop

- One tool call per model turn runs on the main thread; several run concurrently
  in a thread pool. Interactive tools (`clarify`) force sequential execution.
- A sequential tool call has a deadline: `timeouts.tools.sequential_call`, else
  the concurrent batch timeout, default **420 s** (`agent/tool_executor.py:110`,
  `:767`). Only `delegate_task` is exempt. A foreground tool call that runs longer
  is abandoned.
- A new user message while the agent is busy follows `display.busy_input_mode`
  (default `interrupt`): the run is interrupted and `process_manage(wait)`
  returns `{"status":"interrupted", ...}`. Since 2026-09-05 a running
  foreground command is not killed but adopted as a notify-on-complete
  background process (`status: "yielded_to_background"`). Background processes
  keep running. `/stop` is a hard stop.

### 3.2 `terminal` tool (`tools/terminal_tool.py`)

Parameters: `command`, `background` (bool), `timeout` (default **180 s**,
foreground max **600 s**; a foreground request above 600 s is auto-promoted to a
tracked background process with notify), `workdir`, `pty` (background only),
`notify` (`true` = one notification on exit; `[patterns]` = notify on output
match, rate-limited). Legacy `notify_on_complete` / `watch_patterns` still
accepted.

Background launch returns:

```json
{"output": "Background process started", "session_id": "proc_<12 hex>", "pid": 123,
 "exit_code": 0, "error": null, "notify_on_complete": true}
```

Spawn details (`tools/process_registry.py:spawn_local`): user login shell
`-lic "set +m; <cmd>"`, `PYTHONUNBUFFERED=1`, `start_new_session=True`, stdout
and stderr **merged** into one rolling buffer capped at **200,000 chars**.
**stdin is `/dev/null` unless `pty=true`.** `write`/`submit` only work for PTY
sessions. PTY mode is meant for full-screen TUIs (Codex, Claude Code REPL).

### 3.3 `process_manage` tool (renamed from `process` on 2026-08-29; `process` remains a legacy alias)

Actions: `list`, `poll`, `log`, `wait`, `kill`, `write`, `submit`, `close`,
`handoff` (subagent transfers a process to its parent).

- `wait` blocks up to `timeout`, **clamped to `TERMINAL_TIMEOUT` (180 s)**. On
  expiry it returns `{"status":"timeout","process_running":true,...}` with a note
  that this is not an error. A new user message interrupts the wait.
- `poll` is read-only and does not consume the completion; `wait` and `log`
  mark it consumed, which suppresses the later notification.
- Completed results are retained for 7 days / newest 64 per profile.

### 3.4 Completion notifications (`notify=true`)

On exit a completion event is queued with the **last 2000 chars** of merged
output (`process_registry.py:1206`). It is rendered as:

```
[IMPORTANT: Background process proc_xxxx completed normally (exit code 0).
Command: <command>
Output:
<last 2000 chars>]
```

Non-zero exits render as "exited (exit code N)"; several completions for one
conversation are batched into one message ("[IMPORTANT: N background processes
completed."). The gateway snaps the tail to a line boundary and prefixes
"[… output truncated — showing last N chars]" when cut.

Delivery per surface:

| Surface | Delivered? | How |
|---|---|---|
| Interactive CLI / TUI | yes | drained while idle and after every turn; injected as a synthetic user turn (`hermes_cli` `cli-idle` / `cli-post-turn`) |
| Gateway platforms (Telegram, Discord, Slack, ...) | yes | per-process watcher every 5 s; synthetic `MessageEvent(internal=True)` starts a new agent turn; the reply is posted to the chat; concurrent completions are batched (0.1 s window); queued if the session is busy |
| `hermes -z` one-shot | no | `declare_stateless_channel()`; terminal drops the flag and returns `notify_unsupported` telling the agent to poll |
| `hermes chat -q` (non-Kanban) | no new turn | keeps the flag and lingers up to `terminal.oneshot_completion_wait_seconds` (600 s) for notify processes to finish, but never runs another turn on the completion |
| cron jobs | no | same stateless rule |
| Kanban workers | no | `HERMES_KANBAN_TASK` set |
| API server session | partial | `supports_async_delivery=False`; wake is done by self-posting `/v1/chat/completions` with `X-Hermes-Session-Id` |

`display.background_process_notifications` (`concise` default, `all`, `result`,
`error`, `off`) only changes the extra human-facing text; with `notify=true`
the agent turn is still triggered.

### 3.5 Process lifetime and reaping

- Gateway inactivity timeout `agent.gateway_timeout` (default **1800 s**)
  interrupts the turn and kills every background process started during that
  turn (`_reap_gateway_turn_processes`, source `gateway_turn_timeout`). Upstream
  no longer reaps on plain user interrupt (the local v0.20.5 did).
- One-shot, cron, and Kanban worker agents call `kill_all(task_id)` on close,
  killing the processes that run started. `/stop` in the TUI calls
  `kill_all()`. `/new` on a messaging platform does **not** kill background
  processes; completions addressed to the closed session are dropped at
  delivery (output stays readable via `process_manage(log)`).
- Kills are tree kills: psutil `children(recursive=True)`, SIGTERM then SIGKILL
  after a grace window. claude-hc's re-exec'd worker is still a child by ppid,
  so it dies with the wrapper. Claude's session transcript on disk survives and
  can be resumed, but the in-flight turn is lost.
- Subagent-owned processes are killed when the subagent finishes unless handed
  off with `process_manage(action="handoff")`.

### 3.6 `clarify` tool (Hermes's own AskUserQuestion)

Advertised schema (since 2026-08-26): a single `questions` array (1 to **5**
items), each `{question, choices?: string[] (max **4**, first one is labelled
"(Recommended)", the UI appends "Other (type your answer)"), multi_select?}`.
The legacy top-level `question`/`choices`/`multi_select` and a per-question
`id` are still accepted. Result: `{"responses": [{"id"?, "question",
"choices_offered", "user_response"}...], "timed_out"?: true}` (legacy single
shape `{"question", "choices_offered", "user_response"}`).

- Timeout `agent.clarify_timeout`, default **3600 s** (`<= 0` = unlimited). On
  timeout the tool returns "The user did not provide a response within the time
  limit. Use your best judgement to make the choice and proceed." Caveat: the
  classic CLI's built-in config sets `clarify.timeout: 120`, which
  `resolve_clarify_timeout` prefers, so the CLI's effective default may be
  120 s; the Telegram/Discord docs still quote a stale 600 s.
- Rendering: arrow-key panel on CLI/TUI, inline buttons on Telegram/Discord,
  numbered-list text fallback elsewhere. Messaging platforms ask batch questions
  one at a time and stop if the user stops answering.
- In every platform bundle (`_HERMES_CORE_TOOLS`) and the coding toolset.
  **Blocked inside `delegate_task` subagents** (`DELEGATE_BLOCKED_TOOLS`).

Mapping to Claude's `AskUserQuestion` is direct: 1-4 questions with 2-4 options
and `multiSelect` fit inside clarify's 5 questions with 4 choices and
`multi_select`.

### 3.7 `delegate_task`

Top-level delegations run in the background by default and post a durable
completion event as a new turn; `max_concurrent_children` default 10; children
cannot `clarify`, `send_message`, `cronjob_manage`, or delegate further.

### 3.8 Skills

- Live in `~/.hermes/skills/<category>/<name>/SKILL.md`; also
  `skills.external_dirs` and project-local `.hermes/skills/` or
  `.agents/skills/` (highest precedence, trust prompt, security scan).
- Frontmatter: `name`, `description`, `version`, `author`, `license`,
  `platforms`, `metadata.hermes.{tags, related_skills, requires_tools,
  requires_toolsets, fallback_for_*, config}`, `required_environment_variables`.
- Surfaced as a name+description index in the system prompt; loaded on demand
  with `skill_view(name)` or by the user as `/skill-name <instruction>` on every
  surface. `${HERMES_SKILL_DIR}` and `${HERMES_SESSION_ID}` are substituted in
  the body.
- Install: `hermes skills install owner/repo/path/to/skill`, a direct
  `https://.../SKILL.md` URL, or `official/...`.
- Hermes ships a bundled `claude-code` skill (v2.2.1): print mode
  (`claude -p ... --output-format json`, foreground `timeout=120`) is preferred;
  human-in-the-loop work is done through a tmux session with
  `capture-pane` polling and `send-keys`. It warns that `--continue` needs the
  same directory and that `-p` "skips ALL interactive dialogs".

### 3.9 Other wake mechanisms

- `/goal`: after every turn a judge model can return `wait` and park the loop on
  a background process (`wait_on_session`), resuming when it exits.
- `/loop` and `/heartbeat`: idle-only synthetic turns on a timer.
- `hermes send --to <platform>`: posts a message to a platform without an agent
  turn (no way to inject into a session).
- Tools see `HERMES_SESSION_PLATFORM`, `HERMES_SESSION_CHAT_ID`,
  `HERMES_SESSION_ID`, etc. in their environment.
- Plugin API `ctx.inject_message(content, session_key=...)` is the documented
  way for a plugin to push conversational input into a CLI or gateway session
  (starts a turn when idle, queues when busy). The API server accepts a turn
  for a stored session via `POST /v1/chat/completions` with
  `X-Hermes-Session-Id`. Neither is needed for the Kanban flow.
- Messaging-platform conversations never reset on inactivity; `/new` or
  `/reset` starts a new one. `session_reset` settings are legacy and ignored.
- Foreground `terminal` calls with a timeout above 600 s are promoted to a
  tracked background process (poll-only on stateless sessions).

### 3.10 Kanban workers (the intended caller)

Sources: `website/docs/user-guide/features/kanban.md`, `kanban-worker-lanes.md`,
`agent/prompt_builder.py` (`KANBAN_GUIDANCE`), `hermes_cli/kanban_db_dispatch.py`,
`hermes_cli/cli_agent_setup_mixin.py`, `tools/terminal_tool_background.py`.

- The dispatcher (inside the gateway, tick every 60 s) spawns each worker as
  `hermes -p <assignee> chat -q "work kanban task <id>"` in the task workspace
  with `HERMES_KANBAN_TASK`, `HERMES_KANBAN_WORKSPACE`, `HERMES_KANBAN_RUN_ID`,
  `HERMES_KANBAN_DB`, `HERMES_KANBAN_BOARD`, `HERMES_PROFILE` set. Worker
  stdout/stderr go to `<board-root>/logs/<task_id>.log`.
- A worker is one `chat -q` turn. `clarify` is auto-answered with
  "[single-query mode: no user available ... Pick the best option ... using your
  own judgment and continue.]", and the injected `KANBAN_GUIDANCE` says: do not
  call `clarify`; `kanban_comment` the context, then `kanban_block(reason=...)`
  so the task surfaces as needing input.
- `HERMES_KANBAN_TASK` makes `async_delivery_supported()` false, so
  `terminal(background=true, notify=true)` drops the flag and returns
  `notify_unsupported`: "The process is running in the background; retrieve its
  result with process(action='poll') or process(action='wait')." Background
  launches themselves are allowed.
- Every run must end with exactly one of `kanban_complete`,
  `kanban_request_review`, or `kanban_block(reason, kind)`. Exiting without one
  is a `protocol_violation` (retried up to 3 times, then auto-blocked). Two
  synthetic nudges push the model toward a terminal call before it stops.
- `kanban_block` kinds: `dependency` (waits in `todo`, auto-resumes),
  `needs_input` / `capability` / `transient` (surface to a human). Repeated
  same-kind re-blocks (limit 2) route the card to `triage`.
- Timers: claim TTL 15 min (extended while the worker PID is alive), heartbeat
  considered stale after 1 h, stale reclaim after
  `kanban.dispatch_stale_timeout_seconds` (4 h) with no heartbeat, optional
  per-task `max_runtime_seconds` (SIGTERM, SIGKILL after 5 s). Workers should
  call `kanban_heartbeat(note=...)` every few minutes during long operations.
- After a human unblocks the card the dispatcher spawns a **new** worker process
  with a **new** Hermes session. `kanban_show()` returns the title, body, parent
  handoffs, prior attempts, and the full comment thread as `worker_context`, so
  all interview state must live on the card (comments, block reason,
  completion `metadata`).
- Human side: a card created with `/kanban create` from Telegram, Discord, etc.
  auto-subscribes that chat with `notify+wake`. The `blocked` event (payload
  `reason`, `kind`) is delivered to the chat and wakes the chat agent for a real
  turn. The human answers with `/kanban comment <id> "..."` then
  `/kanban unblock <id>` (or `hermes kanban ...` on the CLI, or the dashboard).
  A chat profile needs the `kanban` toolset enabled for its agent to comment
  and unblock on the human's behalf.
- **Unblock-loop breaker** (`hermes_cli/kanban_db.py:_route_block`):
  `recurrences = prev_recurrences + 1 if prev_kind == kind else 1`; at
  `BLOCK_RECURRENCE_LIMIT = 2` the card is routed to `triage` with a
  `block_loop_detected` event (which is delivered and wakes subscribers).
  `block_kind` and `block_recurrences` survive `unblock` and reset only on
  completion. `hermes kanban promote` accepts only `todo` and `blocked`, so a
  `triage` card returns only via the dashboard or `hermes kanban specify`.
  Consequence: two consecutive `needs_input` blocks strand an interview;
  alternating the kind (`needs_input`, then untyped) keeps the counter at 1.
- **Out-of-band comment steer** (`tools/kanban_tools.py:inject_new_comments_from_env`,
  called from `agent/activity_tracking.py`): a running worker polls its card
  every 6 s and new operator comments are steered into the agent as an
  out-of-band message appended to the next tool result. A human can talk to a
  running worker without block/unblock; the worker still pays a model turn per
  wait cycle while idle.
- `--goal` cards keep one worker iterating in the same session under a judge;
  budget exhaustion blocks the card. Not required for the interview loop.
- `kanban_request_review` wakes subscribers and does not count toward the loop
  breaker, but `kanban.review_dispatch` (default true) auto-dispatches an AI
  reviewer with the `sdlc-review` skill, so it is unsuitable for questions.
- `kanban_unblock` and `kanban_list` are orchestrator-only tools (hidden from
  dispatcher-spawned workers); `kanban_create`, `kanban_link`,
  `kanban_comment` are available to workers.
- Killing a timed-out worker signals the worker PID only; a detached claude-hc
  child could survive as an orphan still writing to the Claude session. A
  respawned worker resuming the same session would then interleave turns.
- Wrapping an external CLI as its own worker lane is documented as "not yet a
  paved path"; calling claude-hc from a Hermes profile lane via `terminal` is
  the supported shape.

## 4. Consequences for the design

1. **Turn-based is the right primitive.** claude-hc's one-shot + `-r` model is
   exactly what Hermes can drive. A long-lived stdin protocol would need
   `pty=true`, PTY echo/`\r` handling, and stays killable; not worth it.
2. **Always background + notify.** A brainstorming turn easily exceeds the 180 s
   default, the 420 s sequential deadline, and gets killed on interrupt when run
   in the foreground. `terminal(background=true, notify=true)` returns at once,
   Hermes keeps working, and the completion arrives as a new turn on CLI, TUI,
   and every gateway platform.
3. **The output contract must survive a 2000-char tail.** The notification only
   carries the last 2000 chars of merged stdout+stderr. claude-hc should end
   with one compact machine-readable line (status, session id, pointer to the
   full result) and write the full text to a file Hermes can `read_file`.
4. **Questions should be structured.** Emitting the `AskUserQuestion` payload
   as JSON lets Hermes pass it straight to `clarify` (buttons on Telegram,
   panel on CLI) or answer it itself. Today Hermes would have to parse prose.
5. **The relay must run in the main Hermes agent.** Subagents cannot `clarify`,
   so a `delegate_task` child could only answer questions autonomously.
6. **Expect to be killed.** Session close and inactivity reaping tree-kill the
   process. Claude's transcript survives, so every result must carry the
   session id, and the Hermes skill must say "resume with -r" on any failure.
   Decoupling the Claude worker from the Hermes-tracked process (job mode)
   would also protect an in-flight turn.
7. **Polling fallback is required** for `hermes -z`, cron, Kanban workers and
   the API server, where notifications are unsupported. A `wait`-style command
   with a bounded timeout (<= 180 s per call to fit `process_manage(wait)`
   semantics, or run as its own background notify process) covers this.
8. **Tool naming drift.** Upstream calls the tool `process_manage`; v0.20.x
   calls it `process`. A Hermes skill should mention both or avoid depending on
   the name.
9. **Explicit cwd.** Hermes sets `workdir` per call; claude-hc should accept
   `--cwd` (SDK `cwd` option) so the Claude session is bound to the project
   regardless of where Hermes launches it.
10. **The primary caller is a Kanban worker, so the loop is poll-based.** Launch
    with `terminal(background=true)`, then `process_manage(wait, timeout=180)`
    in a loop with `kanban_heartbeat` between waits. Notifications never fire
    there. The notify path (item 2) still matters for chat agents that relay
    questions to the human.
11. **Human input flows through the board.** The worker records the question
    and the Claude session id in a `kanban_comment`, blocks with
    `kind="needs_input"`, and exits. The human (or a chat agent with the
    `kanban` toolset, prompted by the `blocked` wake) answers with a comment
    and unblocks. The respawned worker reads the thread, finds the session id
    and the answer, and resumes with `-r`. Every claude-hc result must
    therefore carry the session id, and the completion `metadata` should too.
12. **Guard against interleaved resumes.** A per-session lock file in claude-hc
    (refuse to start a turn while another process holds the session) plus a
    `status <session_id>` command let a respawned worker detect an orphaned
    in-flight turn instead of corrupting the transcript.

## 5. Open questions for the design conversation

- Which Hermes surfaces matter first: interactive CLI/TUI, or a messaging
  platform (Telegram/Discord) where the human answers with buttons?
- Who answers the interview by default: the human (Hermes relays via
  `clarify`), or Hermes itself, or Hermes decides per question?
- Should claude-hc own background execution (job id, `wait`, `answer`,
  detached worker) or rely on Hermes's `terminal(background=true)` alone?
- Where should the Hermes skill live (this repo, installable via
  `hermes skills install`)?
- Must the local v0.20.5 Hermes be supported, or only upstream `main`?
