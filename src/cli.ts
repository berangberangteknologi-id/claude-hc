import { buildJsonLine } from "./output.js";
import { runTurn } from "./run.js";
import type { QueryFn, TurnDeps } from "./run.js";
import type { SessionStore } from "./session-store.js";
import type { ErrorCode, TurnResult } from "./types.js";

export const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "mcp__*"];
export const DEFAULT_WAIT_TIMEOUT_S = 170;

export const HELP_TEXT = `claude-hc — headless Claude Code that can still ask clarifying questions

USAGE:
  claude-hc "prompt text" [options]
  echo "prompt text" | claude-hc [options]
  claude-hc status <session_id>
  claude-hc wait <session_id> [--timeout <seconds>]

OPTIONS:
  -r, --resume <session_id>   Resume a specific session by its session_id.
  --json                      Print one JSON line as the last line of stdout instead of
                              streaming text (status, questions, session_id, result_file).
  --cwd <dir>                 Working directory for the Claude session (default: current).
  --allowed-tools <a,b,c>     Comma-separated list of tools the agent may use
                              (default: ${DEFAULT_ALLOWED_TOOLS.join(",")})
                              "AskUserQuestion" is always routed through
                              canUseTool, so it doesn't need to (and can't) be
                              listed here.
  --disallowed-tools <a,b,c>  Comma-separated list of tools to block
  --model <name>              Model to use (e.g. claude-sonnet-5)
  --max-turns <n>             Cap on tool-use round-trips
  -h, --help                  Show this help

SUBCOMMANDS:
  status <session_id>         Print whether a turn is in flight and the latest result.
  wait <session_id>           Block until no turn is in flight or --timeout (default
                              ${DEFAULT_WAIT_TIMEOUT_S}s) passes, then print the status.

FILES:
  Every turn writes $CLAUDE_HC_HOME/sessions/<session_id>/turn-NNNN.json and latest.json
  (CLAUDE_HC_HOME defaults to ~/.claude-hc). A lock file in the same directory prevents
  two claude-hc processes from resuming the same session at once.

EXIT CODES:
  0  success (the agent answered or asked a question)
  1  non-success result, usage error, or claude-hc error
  2  the session ended without a result message (outcome unknown; try -r)
  3  session busy: another claude-hc process holds this session's lock

NOTES:
  - Tools in --allowed-tools are auto-approved without asking (same as 'claude -p').
  - The default --allowed-tools includes "mcp__*", so tools from any MCP server
    already connected in this environment (project .mcp.json, user settings,
    plugins) are usable without listing them individually. Passing your own
    --allowed-tools replaces the default outright, so include "mcp__*" (or a
    narrower "mcp__<server>") in it if you still want MCP tools.
  - IMPORTANT: --allowed-tools is NOT a fully reliable security sandbox. If you need a
    tool truly blocked, use --disallowed-tools.
  - Every invocation is one-shot: claude-hc prints and exits, whether the output is a
    final answer or a clarifying question. To answer, run claude-hc again with
    -r <session_id> and your answer as the new prompt.
  - claude-hc always re-execs itself once as a child process with the environment
    stripped of CLAUDE_CODE_* variables, so it isn't recognized as a "child" of any
    live Claude Code session that invoked it.`;

export interface ParsedArgs {
  command: "turn" | "status" | "wait" | "help";
  prompt: string | undefined;
  resumeId: string | undefined;
  allowedTools: string[];
  disallowedTools: string[] | undefined;
  model: string | undefined;
  maxTurns: number | undefined;
  json: boolean;
  cwd: string | undefined;
  sessionId: string | undefined;
  timeoutSeconds: number | undefined;
  errors: string[];
}

function splitList(raw: string | undefined): string[] {
  return raw?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: "turn",
    prompt: undefined,
    resumeId: undefined,
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    disallowedTools: undefined,
    model: undefined,
    maxTurns: undefined,
    json: false,
    cwd: undefined,
    sessionId: undefined,
    timeoutSeconds: undefined,
    errors: [],
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        args.command = "help";
        break;
      case "-r":
      case "--resume":
        args.resumeId = argv[++i];
        if (!args.resumeId) args.errors.push("-r/--resume requires a session_id");
        break;
      case "--json":
        args.json = true;
        break;
      case "--cwd":
        args.cwd = argv[++i];
        if (!args.cwd) args.errors.push("--cwd requires a directory");
        break;
      case "--allowed-tools":
        args.allowedTools = splitList(argv[++i]);
        break;
      case "--disallowed-tools":
        args.disallowedTools = splitList(argv[++i]);
        break;
      case "--model":
        args.model = argv[++i];
        break;
      case "--max-turns": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n)) args.maxTurns = n;
        else args.errors.push("--max-turns requires a number");
        break;
      }
      case "--timeout": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n >= 0) args.timeoutSeconds = n;
        else args.errors.push("--timeout requires a non-negative number of seconds");
        break;
      }
      default:
        positional.push(arg);
    }
  }

  if (args.command === "help") return args;

  if (positional[0] === "status" || positional[0] === "wait") {
    args.command = positional[0];
    args.sessionId = positional[1];
    if (!args.sessionId) args.errors.push(`${positional[0]} requires a session_id`);
    return args;
  }

  args.prompt = positional.join(" ").trim() || undefined;
  return args;
}

export interface MainDeps {
  query: QueryFn;
  store: SessionStore;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  readStdin: () => Promise<string>;
  defaultCwd: () => string;
  isDirectory: (path: string) => boolean;
  version: string;
  now: () => Date;
}

export interface MainResult {
  code: number;
  lastLine?: string;
}

const USAGE_LINE =
  'Usage: claude-hc "prompt" [-r <session_id>] [--json] [--cwd <dir>] [--allowed-tools a,b,c] ' +
  "[--model name] [--max-turns n] | claude-hc status <id> | claude-hc wait <id> [--timeout s]";

function jsonErrorLine(code: ErrorCode, message: string, sessionId: string | null = null): string {
  const result: TurnResult = {
    claude_hc: 1,
    status: "error",
    turn: null,
    summary: "",
    questions: [],
    result_subtype: null,
    exit_code: 1,
    error: { code, message },
    session_id: sessionId,
    result_file: null,
  };
  return buildJsonLine(result);
}

function usageResult(json: boolean, messages: string[], stderr: (c: string) => void): MainResult {
  const message = messages.join("; ");
  if (json) return { code: 1, lastLine: jsonErrorLine("usage", message) };
  stderr(`${message}\n${USAGE_LINE}\nRun \`claude-hc --help\` for details.\n`);
  return { code: 1 };
}

export async function main(argv: string[], deps: MainDeps): Promise<MainResult> {
  const args = parseArgs(argv);
  try {
    return await runMain(args, deps);
  } catch (err) {
    const stackOrMessage = err instanceof Error && err.stack ? err.stack : String(err);
    deps.stderr(`[claude-hc] error: ${stackOrMessage}\n`);
    if (!args.json) return { code: 1 };
    const message = err instanceof Error ? err.message : String(err);
    return { code: 1, lastLine: jsonErrorLine("exception", message) };
  }
}

async function runMain(args: ParsedArgs, deps: MainDeps): Promise<MainResult> {
  if (args.command === "help") {
    deps.stdout(HELP_TEXT + "\n");
    return { code: 0 };
  }

  if (args.errors.length > 0) return usageResult(args.json, args.errors, deps.stderr);

  if (args.command === "status") {
    const status = deps.store.status(args.sessionId as string);
    return { code: 0, lastLine: JSON.stringify(status) };
  }

  if (args.command === "wait") {
    const timeoutMs = (args.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
    const status = await deps.store.waitForRelease(args.sessionId as string, timeoutMs);
    return { code: status.in_flight ? 3 : 0, lastLine: JSON.stringify(status) };
  }

  const prompt = args.prompt ?? (await deps.readStdin());
  if (!prompt) return usageResult(args.json, ["a prompt is required (argument or stdin)"], deps.stderr);

  const cwd = args.cwd ?? deps.defaultCwd();
  if (!deps.isDirectory(cwd)) {
    return usageResult(args.json, [`--cwd ${cwd} is not a directory`], deps.stderr);
  }

  const turnDeps: TurnDeps = {
    query: deps.query,
    store: deps.store,
    stdout: deps.stdout,
    stderr: deps.stderr,
    now: deps.now,
    version: deps.version,
  };
  const result = await runTurn(
    {
      prompt,
      resumeId: args.resumeId ?? null,
      cwd,
      allowedTools: args.allowedTools,
      disallowedTools: args.disallowedTools ?? null,
      model: args.model ?? null,
      maxTurns: args.maxTurns ?? null,
      jsonMode: args.json,
    },
    turnDeps,
  );
  return { code: result.exit_code, lastLine: args.json ? buildJsonLine(result) : undefined };
}
