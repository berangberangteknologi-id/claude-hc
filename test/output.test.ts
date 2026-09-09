import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUMMARY_MAX,
  buildJsonLine,
  collapseSummary,
  deriveStatus,
  extractQuestions,
  filterNewQuestions,
  formatQuestionsText,
  isToolAllowed,
} from "../src/output.js";
import type { Question, TurnResult } from "../src/types.js";

const twoQuestions: Question[] = [
  {
    header: "Auth method",
    question: "Which auth method should we use?",
    options: [
      { label: "OAuth", description: "Browser login" },
      { label: "API key", description: "Static key" },
    ],
    multiSelect: false,
  },
  {
    header: "Scope",
    question: "Which features?",
    options: [
      { label: "Import", description: "" },
      { label: "Export", description: "" },
    ],
    multiSelect: true,
  },
];

test("collapseSummary collapses whitespace and keeps short text intact", () => {
  assert.equal(collapseSummary("  Hello\n\n   world \t!"), "Hello world !");
});

test("collapseSummary truncates to SUMMARY_MAX with an ellipsis", () => {
  const long = "word ".repeat(100); // 500 chars
  const out = collapseSummary(long);
  assert.equal(out.length, SUMMARY_MAX);
  assert.ok(out.endsWith("..."));
  assert.equal(collapseSummary("x".repeat(300)).length, 300);
  assert.equal(collapseSummary("x".repeat(301)).endsWith("..."), true);
});

test("extractQuestions copies AskUserQuestion input and drops preview", () => {
  const input = {
    questions: [
      {
        header: "Auth method",
        question: "Which auth method should we use?",
        options: [
          { label: "OAuth", description: "Browser login", preview: "<b>x</b>" },
          { label: "API key", description: "Static key" },
        ],
        multiSelect: false,
      },
    ],
  };
  const qs = extractQuestions(input);
  assert.deepEqual(qs, [twoQuestions[0]]);
});

test("extractQuestions tolerates missing fields and non-arrays", () => {
  assert.deepEqual(extractQuestions(null), []);
  assert.deepEqual(extractQuestions({ questions: "nope" }), []);
  assert.deepEqual(extractQuestions({ questions: [{ question: "Only text?" }] }), [
    { header: "", question: "Only text?", options: [], multiSelect: false },
  ]);
});

test("formatQuestionsText matches the v0.3.0 text layout", () => {
  const text = formatQuestionsText([twoQuestions[0]]);
  assert.equal(
    text,
    "\n[Auth method] Which auth method should we use?\n" +
      "  1. OAuth — Browser login\n" +
      "  2. API key — Static key\n",
  );
  assert.equal(
    formatQuestionsText([{ header: "", question: "Q?", options: [{ label: "A", description: "" }], multiSelect: false }]),
    "\nQ?\n  1. A\n",
  );
});

test("deriveStatus follows exit code first, then questions", () => {
  assert.equal(deriveStatus(0, []), "done");
  assert.equal(deriveStatus(0, twoQuestions), "needs_input");
  assert.equal(deriveStatus(1, twoQuestions), "error");
  assert.equal(deriveStatus(3, []), "error");
});

test("filterNewQuestions drops exact duplicates and keeps first-occurrence order", () => {
  const seen = new Set<string>();
  const color = twoQuestions[0];
  const scope = twoQuestions[1];
  const colorAgain: Question = JSON.parse(JSON.stringify(color)); // same content, different object identity

  const first = filterNewQuestions([color, scope], seen);
  assert.deepEqual(first, [color, scope]);

  const second = filterNewQuestions([colorAgain, scope], seen);
  assert.deepEqual(second, []);

  const colorMultiSelect: Question = { ...color, multiSelect: true };
  const third = filterNewQuestions([colorMultiSelect], seen);
  assert.deepEqual(third, [colorMultiSelect]);
});

test("isToolAllowed matches exact names and MCP wildcard/server patterns", () => {
  const builtins = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "mcp__*"];
  assert.equal(isToolAllowed("Bash", builtins), true);
  assert.equal(isToolAllowed("Task", builtins), false);
  // "mcp__*" covers every MCP tool from every connected server.
  assert.equal(isToolAllowed("mcp__plugin_playwright_playwright__browser_navigate", builtins), true);
  assert.equal(isToolAllowed("mcp__anything__at_all", builtins), true);
  // A server-scoped entry only covers that server, with or without "__*".
  const oneServer = ["Read", "mcp__github"];
  assert.equal(isToolAllowed("mcp__github__create_issue", oneServer), true);
  assert.equal(isToolAllowed("mcp__github", oneServer), true);
  assert.equal(isToolAllowed("mcp__gitlab__create_issue", oneServer), false);
  const oneServerStar = ["mcp__github__*"];
  assert.equal(isToolAllowed("mcp__github__create_issue", oneServerStar), true);
  // No MCP entry at all: MCP tools are denied same as any other unlisted tool.
  assert.equal(isToolAllowed("mcp__github__create_issue", ["Read", "Bash"]), false);
});

test("buildJsonLine emits one line with keys in the contract order", () => {
  const result: TurnResult = {
    claude_hc: 1,
    status: "needs_input",
    turn: 2,
    summary: "Two approaches fit.",
    questions: twoQuestions,
    result_subtype: "success",
    exit_code: 0,
    error: null,
    session_id: "9f2c",
    result_file: "/tmp/x/turn-0002.json",
  };
  const line = buildJsonLine(result);
  assert.equal(line.includes("\n"), false);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [
    "claude_hc", "status", "turn", "summary", "questions",
    "result_subtype", "exit_code", "error", "session_id", "result_file",
  ]);
  assert.equal(parsed.session_id, "9f2c");
  assert.ok(line.endsWith('"result_file":"/tmp/x/turn-0002.json"}'));
});
