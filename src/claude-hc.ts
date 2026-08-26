#!/usr/bin/env node
// claude-hc — headless Claude Code, but AskUserQuestion actually works
// (the agent can pause mid-task, ask you a clarifying question over the
// terminal, and continue once you answer — instead of silently guessing,
// which is what plain `claude -p` does).
//
// Run `claude-hc --help` for the full option list.
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
// If your global settings (~/.claude/settings.json) have something like
// "skipDangerousModePermissionPrompt": true, a tool that is NOT in
// --allowed-tools/--disallowed-tools can still run without ever reaching
// canUseTool below — the deny-by-default behavior here for non-AskUserQuestion
// tools is best-effort, NOT a security boundary you can rely on in that kind
// of environment. AskUserQuestion itself was confirmed to always route
// through canUseTool consistently. If you need a tool to actually be
// blocked, use --disallowed-tools — that was confirmed to be honored
// (a different mechanism from simply omitting a tool from --allowed-tools).

import { query, type SDKMessage, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import * as readline from "node:readline/promises";
import { spawn } from "node:child_process";

const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

// claude-hc always re-execs itself once as a fresh child process with the
// environment stripped of CLAUDE_CODE_* variables, so that query() inside it
// is not recognized as a "child" of whatever live Claude Code session called
// it (e.g. via its Bash tool) — separate, not nested. stdio stays 'inherit'
// (same terminal) so AskUserQuestion is still interactive without needing a
// new window. Guarded by CLAUDE_HC_DETACHED so it only re-execs once.
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

  const child = spawn(
    process.execPath,
    [...process.execArgv, __filename, ...process.argv.slice(2)],
    { env: cleanEnv, stdio: "inherit", detached: true },
  );

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

const HELP_TEXT = `claude-hc — headless Claude Code that can still ask clarifying questions

USAGE:
  claude-hc "prompt text" [options]
  echo "prompt text" | claude-hc [options]

OPTIONS:
  -r, --resume <session_id>   Resume a specific session by its session_id.
  --allowed-tools <a,b,c>     Comma-separated list of tools the agent may use
                              (default: ${DEFAULT_ALLOWED_TOOLS.join(",")})
                              "AskUserQuestion" is always routed through
                              canUseTool, so it doesn't need to (and can't) be
                              listed here.
  --disallowed-tools <a,b,c>  Comma-separated list of tools to block
  --model <name>              Model to use (e.g. claude-sonnet-5)
  --max-turns <n>             Cap on tool-use round-trips
  -h, --help                  Show this help

NOTES:
  - Tools in --allowed-tools are auto-approved without asking (same as 'claude -p').
  - IMPORTANT: --allowed-tools is NOT a fully reliable security sandbox.
    query() loads your local Claude Code install as-is (every active
    plugin/MCP server). If your global ~/.claude/settings.json has a
    permissive setting (e.g. "skipDangerousModePermissionPrompt": true), a
    tool NOT in --allowed-tools can still run without ever going through the
    permission check here. If you need a tool truly blocked, use
    --disallowed-tools — that one was confirmed to be honored in testing.
  - When the agent needs clarification, it pauses and waits for an answer on
    stdin — a real TTY or an open pipe/FIFO both work (e.g. 'tail -f
    answers.txt | claude-hc ...'), it doesn't have to be an actual terminal.
    The only thing that gets auto-denied is a stdin that has ALREADY ended
    (e.g. because the prompt itself was sent via stdin and consumed it) — at
    that point there is genuinely no way left to wait for an answer.
  - session_id is printed to stderr at the end so it can be used with -r.
    An explicit session_id is the only way to continue a session — this
    avoids ever guessing "the most recent session", which is inherently
    ambiguous when multiple Claude Code sessions share a working directory.
  - claude-hc always re-execs itself once as a child process with the
    environment stripped of CLAUDE_CODE_* variables, so it isn't recognized
    as a "child" of any live Claude Code session that invoked it. stdio stays
    in the same terminal (no new window is opened).`;

interface Args {
  prompt: string | undefined;
  resumeId: string | undefined;
  allowedTools: string[];
  disallowedTools: string[] | undefined;
  model: string | undefined;
  maxTurns: number | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    prompt: undefined,
    resumeId: undefined,
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    disallowedTools: undefined,
    model: undefined,
    maxTurns: undefined,
    help: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-r":
      case "--resume":
        args.resumeId = argv[++i];
        break;
      case "--allowed-tools":
        args.allowedTools = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
        break;
      case "--disallowed-tools":
        args.disallowedTools = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
        break;
      case "--model":
        args.model = argv[++i];
        break;
      case "--max-turns": {
        const raw = argv[++i];
        const n = raw ? Number(raw) : NaN;
        if (Number.isFinite(n)) args.maxTurns = n;
        break;
      }
      default:
        positional.push(arg);
    }
  }

  args.prompt = positional.join(" ").trim() || undefined;
  return args;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function makeAskUserQuestionHandler(rl: readline.Interface) {
  return async (input: AskUserQuestionInput) => {
    // We check readableEnded/destroyed, not isTTY: a non-TTY stdin
    // (pipe/FIFO) is still perfectly valid to wait on — readline.question()
    // just waits for the next line, whether it comes from a TTY or a pipe.
    // What genuinely means "no answer is ever coming" is stdin that has
    // ALREADY ended — that happens when the prompt itself was sent via
    // stdin (consuming it) or when the writer on the other end of a
    // pipe/FIFO has closed its connection.
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      console.error(
        "\n[claude-hc] The agent asked a clarifying question via AskUserQuestion, but " +
          "stdin has already ended/closed (likely because the prompt itself was sent via " +
          "stdin and consumed it), so there's no way left to wait for an answer. Denying " +
          "this request.\n",
      );
      return {
        behavior: "deny" as const,
        message: "stdin already ended — no way to read an answer for AskUserQuestion.",
      };
    }

    const answers: Record<string, string> = {};

    for (const q of input.questions) {
      console.log(`\n${q.header ? `[${q.header}] ` : ""}${q.question}`);
      q.options.forEach((opt, idx) => {
        console.log(`  ${idx + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`);
      });

      const raw = await rl.question(
        q.multiSelect
          ? "Pick a number (comma-separated), or type a free-text answer: "
          : "Pick a number, or type a free-text answer: ",
      );

      const picked = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((token) => {
          const idx = Number(token) - 1;
          return Number.isInteger(idx) && q.options[idx] ? q.options[idx].label : token;
        });

      answers[q.question] = picked.join(", ");
    }

    return {
      behavior: "allow" as const,
      updatedInput: { questions: input.questions, answers },
    };
  };
}

function makeCanUseTool(rl: readline.Interface): CanUseTool {
  const askUserQuestion = makeAskUserQuestionHandler(rl);

  return async (toolName, input) => {
    if (toolName === "AskUserQuestion") {
      return askUserQuestion(input as unknown as AskUserQuestionInput);
    }
    // Tools actually in --allowed-tools are bare-listed, so the SDK
    // auto-approves them and never invokes this callback for them at all.
    // Reaching this branch means toolName was NOT in --allowed-tools —
    // deny it, matching `-p` semantics (only explicitly allowed tools run).
    return {
      behavior: "deny",
      message: `Tool "${toolName}" is not in --allowed-tools.`,
    };
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  // Check this BEFORE relaunchDetached() — CLAUDE_CODE_SESSION_ID is only
  // visible in the original process (not yet stripped). If this process is
  // itself a child of a live Claude Code session, and -r targets exactly
  // that live session's session_id, refuse — resuming into the live session
  // that spawned us could corrupt its transcript.
  const liveSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (liveSessionId && args.resumeId === liveSessionId) {
    console.error(
      `[claude-hc] -r ${args.resumeId} refused: that is the session_id of the live Claude ` +
        "Code session currently running this process. Resuming into the live session that " +
        "spawned us could corrupt its transcript.",
    );
    process.exit(1);
  }

  if (process.env[DETACH_MARKER] !== "1") {
    relaunchDetached();
    return;
  }

  const prompt = args.prompt ?? (await readStdin());
  if (!prompt) {
    console.error(`Usage: claude-hc "prompt" [-r <session_id>] [--allowed-tools a,b,c] [--model name] [--max-turns n]`);
    console.error("Run `claude-hc --help` for details.");
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.on("SIGINT", () => {
    rl.close();
    process.exit(130);
  });

  // AskUserQuestion is deliberately NOT included in allowedTools: the SDK
  // auto-approves (and skips canUseTool for) any tool name that's bare-listed
  // there. By leaving it out of allowedTools/disallowedTools, calls to this
  // tool always fall through to canUseTool below, where we actually handle it.
  const allowedTools = args.allowedTools.filter((t) => t !== "AskUserQuestion");

  let sessionId: string | undefined;
  let exitCode = 0;

  try {
    const stream = query({
      prompt,
      options: {
        allowedTools,
        ...(args.disallowedTools ? { disallowedTools: args.disallowedTools } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
        ...(args.resumeId ? { resume: args.resumeId } : {}),
        canUseTool: makeCanUseTool(rl),
      },
    }) as AsyncIterable<SDKMessage>;

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            process.stdout.write(block.text);
          } else if (block.type === "tool_use") {
            console.error(`\n[claude-hc] using tool: ${block.name}`);
          }
        }
      } else if (message.type === "result") {
        process.stdout.write("\n");
        if (message.subtype !== "success") {
          console.error(`[claude-hc] stopped: ${message.subtype}`);
          exitCode = 1;
        }
      }
    }
  } catch (err) {
    console.error("[claude-hc] error:", err);
    exitCode = 1;
  } finally {
    if (sessionId) console.error(`[claude-hc] session_id: ${sessionId}`);
    rl.close();
  }

  process.exit(exitCode);
}

main();
