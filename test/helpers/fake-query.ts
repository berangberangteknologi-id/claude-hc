import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../../src/run.js";

export type FakeStep =
  | { kind: "init"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "ask"; input: unknown }
  | { kind: "result"; subtype: string }
  | { kind: "throw"; message: string }
  | { kind: "end" };

export interface FakeQuery {
  query: QueryFn;
  calls: Array<{ prompt: string; options: Options | undefined }>;
  permissionResults: unknown[];
}

/** Replays scripted SDK messages; "ask" steps call options.canUseTool like the SDK would. */
export function makeFakeQuery(steps: FakeStep[]): FakeQuery {
  const fake: FakeQuery = { query: undefined as unknown as QueryFn, calls: [], permissionResults: [] };
  fake.query = (params) => {
    fake.calls.push({ prompt: params.prompt, options: params.options });
    const sessionIdOf = () => {
      const init = steps.find((s) => s.kind === "init");
      return init && init.kind === "init" ? init.sessionId : "unknown";
    };
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const step of steps) {
        switch (step.kind) {
          case "init":
            yield { type: "system", subtype: "init", session_id: step.sessionId, cwd: "/tmp", model: "fake-model" } as unknown as SDKMessage;
            break;
          case "text":
            yield {
              type: "assistant",
              session_id: sessionIdOf(),
              message: { role: "assistant", content: [{ type: "text", text: step.text }] },
            } as unknown as SDKMessage;
            break;
          case "tool":
            yield {
              type: "assistant",
              session_id: sessionIdOf(),
              message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: step.name, input: {} }] },
            } as unknown as SDKMessage;
            break;
          case "ask": {
            yield {
              type: "assistant",
              session_id: sessionIdOf(),
              message: { role: "assistant", content: [{ type: "tool_use", id: "tu_ask", name: "AskUserQuestion", input: step.input }] },
            } as unknown as SDKMessage;
            const canUseTool = params.options?.canUseTool;
            if (canUseTool) {
              const res = await canUseTool("AskUserQuestion", step.input as Record<string, unknown>, {
                signal: new AbortController().signal,
                suggestions: [],
              } as never);
              fake.permissionResults.push(res);
            }
            break;
          }
          case "result":
            yield {
              type: "result",
              subtype: step.subtype,
              session_id: sessionIdOf(),
              is_error: step.subtype !== "success",
              num_turns: 1,
              total_cost_usd: 0.01,
              duration_ms: 5,
              result: "",
            } as unknown as SDKMessage;
            break;
          case "throw":
            throw new Error(step.message);
          case "end":
            return;
        }
      }
    }
    return gen();
  };
  return fake;
}

export const askInput = {
  questions: [
    {
      header: "Color",
      question: "Which color?",
      options: [
        { label: "Red", description: "warm" },
        { label: "Blue", description: "cool" },
      ],
      multiSelect: false,
    },
  ],
};
