import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Mods from "../../../mods/Mods.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  Mods.Mods,
];

const ModsGuideTool = Tool.make("mods_guide", {
  description:
    "Read how to write a mod: a small folder of local code under ~/.agents/mods that adds interface to this app (a pane beside the chat, a band above the composer, status lines, toasts, slash commands). Mods work with every model and cost no tokens to run. Read this before creating or editing one.",
  success: Schema.Struct({ modsDir: Schema.String, guide: Schema.String }),
  failure: OrchestratorMcpFailure,
  dependencies: [Mods.Mods],
})
  .annotate(Tool.Title, "Mod guide")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ModsListTool = Tool.make("mods_list", {
  description:
    "List the installed mods with the slash commands each offers, and the load error of any that failed. Call it after writing a mod to check it loaded.",
  success: Schema.Struct({
    mods: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        path: Schema.String,
        error: Schema.optional(Schema.String),
        commands: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            description: Schema.String,
            argumentHint: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "List mods")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

// Read-only in the MCP sense: it runs the person's own installed mod in the
// caller's thread, as typing the command would, and edits no workspace file.
const ModsRunTool = Tool.make("mods_run", {
  description:
    "Run a mod's slash command in this thread, as if the person typed it: it opens the mod's pane or does whatever the command does, and returns the mod's text reply. Use it to open a mod for the person or to try one you just wrote.",
  parameters: Schema.Struct({
    command: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "The command's name, with or without the leading slash.",
    }),
    args: Schema.optional(Schema.String.annotate({ description: "What follows the command." })),
  }),
  success: Schema.Struct({ handled: Schema.Boolean, text: Schema.optional(Schema.String) }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Run a mod command")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ModsToolkit = Toolkit.make(ModsGuideTool, ModsListTool, ModsRunTool);
