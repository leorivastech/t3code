import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Mods from "../../../mods/Mods.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ModsToolkit } from "./tools.ts";

/** The calling thread and the folder it works in, which is where its mods run. */
const callerThread = (operation: string) =>
  Effect.gen(function* () {
    const { thread } = yield* McpInvocationContext.requireThreadScope(
      yield* McpInvocationContext.McpInvocationContext,
      operation,
    );
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const cwd = Effect.gen(function* () {
      const records = yield* threads.getThreadRecords(thread.threadId, []);
      if (records.thread.worktreePath) return records.thread.worktreePath;
      const project = yield* projects.getById(records.thread.projectId);
      return Option.isSome(project) ? project.value.workspaceRoot : process.cwd();
    }).pipe(Effect.catchCause(() => Effect.succeed(process.cwd())));
    return { threadId: thread.threadId as ThreadId, cwd };
  });

const handlers = {
  mods_guide: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const mods = yield* Mods.Mods;
      return yield* mods.guide;
    }),
  ),
  mods_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { threadId, cwd } = yield* callerThread("mods_list");
      const mods = yield* Mods.Mods;
      return { mods: yield* mods.list(threadId, cwd) };
    }),
  ),
  // A mod is local code that may write files or run programs, so it runs only for a live thread.
  mods_run: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, cwd } = yield* callerThread("mods_run");
      const mods = yield* Mods.Mods;
      return yield* mods.runCommand(threadId, cwd, input.command, input.args ?? "");
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ModsToolkit.tools>;

export const layer = McpToolAccess.toLayer(ModsToolkit, handlers);
