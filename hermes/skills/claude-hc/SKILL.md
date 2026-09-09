---
name: claude-hc
description: Run Claude Code headlessly with claude-hc and drive its clarifying questions (brainstorming, design interviews) from Kanban workers or chat sessions.
version: 1.1.1
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

`status: "done"` means only that the turn ended without calling
`AskUserQuestion` — it does not by itself mean the requested work is
finished. See "Recognizing a checkpoint disguised as done" below before
treating a `done` turn as terminal.

`claude-hc status SESSION_ID` prints
`{"claude_hc":1,"session_id":...,"in_flight":true|false,"pid":...,"last":{...latest.json...}}`.

Answer text (the prompt for the `-r` turn):

```
Answers from the user:
[<header>] <question> -> <label or free text>
[<header>] <question> -> <label>, <label>
<optional free text the user added>
```

## Recognizing a checkpoint disguised as `done`

`status: "done"` means only that the turn ended without calling
`AskUserQuestion` — not that the requested work is finished. Skills like
`superpowers:brainstorming` often end a turn with a plain-text proposal,
approach, or "does this look right?" checkpoint instead of a formal
question, because not every pause for feedback is phrased as a question.
Treating every `done` as terminal stops the interview one round too early.

Read `summary` (or the full text in `result_file` when `summary` was cut)
before deciding:

- **Genuinely finished**: describes work already done, in the past tense —
  files it wrote, tests it ran, "implementation complete," a spec path.
  Report it; go to the completion step.
- **A checkpoint**: presents a design, an approach, a plan, or a section of
  one, and invites a reaction — even without a literal question mark.

For a checkpoint, apply "Answer-or-relay rule" exactly as for `needs_input`:
reply yourself with a specific affirmative ("Approved, proceed.", or
something more specific if the text asks something concrete) or relay to
the human, write the reply to the prompt file, and resume with `-r` — same
mechanics as answering a real question.

Guard against looping forever on a genuinely stuck session: if the same
checkpoint repeats three times in a row (same `summary`, or no new files
appear between resumes), stop treating it as a checkpoint — relay it to the
human (or block the card) instead of resuming again.

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
   `terminal(command="cat \"${CLAUDE_HC_HOME:-$HOME/.claude-hc}/sessions/SESSION_ID/latest.json\"")`.
5. Branch on `status`:
   - `done`: if the text is a checkpoint, not a finished deliverable (see
     "Recognizing a checkpoint disguised as done"), treat it exactly like
     `needs_input` below. Otherwise, step 9.
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
   if its `status` is `done` and the text is a finished deliverable, not a
   checkpoint (see "Recognizing a checkpoint disguised as done"), go to
   step 9. Otherwise the answer is the newest comment after the marker that
   was not written by this profile (`HERMES_PROFILE`); convert it to the
   answer text and go to step 6. If no such comment exists, post the
   question (or checkpoint) comment again and block (step 8).
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

   If you cannot rely on being woken later (a one-shot invocation such as
   `hermes chat -q`, or you choose not to end your turn), launch without
   `notify` instead and poll in a loop with
   `process_manage(action="wait", session_id=<proc id>, timeout=180)` exactly
   as Procedure A step 3 — except never call `kanban_heartbeat` here; that
   tool needs a Kanban task and errors outside one (see Pitfalls). A long
   wait needs no liveness signal, just keep waiting.
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
5. `done`: if the text is a checkpoint, not a finished deliverable (see
   "Recognizing a checkpoint disguised as done"), treat it exactly like
   `needs_input` above (step 3 or 4). Otherwise, report `summary` and any
   spec path from `result_file`.
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
- Never call `kanban_heartbeat` unless `HERMES_KANBAN_TASK` is set (Procedure
  A only) — outside a Kanban worker there is no task to heartbeat and the
  call errors ("task_id is required"). A long wait in Procedure B needs no
  liveness signal; just keep waiting.
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
