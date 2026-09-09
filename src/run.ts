import type { CanUseTool, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { collapseSummary, deriveStatus, extractQuestions, filterNewQuestions, formatQuestionsText, isToolAllowed } from "./output.js";
import type { SessionStore } from "./session-store.js";
import type { Question, TurnError, TurnRecord, TurnResult } from "./types.js";

export const DENY_MESSAGE =
  "Already shown to the user above — their reply will be your next message. End your turn now.";

export const NO_RESULT_MESSAGE =
  "[claude-hc] the session ended without a result message — the turn's actual outcome is unknown " +
  "(possibly killed mid-turn during a long silent tool call; see README's Known limitations). " +
  "Re-run with -r to see if the session can still be resumed.";

export interface TurnParams {
  prompt: string;
  resumeId: string | null;
  cwd: string;
  allowedTools: string[];
  disallowedTools: string[] | null;
  model: string | null;
  maxTurns: number | null;
  jsonMode: boolean;
}

export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface TurnDeps {
  query: QueryFn;
  store: SessionStore;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  now: () => Date;
  version: string;
}

// The lock held by the turn currently running in this process, so a signal
// handler can release it before exiting.
let activeLock: { store: SessionStore; sessionId: string } | null = null;

export function releaseActiveLock(): void {
  if (activeLock) {
    activeLock.store.releaseLock(activeLock.sessionId);
    activeLock = null;
  }
}

/** Narrow view of the SDK result message; error variants share these fields. */
interface ResultLike {
  type: "result";
  subtype: string;
  session_id: string;
  num_turns?: number;
  total_cost_usd?: number;
}

function busyResult(sessionId: string, pid: number, startedAt: string): TurnResult {
  return {
    claude_hc: 1,
    status: "error",
    turn: null,
    summary: "",
    questions: [],
    result_subtype: null,
    exit_code: 3,
    error: {
      code: "session_busy",
      message: `session ${sessionId} is in use by pid ${pid} since ${startedAt || "unknown"}`,
    },
    session_id: sessionId,
    result_file: null,
  };
}

export async function runTurn(params: TurnParams, deps: TurnDeps): Promise<TurnResult> {
  const startedAt = deps.now();
  const { store } = deps;
  let sessionId: string | null = params.resumeId;
  let turn: number | null = null;
  let lockHeld = false;

  if (params.resumeId) {
    turn = store.nextTurnNumber(params.resumeId);
    const lock = store.acquireLock(params.resumeId, turn);
    if (!lock.acquired) return busyResult(params.resumeId, lock.pid, lock.started_at);
    lockHeld = true;
    activeLock = { store, sessionId: params.resumeId };
  }

  const questions: Question[] = [];
  const seenQuestionKeys = new Set<string>();
  const allText: string[] = [];
  let lastMessageText = "";
  let sawResult = false;
  let resultSubtype: string | null = null;
  let numTurns: number | null = null;
  let totalCostUsd: number | null = null;
  let exitCode = 0;
  let error: TurnError | null = null;
  let busy: TurnResult | null = null;

  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName === "AskUserQuestion") {
      const extracted = extractQuestions(input);
      const fresh = filterNewQuestions(extracted, seenQuestionKeys);
      questions.push(...fresh);
      if (!params.jsonMode && fresh.length > 0) deps.stdout(formatQuestionsText(fresh));
      return { behavior: "deny", message: DENY_MESSAGE };
    }
    if (isToolAllowed(toolName, params.allowedTools)) return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: `Tool "${toolName}" is not in --allowed-tools.` };
  };

  const options: Options = {
    allowedTools: params.allowedTools.filter((t) => t !== "AskUserQuestion"),
    cwd: params.cwd,
    canUseTool,
    ...(params.disallowedTools ? { disallowedTools: params.disallowedTools } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.maxTurns !== null ? { maxTurns: params.maxTurns } : {}),
    ...(params.resumeId ? { resume: params.resumeId } : {}),
  };

  try {
    for await (const message of deps.query({ prompt: params.prompt, options })) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        if (!params.resumeId) {
          turn = store.nextTurnNumber(sessionId);
          const lock = store.acquireLock(sessionId, turn);
          if (!lock.acquired) {
            busy = busyResult(sessionId, lock.pid, lock.started_at);
            break;
          }
          lockHeld = true;
          activeLock = { store, sessionId };
        }
      } else if (message.type === "assistant") {
        let messageText = "";
        for (const block of message.message.content) {
          if (block.type === "text") {
            messageText += block.text;
            allText.push(block.text);
            if (!params.jsonMode) deps.stdout(block.text);
          } else if (block.type === "tool_use") {
            deps.stderr(`\n[claude-hc] using tool: ${block.name}\n`);
          }
        }
        if (messageText) lastMessageText = messageText;
      } else if (message.type === "result") {
        const result = message as unknown as ResultLike;
        sawResult = true;
        resultSubtype = typeof result.subtype === "string" ? result.subtype : null;
        numTurns = typeof result.num_turns === "number" ? result.num_turns : null;
        totalCostUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : null;
        if (!params.jsonMode) deps.stdout("\n");
        if (result.subtype !== "success") {
          deps.stderr(`[claude-hc] stopped: ${result.subtype}\n`);
          exitCode = 1;
          error = { code: "non_success_result", message: `turn ended with ${result.subtype}` };
        }
      }
    }
    if (!busy && !sawResult && exitCode === 0) {
      deps.stderr(NO_RESULT_MESSAGE + "\n");
      exitCode = 2;
      error = { code: "no_result_message", message: "the session ended without a result message" };
    }
  } catch (err) {
    deps.stderr(`[claude-hc] error: ${err instanceof Error && err.stack ? err.stack : String(err)}\n`);
    exitCode = 1;
    error = { code: "exception", message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (lockHeld && sessionId) store.releaseLock(sessionId);
    activeLock = null;
    if (!params.jsonMode && sessionId) deps.stderr(`[claude-hc] session_id: ${sessionId}\n`);
  }

  if (busy) return busy;

  const endedAt = deps.now();
  const status = deriveStatus(exitCode, questions);
  const base: TurnResult = {
    claude_hc: 1,
    status,
    turn,
    summary: collapseSummary(lastMessageText),
    questions,
    result_subtype: resultSubtype,
    exit_code: exitCode,
    error,
    session_id: sessionId,
    result_file: null,
  };
  if (!sessionId || turn === null) return base;

  const record: TurnRecord = {
    ...base,
    text: allText.join(""),
    prompt: params.prompt,
    resume_from: params.resumeId,
    cwd: params.cwd,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - startedAt.getTime(),
    num_turns: numTurns,
    total_cost_usd: totalCostUsd,
    allowed_tools: params.allowedTools,
    disallowed_tools: params.disallowedTools,
    model: params.model,
    max_turns: params.maxTurns,
    claude_hc_version: deps.version,
  };
  const resultFile = store.writeTurnResult(sessionId, turn, record);
  return { ...base, result_file: resultFile };
}
