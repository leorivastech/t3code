/**
 * The host protocol of the mod engine: what an editor sends the engine and
 * what the engine tells the editor. Plain data throughout, so it can cross a
 * socket, a worker boundary or a process pipe unchanged.
 *
 * A mod is a folder with a `mod.json` and a module that exports
 * `register(on)`. The engine runs its hooks; the host only draws trees and
 * reports what the person does.
 */

/** Where a tree is drawn. A mod reads it as `e.surface` and picks elements for it. */
export type ModSurface = "terminal" | "desktop" | "mobile" | "vscode";

/** A place a mod may draw: a pane, the band above the prompt, or one of the host's own rows. */
export type ModComponent =
  | "AskUserQuestion"
  | "UserMessage"
  | "AssistantMessage"
  | "ToolUse"
  | "ToolResult"
  | "ToolGroup"
  | "ToolProgress"
  | "CommandOutput"
  | "Spinner"
  | "TurnDuration"
  | "InfoNotice"
  | "SessionMode"
  | "PromptHint"
  | "AbovePrompt"
  | "Pane";

/** What a client draws into, in character cells of its monospace font. */
export interface ModViewport {
  readonly columns: number;
  readonly rows: number;
  /** Whether the client docks panes beside the transcript. */
  readonly isFullscreen?: boolean;
}

/** Names the handler of a Button, Input, Select or pressable Markdown. */
export interface ModPressTarget {
  readonly plugin: string;
  readonly handle: number;
}

/** One node of a drawn tree. `engine` nodes mark where the host draws its own component. */
export interface ModElement {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly press?: ModPressTarget;
  readonly hover?: Readonly<Record<string, unknown>>;
  readonly group?: { readonly plugin: string };
  readonly ref?: number;
  readonly children?: ReadonlyArray<string | ModElement>;
}

export interface ModPane {
  readonly id: string;
  readonly title: string;
  readonly plugin: string;
  readonly closeOnEscape?: true;
  readonly holdToasts?: true;
  readonly rows?: number;
  readonly columns?: number;
}

export interface ModPaneRoster {
  readonly panes: ReadonlyArray<ModPane>;
  readonly shownId: string | null;
  readonly focusedId: string | null;
  readonly focusRequestedId: string | null;
  /**
   * Grows each time a command opened a pane: the person, or their agent, asked
   * for it, so the host brings the panes forward even if they were put away.
   */
  readonly reveal: number;
}

export interface ModCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly plugin: string;
}

export interface ModInstanceRef {
  readonly component: ModComponent;
  readonly instanceId: string;
}

/** What the engine tells its host, in order. */
export type ModEngineEvent =
  | { readonly type: "status"; readonly plugin: string; readonly text: string | null }
  | {
      readonly type: "toast";
      readonly plugin: string;
      readonly text: string;
      readonly timeoutMs: number;
    }
  | { readonly type: "log"; readonly plugin: string; readonly text: string }
  | { readonly type: "panes"; readonly roster: ModPaneRoster }
  /** Drawn trees are stale: all of them, or only `instances`. */
  | { readonly type: "invalidate"; readonly instances?: ReadonlyArray<ModInstanceRef> }
  | {
      readonly type: "scroll";
      readonly clientId: string;
      readonly component: "Pane" | "AbovePrompt";
      readonly instanceId: string;
      readonly offset: number;
      readonly followEnd?: true;
    }
  /** A mod sent `data` to the page inside one of its `Frame` elements. */
  | {
      readonly type: "post";
      readonly clientId: string;
      readonly component: "Pane" | "AbovePrompt";
      readonly instanceId: string;
      readonly plugin: string;
      readonly key: string;
      readonly data: unknown;
    }
  | { readonly type: "commands"; readonly commands: ReadonlyArray<ModCommand> };

/** Something a mod asks of the person's window; the host answers or returns `undefined`. */
export type ModAsk =
  | { readonly kind: "copy"; readonly plugin: string; readonly text: string }
  | { readonly kind: "promptRead" }
  | {
      readonly kind: "promptFill";
      readonly text: string;
      readonly mode: "replace" | "append" | "insert";
    }
  | { readonly kind: "readSelection" };

export interface ModRenderInput {
  readonly clientId: string;
  readonly component: ModComponent;
  readonly instanceId: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly viewport?: ModViewport;
}

export interface ModRenderResult {
  readonly tree: ModElement;
  /** What to draw the `engine` node with: a hook's rewrite of the props, or the input's own. */
  readonly props: Readonly<Record<string, unknown>>;
  readonly rewritten: boolean;
  /** False when no mod hooks this component: the host may stop asking until an invalidate. */
  readonly hooked: boolean;
}

/** Where an element sits, for a press, an input or a pick. */
export interface ModElementAddress {
  readonly clientId: string;
  readonly plugin: string;
  readonly handle: number;
  readonly key?: string;
  readonly component?: ModComponent;
  readonly instanceId?: string;
}

/** How a site was laid out when the person scrolled it. */
export interface ModScrollReport {
  readonly clientId: string;
  readonly component: "Pane" | "AbovePrompt";
  readonly instanceId: string;
  readonly offset: number;
  readonly by: number;
  readonly bodyRows: number;
  readonly contentRows: number;
  readonly keyed?: ReadonlyArray<{
    readonly plugin: string;
    readonly key: string;
    readonly top: number;
    readonly bottom: number;
  }>;
}

/** What the agent did, for mods that follow a turn. The host reports; a mod only observes. */
export type ModAgentEvent =
  | { readonly name: "prompt.submit"; readonly text: string }
  | { readonly name: "turn.start"; readonly turnId: string; readonly text: string }
  | {
      readonly name: "turn.complete";
      readonly turnId: string;
      readonly reason: "answer" | "aborted" | "error";
    }
  | {
      readonly name: "tool.call";
      readonly tool: string;
      readonly toolUseId: string;
      readonly input: Readonly<Record<string, unknown>>;
    };

/** A mod folder that was found, and why it did not load when it did not. */
export interface ModPluginInfo {
  readonly name: string;
  readonly path: string;
  readonly error?: string;
  /** Calls the mod made that this engine does not provide. */
  readonly unsupported: ReadonlyArray<string>;
}
