import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import type { ModAgentEvent } from "@t3tools/mod-engine";

const RUN_ENDINGS = {
  completed: "answer",
  interrupted: "aborted",
  cancelled: "aborted",
  rolled_back: "aborted",
  failed: "error",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const TOOL_ITEMS = new Set(["command_execution", "file_change", "file_search", "dynamic_tool"]);

/**
 * Reads the orchestration event log as what a mod may watch: a turn starting,
 * each tool it uses, the turn ending. The log repeats a run or an item as it
 * changes, so this remembers what it already told; providers differ in nothing
 * here, since the log is the same for all of them.
 */
export function makeAgentEventReader() {
  /** Runs that started and have not ended, each with the tool items already told. */
  const running = new Map<string, Set<string>>();

  return (
    event: OrchestrationV2DomainEvent,
  ): { readonly threadId: ThreadId; readonly event: ModAgentEvent } | null => {
    if (event.type === "run.created" || event.type === "run.updated") {
      const run = event.payload;
      if (run.status === "running" && !running.has(run.id)) {
        running.set(run.id, new Set());
        return { threadId: run.threadId, event: { name: "turn.start", turnId: run.id, text: "" } };
      }
      const reason = RUN_ENDINGS[run.status as keyof typeof RUN_ENDINGS];
      if (reason !== undefined && running.delete(run.id)) {
        return { threadId: run.threadId, event: { name: "turn.complete", turnId: run.id, reason } };
      }
      return null;
    }
    if (event.type === "turn-item.updated") {
      const item = event.payload;
      const told = item.runId === null ? undefined : running.get(item.runId);
      if (told === undefined || told.has(item.id) || !TOOL_ITEMS.has(item.type)) return null;
      told.add(item.id);
      return {
        threadId: item.threadId,
        event: {
          name: "tool.call",
          tool: item.type === "dynamic_tool" ? (item.toolName ?? item.type) : item.type,
          toolUseId: item.id,
          input:
            item.type === "command_execution"
              ? { command: item.input }
              : item.type === "dynamic_tool" && isRecord(item.input)
                ? item.input
                : {},
        },
      };
    }
    return null;
  };
}
