import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

/**
 * What mods draw for a thread. A mod is a folder of event hooks the server
 * runs with `@t3tools/mod-engine`; it belongs to no provider. The server keeps
 * a per-thread snapshot of what the mods pushed, and each window showing the
 * thread asks for the trees it draws. Nothing here is persisted.
 */

/** Where an element's handler lives, as the engine stamped it. A press names it back. */
export const ModPressTarget = Schema.Struct({
  plugin: Schema.String,
  handle: Schema.Number,
});
export type ModPressTarget = typeof ModPressTarget.Type;

export interface ModElement {
  readonly type: string;
  readonly props?: { readonly [key: string]: unknown };
  readonly press?: ModPressTarget;
  readonly hover?: { readonly [key: string]: unknown };
  readonly group?: { readonly plugin: string };
  readonly ref?: number;
  readonly children?: ReadonlyArray<ModChild>;
}
export type ModChild = string | ModElement;

/**
 * One node of a mod's render tree. Kept loose on purpose: clients draw the
 * types they know and skip the rest.
 */
export const ModElement: Schema.Codec<ModElement> = Schema.Struct({
  type: Schema.String,
  props: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  press: Schema.optionalKey(ModPressTarget),
  hover: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  group: Schema.optionalKey(Schema.Struct({ plugin: Schema.String })),
  ref: Schema.optionalKey(Schema.Number),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.Union([Schema.String, Schema.suspend((): Schema.Codec<ModElement> => ModElement)]),
    ),
  ),
});

/** A window's id among those drawing a thread: 1 to 64 of letters, digits, `.`, `_`, `-`. */
export const ModClientId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,64}$/));
export type ModClientId = typeof ModClientId.Type;

/** A pane's id as the mod opened it: 1 to 64 of letters, digits, `_`, `-`. */
export const ModPaneId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
export type ModPaneId = typeof ModPaneId.Type;

/** A place a mod draws: a pane's body or the band above the composer. */
export const ModSite = Schema.Literals(["Pane", "AbovePrompt"]);
export type ModSite = typeof ModSite.Type;
export const ModComponent = ModSite;
export type ModComponent = ModSite;

/** The band's fixed instance id. */
export const MOD_BAND_INSTANCE_ID = "above-prompt";

/** What a client draws into, in character cells of its monospace font. */
export const ModViewport = Schema.Struct({
  columns: Schema.Int.check(Schema.isGreaterThan(0)),
  rows: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Whether the client docks panes beside the transcript. */
  isFullscreen: Schema.optionalKey(Schema.Boolean),
});
export type ModViewport = typeof ModViewport.Type;

export const ModStatus = Schema.Struct({
  plugin: Schema.String,
  text: Schema.String,
});
export type ModStatus = typeof ModStatus.Type;

export const ModToast = Schema.Struct({
  seq: Schema.Number,
  plugin: Schema.String,
  text: Schema.String,
  timeoutMs: Schema.Number,
});
export type ModToast = typeof ModToast.Type;

/** One `$.ui.log` line, shown under the mod's name. */
export const ModLogLine = Schema.Struct({
  seq: Schema.Number,
  plugin: Schema.String,
  text: Schema.String,
  /** ISO time the server received it. */
  at: Schema.String,
});
export type ModLogLine = typeof ModLogLine.Type;

export const ModPane = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  plugin: Schema.String,
  closeOnEscape: Schema.optionalKey(Schema.Boolean),
  holdToasts: Schema.optionalKey(Schema.Boolean),
  rows: Schema.optionalKey(Schema.Number),
  columns: Schema.optionalKey(Schema.Number),
});
export type ModPane = typeof ModPane.Type;

/** The thread's open panes as the engine holds them. */
export const ModPaneRoster = Schema.Struct({
  panes: Schema.Array(ModPane),
  shownId: Schema.NullOr(Schema.String),
  focusedId: Schema.NullOr(Schema.String),
  focusRequestedId: Schema.NullOr(Schema.String),
  /** Grows each time a command opened a pane: bring the panes forward. */
  reveal: Schema.Number,
});
export type ModPaneRoster = typeof ModPaneRoster.Type;

/** One instance a partial invalidate made stale. */
export const ModStaleInstance = Schema.Struct({
  seq: Schema.Number,
  component: Schema.String,
  instanceId: Schema.String,
});
export type ModStaleInstance = typeof ModStaleInstance.Type;

/** A mod moved a site's window (`$.ui.scroll`), or sent something to the page in one of its frames (`$.ui.post`). */
export const ModSiteCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    seq: Schema.Number,
    clientId: Schema.String,
    component: ModSite,
    instanceId: Schema.String,
    offset: Schema.Number,
    followEnd: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("post"),
    seq: Schema.Number,
    clientId: Schema.String,
    component: ModSite,
    instanceId: Schema.String,
    plugin: Schema.String,
    key: Schema.String,
    data: Schema.Unknown,
  }),
]);
export type ModSiteCommand = typeof ModSiteCommand.Type;

/**
 * Something a mod asks of one window, which settles it with `answer`. It is
 * given up after five seconds.
 */
export const ModAsk = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("copy"),
    askId: Schema.String,
    clientId: Schema.String,
    plugin: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("promptRead"),
    askId: Schema.String,
    clientId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("promptFill"),
    askId: Schema.String,
    clientId: Schema.String,
    text: Schema.String,
    mode: Schema.Literals(["replace", "append", "insert"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("readSelection"),
    askId: Schema.String,
    clientId: Schema.String,
  }),
]);
export type ModAsk = typeof ModAsk.Type;

/** A slash command a mod registered. */
export const ModCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.optionalKey(Schema.String),
  plugin: Schema.String,
});
export type ModCommand = typeof ModCommand.Type;

/**
 * Everything the server holds of what a thread's mods drew. Sent whole on each
 * change, so a slow client only ever misses intermediate states. Lists that
 * record events (`toasts`, `logs`, `stale`, `commands`) are bounded and carry
 * a per-session `seq` a client compares with the last one it handled.
 */
export const ModSnapshot = Schema.Struct({
  /** Names the thread's running engine; null while it has none. A new value resets every client. */
  session: Schema.NullOr(Schema.String),
  /** The windows attached to the session; one that finds itself missing attaches again. */
  clients: Schema.Array(Schema.String),
  statuses: Schema.Array(ModStatus),
  toasts: Schema.Array(ModToast),
  logs: Schema.Array(ModLogLine),
  panes: ModPaneRoster,
  /** Bumped when every drawn tree may be stale. */
  renderEpoch: Schema.Number,
  /** Instances that alone went stale since `renderEpoch` last moved. */
  stale: Schema.Array(ModStaleInstance),
  commands: Schema.Array(ModSiteCommand),
  asks: Schema.Array(ModAsk),
  /** Moves when the mods' slash commands change; read them with the `slashCommands` operation. */
  slashCommandsRevision: Schema.Number,
});
export type ModSnapshot = typeof ModSnapshot.Type;

export const ModSubscribeInput = Schema.Struct({
  threadId: ThreadId,
  /** The project of a thread not yet started, whose folder the mods run in until it is. */
  projectId: Schema.optionalKey(ProjectId),
  /** The window behind this subscription; it is detached when the subscription ends. */
  clientId: Schema.optionalKey(ModClientId),
});
export type ModSubscribeInput = typeof ModSubscribeInput.Type;

const elementLocation = {
  component: Schema.optionalKey(ModComponent),
  instanceId: Schema.optionalKey(Schema.String),
};

const keyedElement = Schema.Struct({
  plugin: Schema.String,
  key: Schema.String,
  top: Schema.Number,
  bottom: Schema.Number,
});

/** One operation a window asks of the thread's mods. */
export const ModOperation = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("attach"),
    surface: Schema.optionalKey(Schema.Literals(["desktop", "mobile"])),
    viewport: Schema.optionalKey(ModViewport),
  }),
  Schema.Struct({ op: Schema.Literal("detach") }),
  Schema.Struct({
    op: Schema.Literal("render"),
    component: ModComponent,
    instanceId: Schema.String,
    props: Schema.Record(Schema.String, Schema.Unknown),
    viewport: Schema.optionalKey(ModViewport),
    contentRows: Schema.optionalKey(Schema.Number),
    keyed: Schema.optionalKey(Schema.Array(keyedElement)),
  }),
  Schema.Struct({
    op: Schema.Literal("press"),
    plugin: Schema.String,
    handle: Schema.Number,
    key: Schema.optionalKey(Schema.String),
    href: Schema.optionalKey(Schema.String),
    ...elementLocation,
  }),
  Schema.Struct({
    op: Schema.Literal("input"),
    plugin: Schema.String,
    handle: Schema.Number,
    kind: Schema.Literals(["change", "submit"]),
    value: Schema.String,
    key: Schema.optionalKey(Schema.String),
    ...elementLocation,
  }),
  Schema.Struct({
    op: Schema.Literal("select"),
    plugin: Schema.String,
    handle: Schema.Number,
    value: Schema.String,
    key: Schema.optionalKey(Schema.String),
    ...elementLocation,
  }),
  /** The page inside a `Frame` element sent its mod something. */
  Schema.Struct({
    op: Schema.Literal("message"),
    plugin: Schema.String,
    handle: Schema.Number,
    key: Schema.optionalKey(Schema.String),
    data: Schema.Unknown,
    ...elementLocation,
  }),
  Schema.Struct({ op: Schema.Literal("panes") }),
  /** Answered with the `ModCommand` list. */
  Schema.Struct({ op: Schema.Literal("slashCommands") }),
  Schema.Struct({ op: Schema.Literal("paneShow"), id: ModPaneId }),
  Schema.Struct({ op: Schema.Literal("paneFocus"), id: Schema.NullOr(ModPaneId) }),
  Schema.Struct({ op: Schema.Literal("close"), id: ModPaneId }),
  Schema.Struct({
    op: Schema.Literal("scroll"),
    component: ModSite,
    instanceId: Schema.String,
    offset: Schema.Number,
    by: Schema.Number,
    bodyRows: Schema.Number,
    contentRows: Schema.Number,
    keyed: Schema.optionalKey(Schema.Array(keyedElement)),
  }),
  /** Runs a mod's slash command; answers `{ handled, text? }`. */
  Schema.Struct({
    op: Schema.Literal("command"),
    name: Schema.String,
    args: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("answer"),
    askId: Schema.String,
    result: Schema.Record(Schema.String, Schema.Unknown),
  }),
]);
export type ModOperation = typeof ModOperation.Type;

/** What a `render` operation answers. */
export const ModRenderResult = Schema.Struct({
  tree: ModElement,
  props: Schema.Record(Schema.String, Schema.Unknown),
  rewritten: Schema.Boolean,
  /** False when no mod draws this component: stop asking for it until the next invalidate. */
  hooked: Schema.Boolean,
});
export type ModRenderResult = typeof ModRenderResult.Type;

export const ModRequestInput = Schema.Struct({
  threadId: ThreadId,
  clientId: ModClientId,
  /** The `session` the client drew from; a request for a replaced session is refused. */
  session: Schema.String,
  operation: ModOperation,
});
export type ModRequestInput = typeof ModRequestInput.Type;

/**
 * `ok` carries the engine's answer for the operation. `unavailable` means the
 * thread has no such session (it stopped or was replaced); `failed` that the
 * operation threw.
 */
export const ModRequestResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), response: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
  Schema.Struct({ status: Schema.Literal("failed") }),
]);
export type ModRequestResult = typeof ModRequestResult.Type;

const EMPTY_MOD_PANE_ROSTER: ModPaneRoster = {
  panes: [],
  shownId: null,
  focusedId: null,
  focusRequestedId: null,
  reveal: 0,
};

export const EMPTY_MOD_SNAPSHOT: ModSnapshot = {
  session: null,
  clients: [],
  statuses: [],
  toasts: [],
  logs: [],
  panes: EMPTY_MOD_PANE_ROSTER,
  renderEpoch: 0,
  stale: [],
  commands: [],
  asks: [],
  slashCommandsRevision: 0,
};
