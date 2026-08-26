# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
