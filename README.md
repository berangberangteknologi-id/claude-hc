# claude-hc

Headless Claude Code that can still ask clarifying questions.

Plain `claude -p` runs non-interactively and never pauses to ask you
anything — it just guesses and moves on. `claude-hc` is a thin wrapper
around the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
that wires up the `AskUserQuestion` tool properly, so a clarifying question
actually reaches you instead of being silently denied — while every
invocation stays one-shot, exactly like `-p`: it prints text and exits, and
a question is just another piece of text output. Answering one means
running claude-hc again with `-r <session_id>` and your answer as the new
prompt.

## Install

```bash
git clone git@github.com:berangberangteknologi-id/claude-hc.git
cd claude-hc
npm install
npm run build
npm link
```

`npm link` puts a global `claude-hc` command on your `PATH`. Skip it if you'd
rather just run `node dist/claude-hc.js ...` directly.

## Auth

`claude-hc` uses your local Claude Code installation's credentials — the same
Pro/Max subscription auth as the interactive CLI, not pay-per-token API
billing.

```bash
npm install -g @anthropic-ai/claude-code
claude setup-token   # one-time browser login
```

**Do not set `ANTHROPIC_API_KEY`.** If it's set, it overrides subscription
auth and switches billing to the regular pay-per-token API.

## Usage

```bash
claude-hc "prompt text" [options]
echo "prompt text" | claude-hc [options]
```

Every invocation is one-shot: `claude-hc` runs the prompt, prints text, and
exits — same shape as `claude -p`. If the agent needs to ask you something,
the question is printed as part of that output and the process still exits;
there's no invocation that stays running waiting for input.

### Examples

```bash
# Basic
claude-hc "review this repo and suggest one improvement"

# Restrict which tools the agent may use
claude-hc "fix the failing test" --allowed-tools Read,Edit,Bash

# Continue a previous session (session_id is printed to stderr on exit)
claude-hc "now also add a test for that" -r <session_id>

# Machine-readable mode: one JSON line as the last line of stdout
claude-hc --json --cwd /path/to/repo "brainstorm a caching layer" --allowed-tools Read,Glob,Grep

# Feed the prompt through stdin (safest when it contains quotes or newlines)
claude-hc --json --cwd /path/to/repo < prompt.txt

# Is a turn still running on this session? What did the last one produce?
claude-hc status <session_id>
claude-hc wait <session_id> --timeout 170
```

### Answering questions programmatically

Because every invocation just runs once and exits, orchestrating `claude-hc`
from a script or another agent is a plain request/response loop — no pipes,
no background processes, no long-lived state to manage:

```bash
out=$(claude-hc "build me a small app" --allowed-tools Read,Write,Edit,Bash 2>/tmp/stderr.log)
session_id=$(grep -o 'session_id: .*' /tmp/stderr.log | cut -d' ' -f2)
echo "$out"

# if $out is a question, decide an answer and run again with -r:
claude-hc "1" -r "$session_id" --allowed-tools Read,Write,Edit,Bash
```

In practice: run it, read the output, and if it's a question, run it again
with `-r <session_id>` and your answer as the new prompt. Repeat until
you're done — there's no special "interactive mode" to opt into or out of.

## CLI reference

| Flag | Description |
|---|---|
| `-r, --resume <session_id>` | Resume a specific session by its `session_id`. |
| `--json` | Print one JSON line as the last line of stdout instead of streaming text. See [JSON mode](#json-mode). |
| `--cwd <dir>` | Working directory for the Claude session (default: current directory). |
| `--allowed-tools <a,b,c>` | Comma-separated tools the agent may use without prompting (default: `Read,Write,Edit,Bash,Glob,Grep,mcp__*` — the `mcp__*` covers every MCP server already connected in this environment, project `.mcp.json`, user settings, or plugins, without listing servers individually). `AskUserQuestion` is always handled separately and doesn't need to be listed. Passing your own `--allowed-tools` replaces the default outright — include `mcp__*` or `mcp__<server>` in it to keep MCP tools available. |
| `--disallowed-tools <a,b,c>` | Comma-separated tools to block. See [Known limitations](#known-limitations) — this is the flag that's actually enforced. |
| `--model <name>` | Model to use (e.g. `claude-sonnet-5`). |
| `--max-turns <n>` | Cap on tool-use round-trips. |
| `-h, --help` | Show help. |

| Subcommand | Description |
|---|---|
| `status <session_id>` | Print whether a turn is in flight (with its pid) and the latest result. |
| `wait <session_id> [--timeout <s>]` | Block until no turn is in flight or the timeout (default 170 s) passes, then print the status. Exit 3 while still in flight. |

There is no "resume last session" flag — `-r` always takes an explicit
`session_id`. "Most recent session in this directory" is inherently
ambiguous when more than one Claude Code session shares a working
directory, so that mode isn't offered at all.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success: the agent answered or asked a question (check `status` in JSON mode). |
| `1` | Non-success result (e.g. `--max-turns` hit), usage error, or a claude-hc error. |
| `2` | The session ended without ever producing a result message — the turn's outcome is unknown. See [Known limitations](#known-limitations). |
| `3` | Session busy: another claude-hc process holds this session's lock. Use `claude-hc wait`. |

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

## How it works

- **`AskUserQuestion`**: this is a built-in Claude Code tool, but by default
  the SDK denies it unless a host app supplies a `canUseTool` callback that
  actually surfaces the question. `claude-hc`'s callback prints the question
  and its options, then denies the call with a message telling the model the
  question has already been shown and it should end its turn — the process
  then exits normally, exactly like any other response. This keeps the
  output shape uniform: every invocation prints text and exits, whether that
  text happens to be an answer or a question.
- **Tool auto-approval**: tools listed in `--allowed-tools` are bare-listed
  to the SDK, which auto-approves them without ever invoking the callback —
  this is what keeps `claude-hc` non-interactive for everything except
  `AskUserQuestion`, matching `claude -p`'s behavior.
- **Session isolation**: on startup, `claude-hc` always re-execs itself once
  as a fresh child process with `CLAUDE_CODE_*` environment variables
  stripped, so a `claude-hc` invocation running inside another live Claude
  Code session (e.g. spawned via that session's own Bash tool) isn't
  recognized as a "child" of it. stdio stays attached to the same terminal —
  no new window is opened.
- **Session lock and result files**: a turn holds `~/.claude-hc/sessions/<id>/lock`
  while it runs and writes `turn-NNNN.json` plus `latest.json` when it ends,
  so an orchestrator can always find out what happened without parsing prose.

## Known limitations

- **`--allowed-tools` is not a hard security sandbox.** `query()` boots your
  local Claude Code installation as-is — every globally-enabled plugin and
  MCP server included, not a clean SDK-only environment. If your global
  `~/.claude/settings.json` has a permissive setting (e.g.
  `"skipDangerousModePermissionPrompt": true`), a tool that's *not* in
  `--allowed-tools` can still execute without ever reaching the permission
  check — this was confirmed through direct testing, independent of
  `permissionMode` and of whether the process was nested inside another
  Claude Code session. `AskUserQuestion` itself was confirmed to always be
  gated correctly, in every test. If you need a tool to genuinely be
  blocked, use `--disallowed-tools` — that one was confirmed to be honored.
- **Depends on your local Claude Code install.** Because it isn't run in
  isolation, behavior (available tools, default model, permission mode) can
  vary based on your global/project Claude Code configuration, not just the
  flags you pass to `claude-hc`.
- **A long tool call with no output can silently end the session.** Reported
  from real-world use: on a long-running tool call that produces no
  streaming output for a while, the SDK's stream can complete without ever
  emitting a `result` message — no exception, no error, just an iterator
  that ends. The root cause is unconfirmed (candidates include an idle
  timeout somewhere upstream of the SDK, e.g. an HTTP/2 or proxy timeout,
  dropping the connection mid-turn); the SDK's wire protocol does have a
  keep-alive message for long silent operations, so this looks like
  something failing to respect it rather than an inherent SDK limit. As of
  `v0.3.0`, claude-hc detects this and exits `2` instead of silently
  returning `0` (see [Exit codes](#exit-codes)) — that only makes the
  failure visible, it doesn't prevent it. If you have a task that includes a
  long, quiet tool call, prefer having the agent launch it in the background
  and end its turn immediately, then resume with `-r` once it's done —
  reported to avoid the issue entirely. Attempts to reproduce it on demand
  with a plain `sleep` were blocked by Claude Code's own sandbox (bare waits
  with no real condition are flagged and pushed toward
  `run_in_background`/`Monitor`), which suggests the real trigger is a
  legitimate long-running, silent command (a build, a large download, a
  heavy computation) rather than an artificial wait — that sandbox guard
  isn't a workaround for this issue, it just happened to block every attempt
  to force it on demand.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT — see [LICENSE](./LICENSE).
