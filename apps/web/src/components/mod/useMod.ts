import {
  type ModAsk,
  ModCommand,
  type ModComponent,
  type ModOperation,
  type ModSnapshot,
  EMPTY_MOD_SNAPSHOT,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { randomUUID } from "~/lib/utils";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { type ModInstanceAsk, type ModSurface, createModSurface } from "./modSurface";

/**
 * This window's id among those drawing a thread's mods. One per page load: two
 * windows on one thread are two clients with their own sizes.
 */
const CLIENT_ID = `t3-${randomUUID().replaceAll("-", "").slice(0, 16)}`;

type Send = (
  session: string,
  operation: ModOperation,
) => ReturnType<Parameters<typeof createModSurface>[0]["send"]>;

/** Answers what a mod asks of the composer. */
type ModAskHandler = (ask: ModAsk) => Record<string, unknown> | undefined;

interface SurfaceEntry {
  readonly surface: ModSurface;
  /** The newest `send`; every mounted consumer of the thread sets the same one. */
  send: Send | null;
  /** The composer's answers, while one is mounted for the thread. */
  askHandler: ModAskHandler | null;
  consumers: number;
}

// One surface per thread shown in this window, shared by the band, the panes
// and the composer.
const surfaces = new Map<string, SurfaceEntry>();

/** What the person has selected in the page, as a copy would take it. */
function readSelection(): Record<string, unknown> {
  const text = window.getSelection()?.toString() ?? "";
  return text === "" ? {} : { text };
}

async function answerAsk(
  entry: SurfaceEntry,
  ask: ModAsk,
): Promise<Record<string, unknown> | undefined> {
  switch (ask.kind) {
    case "copy":
      try {
        await navigator.clipboard.writeText(ask.text);
        return { copied: true };
      } catch {
        return { copied: false };
      }
    case "readSelection":
      return readSelection();
    default:
      return entry.askHandler?.(ask);
  }
}

/** Shows what a mod has to say, under the mod's name. */
function showModToast(notice: {
  readonly plugin: string;
  readonly text: string;
  readonly timeoutMs?: number;
}) {
  toastManager.add({
    type: "info",
    title: notice.plugin,
    description: notice.text,
    ...(notice.timeoutMs === undefined ? {} : { timeout: notice.timeoutMs }),
  });
}

// The server does not know a thread before its first message, so the view
// that shows such a draft says which project's folder its mods run in.
const draftProjects = new Map<string, ProjectId>();

/** Names the project of a thread that is still a draft; null once the server has the thread. */
export function setModDraftProject(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: ProjectId | null,
): void {
  const key = `${environmentId}\u0000${threadId}`;
  if (projectId === null) draftProjects.delete(key);
  else draftProjects.set(key, projectId);
}

function acquireSurface(key: string): SurfaceEntry {
  let entry = surfaces.get(key);
  if (entry === undefined) {
    const created: SurfaceEntry = {
      send: null,
      askHandler: null,
      consumers: 0,
      surface: createModSurface({
        clientId: CLIENT_ID,
        send: async (session, operation) => created.send?.(session, operation),
        onNotice: showModToast,
        onAsk: (ask) => answerAsk(created, ask),
      }),
    };
    entry = created;
    surfaces.set(key, entry);
  }
  return entry;
}

/** Counts one more consumer of the thread's surface; returns the release. */
function retainSurface(key: string): () => void {
  const entry = acquireSurface(key);
  entry.consumers += 1;
  return () => {
    entry.consumers -= 1;
    // Deferred: an effect that re-runs at once (StrictMode) must find the same surface.
    queueMicrotask(() => {
      if (entry.consumers === 0 && surfaces.get(key) === entry) surfaces.delete(key);
    });
  };
}

function setSurfaceSend(key: string, send: Send) {
  acquireSurface(key).send = send;
}

/** Routes the composer's asks to `handler` until the returned release runs. */
function setSurfaceAskHandler(key: string, handler: ModAskHandler): () => void {
  const entry = acquireSurface(key);
  entry.askHandler = handler;
  return () => {
    if (entry.askHandler === handler) entry.askHandler = null;
  };
}

/**
 * One thread's mods: the surface that draws for it and the server's latest
 * snapshot. Pass a null thread to stay idle.
 */
export function useMod(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): {
  readonly surface: ModSurface;
  readonly snapshot: ModSnapshot;
  /** False until the server's first snapshot arrives: `snapshot` is then only a placeholder. */
  readonly isLoaded: boolean;
} | null {
  const projectId =
    threadId === null ? undefined : draftProjects.get(`${environmentId}\u0000${threadId}`);
  const snapshot = useEnvironmentQuery(
    threadId === null
      ? null
      : serverEnvironment.mod({
          environmentId,
          input:
            projectId === undefined
              ? { threadId, clientId: CLIENT_ID }
              : { threadId, clientId: CLIENT_ID, projectId },
        }),
  ).data;
  const request = useAtomCommand(serverEnvironment.requestMod, {
    reportFailure: false,
    reportDefect: false,
  });
  const key = threadId === null ? null : `${environmentId}\u0000${threadId}`;
  const entry = key === null ? null : acquireSurface(key);

  useEffect(() => (key === null ? undefined : retainSurface(key)), [key]);

  useEffect(() => {
    if (key === null || threadId === null) return;
    setSurfaceSend(key, async (session, operation) => {
      const result = await request({
        environmentId,
        input: { threadId, clientId: CLIENT_ID, session, operation },
      });
      return result._tag === "Success" ? result.value : undefined;
    });
  }, [environmentId, key, request, threadId]);

  useEffect(() => {
    if (entry !== null && snapshot !== null) entry.surface.applySnapshot(snapshot);
  }, [entry, snapshot]);

  if (entry === null) return null;
  return {
    surface: entry.surface,
    snapshot: snapshot ?? EMPTY_MOD_SNAPSHOT,
    isLoaded: snapshot !== null && snapshot !== undefined,
  };
}

/**
 * Lets the thread's composer answer what mods ask of it (`$.prompt.read`,
 * `$.prompt.fill`) for as long as it is mounted.
 */
export function useModAskHandler(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  handler: ModAskHandler,
) {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (threadId === null) return;
    return setSurfaceAskHandler(`${environmentId}\u0000${threadId}`, (ask) => latest.current(ask));
  }, [environmentId, threadId]);
}

/**
 * Draws one component instance through the surface and returns the mods'
 * latest drawing of it, or null while none draws it. `ask` is read on each
 * ask; a change of `askKey` asks again.
 */
export function useModInstance(
  surface: ModSurface | null,
  component: ModComponent,
  instanceId: string,
  ask: ModInstanceAsk,
  askKey: string,
) {
  const latest = useRef(ask);
  useLayoutEffect(() => {
    latest.current = ask;
  });
  const mountedKey = useRef<string | null>(null);

  useEffect(() => {
    if (surface === null) return;
    mountedKey.current = null;
    return surface.mount(component, instanceId, () => latest.current);
  }, [surface, component, instanceId]);

  useEffect(() => {
    if (surface === null) return;
    // The mount already asked with the first key.
    if (mountedKey.current !== null) surface.refresh(component, instanceId);
    mountedKey.current = askKey;
  }, [surface, component, instanceId, askKey]);

  return useSyncExternalStore(
    (listener) => surface?.subscribe(component, instanceId, listener) ?? (() => {}),
    () => surface?.result(component, instanceId) ?? null,
    () => null,
  );
}

const decodeSlashCommands = Schema.decodeUnknownOption(Schema.Array(ModCommand));
const NO_SLASH_COMMANDS: ReadonlyArray<ModCommand> = [];

/** The slash commands the thread's mods registered. Empty while none run. */
export function useModSlashCommands(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): ReadonlyArray<ModCommand> {
  const ui = useMod(environmentId, threadId);
  const surface = ui?.surface ?? null;
  const session = ui?.snapshot.session ?? null;
  const revision = ui?.snapshot.slashCommandsRevision ?? 0;
  const [fetched, setFetched] = useState<{
    readonly session: string;
    readonly commands: ReadonlyArray<ModCommand>;
  } | null>(null);

  useEffect(() => {
    if (surface === null || session === null || revision === 0) return;
    let isCurrent = true;
    void surface.operate({ op: "slashCommands" }).then((response) => {
      const commands = decodeSlashCommands(response);
      if (isCurrent && commands._tag === "Some") setFetched({ session, commands: commands.value });
    });
    return () => {
      isCurrent = false;
    };
  }, [surface, session, revision]);

  return fetched !== null && fetched.session === session ? fetched.commands : NO_SLASH_COMMANDS;
}

/**
 * The mods' commands asked of their engine right now, for a message sent
 * before this window's own list arrived: a thread's mods take a moment to
 * start. Asks a few times while there is no session to answer, then gives up
 * with none, so the message goes to the provider.
 */
export async function awaitModCommands(
  surface: ModSurface,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 300)),
): Promise<ReadonlyArray<ModCommand>> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const commands = decodeSlashCommands(await surface.operate({ op: "slashCommands" }));
    if (commands._tag === "Some") return commands.value;
    await pause();
  }
  return [];
}

/**
 * Runs a mod's slash command. `"ran"` when the mod took it (its text reply is
 * toasted), `"missing"` when no mod has the command any more, so the text is
 * the provider's to read, and `"failed"` when the mod did not answer: the text
 * stays in the composer, since sending a mod's command to the agent is never
 * what the person meant.
 */
export async function runModCommand(
  surface: ModSurface,
  command: ModCommand,
  args: string,
): Promise<"ran" | "missing" | "failed"> {
  const answer = await surface.operate({ op: "command", name: command.name, args });
  if (typeof answer !== "object" || answer === null || !("handled" in answer)) {
    showModToast({ plugin: command.plugin, text: `/${command.name} did not answer.` });
    return "failed";
  }
  if (answer.handled !== true) return "missing";
  if ("text" in answer && typeof answer.text === "string" && answer.text !== "") {
    showModToast({ plugin: command.plugin, text: answer.text });
  }
  return "ran";
}
