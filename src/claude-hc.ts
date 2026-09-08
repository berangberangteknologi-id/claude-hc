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
