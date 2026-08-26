# claude-hc

Headless Claude Code that can still ask clarifying questions.

Plain `claude -p` runs non-interactively and never pauses to ask you
anything — it just guesses and moves on. `claude-hc` is a thin wrapper
around the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
that wires up the `AskUserQuestion` tool properly, so the agent can stop
mid-task, ask you something over the terminal (or a pipe), and continue
once you answer — while everything else behaves like `-p`: one-shot
invocation, tools you allow run without prompting, and it exits when done.

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

It's a one-shot invocation: `claude-hc` runs the prompt to completion
(pausing for any clarifying questions along the way), prints the result, and
exits — same shape as `claude -p`, just interactive when it needs to be.

### Examples

```bash
# Basic
claude-hc "review this repo and suggest one improvement"

# Restrict which tools the agent may use
claude-hc "fix the failing test" --allowed-tools Read,Edit,Bash

# Continue a previous session (session_id is printed to stderr on exit)
claude-hc "now also add a test for that" -r <session_id>
```

### Answering questions programmatically

Because `claude-hc` just waits on stdin for an answer, you don't need a real
terminal to drive it — any process that can write lines to a pipe works.
This is the pattern for orchestrating it from a script or another agent:

```bash
touch answers.txt
tail -f answers.txt | claude-hc "build me a small app" --allowed-tools Read,Write,Edit,Bash > output.log 2>&1 &

# whenever output.log shows a question, append your answer:
echo "1" >> answers.txt
```

`claude-hc` only refuses to wait when stdin has genuinely already ended
(e.g. the prompt itself was piped in and consumed it) — there's no other
special "interactive mode" to opt into.

## CLI reference

| Flag | Description |
|---|---|
| `-r, --resume <session_id>` | Resume a specific session by its `session_id`. |
| `--allowed-tools <a,b,c>` | Comma-separated tools the agent may use without prompting (default: `Read,Write,Edit,Bash,Glob,Grep`). `AskUserQuestion` is always handled separately and doesn't need to be listed. |
| `--disallowed-tools <a,b,c>` | Comma-separated tools to block. See [Known limitations](#known-limitations) — this is the flag that's actually enforced. |
| `--model <name>` | Model to use (e.g. `claude-sonnet-5`). |
| `--max-turns <n>` | Cap on tool-use round-trips. |
| `-h, --help` | Show help. |

There is no "resume last session" flag — `-r` always takes an explicit
`session_id`. "Most recent session in this directory" is inherently
ambiguous when more than one Claude Code session shares a working
directory, so that mode isn't offered at all.

## How it works

- **`AskUserQuestion`**: this is a built-in Claude Code tool, but by default
  the SDK denies it unless a host app supplies a `canUseTool` callback that
  actually surfaces the question and returns an answer. `claude-hc`'s
  callback does exactly that: it prints the question and options, blocks on
  `readline.question()` for a reply on stdin, and feeds the answer back to
  the agent so it can continue the same task.
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
- **A plain-text clarifying question ends the turn.** `AskUserQuestion` calls
  pause and resume within a single invocation. But some skills/flows ask for
  approval as ordinary conversational text instead of an `AskUserQuestion`
  call (e.g. "does this design look right?") — that ends the turn like any
  other response, and continuing requires a new `claude-hc` invocation with
  `-r <session_id>`.

## License

MIT — see [LICENSE](./LICENSE).
