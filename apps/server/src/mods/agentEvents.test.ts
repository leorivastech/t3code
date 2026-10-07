import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeAgentEventReader } from "./agentEvents.ts";

/** Only the fields the reader looks at; the log's events carry many more. */
const run = (status: string) =>
  ({
    type: "run.updated",
    threadId: "thread-1",
    payload: { id: "run-1", threadId: "thread-1", status },
  }) as unknown as OrchestrationV2DomainEvent;

const item = (id: string, type: string, input?: string) =>
  ({
    type: "turn-item.updated",
    threadId: "thread-1",
    payload: { id, threadId: "thread-1", runId: "run-1", type, status: "running", input },
  }) as unknown as OrchestrationV2DomainEvent;

describe("makeAgentEventReader", () => {
  it("tells a turn's start, each tool once, and its end, however often the log repeats them", () => {
    const read = makeAgentEventReader();
    const told = [
      run("starting"),
      run("running"),
      run("running"),
      item("i1", "command_execution", "ls"),
      item("i1", "command_execution", "ls"),
      item("i2", "assistant_message"),
      item("i3", "file_change"),
      run("completed"),
      run("completed"),
    ].map((event) => read(event)?.event ?? null);

    expect(told).toEqual([
      null,
      { name: "turn.start", turnId: "run-1", text: "" },
      null,
      { name: "tool.call", tool: "command_execution", toolUseId: "i1", input: { command: "ls" } },
      null,
      null,
      { name: "tool.call", tool: "file_change", toolUseId: "i3", input: {} },
      { name: "turn.complete", turnId: "run-1", reason: "answer" },
      null,
    ]);
  });

  it("says why a turn ended when it did not answer", () => {
    const read = makeAgentEventReader();
    read(run("running"));
    expect(read(run("interrupted"))?.event).toMatchObject({ reason: "aborted" });
    read(run("running"));
    expect(read(run("failed"))?.event).toMatchObject({ reason: "error" });
  });
});
