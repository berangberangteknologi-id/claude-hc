# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
