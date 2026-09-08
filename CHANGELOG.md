# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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

## [0.3.0] - 2026-08-27

### Added

- New exit code `2`: the SDK's stream can complete without ever emitting a
  `result` message — reported from real-world use, correlated with a long
  tool call that produces no output for a while. No exception is thrown when
  this happens, so previously the loop just exited with `exitCode` still at
  its default of `0`, indistinguishable from a real success. claude-hc now
  tracks whether a `result` message was seen and exits `2` instead if not,
  so the failure is visible to a caller instead of silently reading as
  success. Root cause is unconfirmed (candidates include an idle timeout
  upstream of the SDK dropping the connection mid-turn) — this only adds
  observability, it doesn't fix or prevent the underlying issue. See
  [Known limitations](./README.md#known-limitations) for what's confirmed,
  what isn't, and the reported workaround (background long, quiet tool
  calls and resume with `-r` instead of waiting on them in the same turn).
- Documented all exit codes (`0`/`1`/`2`) in the README.

[0.3.0]: https://github.com/berangberangteknologi-id/claude-hc/compare/v0.2.1...v0.3.0

## [0.2.1] - 2026-08-26

### Changed

- Shortened the message sent back to the model when denying an
  `AskUserQuestion` call, to reduce how much it adds to the conversation
  transcript. It still explicitly tells the model its answer is coming as a
  follow-up message (not that the conversation is over), so the model's own
  brief acknowledgment stays accurate. (An `interrupt: true` deny was tried
  to suppress that acknowledgment entirely, but it made the turn end with
  `result.subtype: "error_during_execution"` instead of `"success"` — every
  question would then look like a failure to a caller checking the exit
  code, so it wasn't used.)

[0.2.1]: https://github.com/berangberangteknologi-id/claude-hc/compare/v0.2.0...v0.2.1

## [0.2.0] - 2026-08-26

### Changed

- **Breaking:** `AskUserQuestion` no longer blocks waiting for an answer on
  stdin within the same invocation. The question and its options are still
  printed, but the tool call is now denied immediately (with a message
  telling the model to end its turn), so the process exits normally — the
  same shape as any other response. This makes every invocation uniformly
  one-shot: it always prints text and exits, whether that text is a final
  answer or a clarifying question. To answer, run `claude-hc` again with
  `-r <session_id>` and the answer as the new prompt, exactly like
  continuing past a plain-text question.
- Removed the `readline`-based interactive prompt and the stdin
  `readableEnded`/`isTTY` handling that existed to support it — no longer
  needed now that nothing blocks on stdin for an answer.

[0.2.0]: https://github.com/berangberangteknologi-id/claude-hc/compare/v0.1.1...v0.2.0

## [0.1.1] - 2026-08-26

### Fixed

- The compiled entry point (`dist/claude-hc.js`) wasn't executable after
  `npm install`/`npm link` — npm doesn't set the executable bit on files
  listed in `bin`. It happened to still run via npm's generated shim (which
  invokes through `node` directly), but a `postbuild` step now `chmod +x`s
  it so it's correct standalone too.

## [0.1.0] - 2026-08-26

### Added

- Initial release: `claude-hc`, a headless Claude Code CLI that wires up the
  `AskUserQuestion` tool with a real `canUseTool` callback, so the agent can
  pause mid-task, ask a clarifying question over stdin (TTY or pipe), and
  continue once answered — while every other tool keeps `claude -p`'s
  non-interactive, auto-approved behavior.
- `-r/--resume <session_id>` to continue a specific session. There is no
  "resume last session" flag by design — that mode is inherently ambiguous
  when more than one Claude Code session shares a working directory.
- `--allowed-tools`, `--disallowed-tools`, `--model`, `--max-turns` flags.
- Self re-exec on startup with `CLAUDE_CODE_*` environment variables
  stripped, so a `claude-hc` invocation isn't mistaken for a child of
  whatever live Claude Code session launched it.

[0.1.1]: https://github.com/berangberangteknologi-id/claude-hc/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/berangberangteknologi-id/claude-hc/releases/tag/v0.1.0
