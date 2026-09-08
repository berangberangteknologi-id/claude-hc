import type { Question, TurnResult, TurnStatus } from "./types.js";

export const SUMMARY_MAX = 300;

/** Collapse whitespace and cap the length, appending "..." when cut. */
export function collapseSummary(text: string, max: number = SUMMARY_MAX): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 3).trimEnd() + "...";
}

/** Copy the questions out of an AskUserQuestion tool input, verbatim minus `preview`. */
export function extractQuestions(input: unknown): Question[] {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const item = (q ?? {}) as Record<string, unknown>;
    const options = Array.isArray(item.options) ? item.options : [];
    return {
      header: typeof item.header === "string" ? item.header : "",
      question: typeof item.question === "string" ? item.question : "",
      options: options.map((o) => {
        const opt = (o ?? {}) as Record<string, unknown>;
        return {
          label: typeof opt.label === "string" ? opt.label : "",
          description: typeof opt.description === "string" ? opt.description : "",
        };
      }),
      multiSelect: item.multiSelect === true,
    };
  });
}

/** Text-mode rendering, byte-for-byte the v0.3.0 layout. */
export function formatQuestionsText(questions: Question[]): string {
  let out = "";
  for (const q of questions) {
    out += `\n${q.header ? `[${q.header}] ` : ""}${q.question}\n`;
    q.options.forEach((opt, idx) => {
      out += `  ${idx + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}\n`;
    });
  }
  return out;
}

export function deriveStatus(exitCode: number, questions: Question[]): TurnStatus {
  if (exitCode !== 0) return "error";
  return questions.length > 0 ? "needs_input" : "done";
}

/** One JSON line, keys in the contract order (session id and file path last). */
export function buildJsonLine(result: TurnResult): string {
  const ordered: TurnResult = {
    claude_hc: 1,
    status: result.status,
    turn: result.turn,
    summary: result.summary,
    questions: result.questions,
    result_subtype: result.result_subtype,
    exit_code: result.exit_code,
    error: result.error,
    session_id: result.session_id,
    result_file: result.result_file,
  };
  return JSON.stringify(ordered);
}
