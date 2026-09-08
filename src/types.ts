// Shared wire types for claude-hc. Field names are snake_case because these
// objects are serialized verbatim into the JSON line and the result files
// (see the design spec, sections 3.2 and 3.3).

export type TurnStatus = "done" | "needs_input" | "error";

export type ErrorCode =
  | "session_busy"
  | "no_result_message"
  | "non_success_result"
  | "usage"
  | "exception";

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface TurnError {
  code: ErrorCode;
  message: string;
}

/** Exactly the fields of the JSON line, in the order they are printed. */
export interface TurnResult {
  claude_hc: 1;
  status: TurnStatus;
  turn: number | null;
  summary: string;
  questions: Question[];
  result_subtype: string | null;
  exit_code: number;
  error: TurnError | null;
  session_id: string | null;
  result_file: string | null;
}

/** The result file: the JSON line fields plus the full record. */
export interface TurnRecord extends TurnResult {
  text: string;
  prompt: string;
  resume_from: string | null;
  cwd: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  num_turns: number | null;
  total_cost_usd: number | null;
  allowed_tools: string[];
  disallowed_tools: string[] | null;
  model: string | null;
  max_turns: number | null;
  claude_hc_version: string;
}

export interface LockInfo {
  pid: number;
  started_at: string;
  turn: number;
}

export type LockResult =
  | { acquired: true }
  | { acquired: false; pid: number; started_at: string };

export interface SessionStatus {
  claude_hc: 1;
  session_id: string;
  session_dir: string;
  in_flight: boolean;
  pid: number | null;
  lock_started_at: string | null;
  last: TurnRecord | null;
}
