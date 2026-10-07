import {
  type ModAsk,
  type ModComponent,
  type ModLogLine,
  type ModOperation,
  ModRenderResult,
  type ModRequestResult,
  type ModSiteCommand,
  type ModSnapshot,
  type ModToast,
  type ModViewport,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * One window's side of a thread's mods. It attaches with the window's
 * viewport, asks the mods to draw each mounted instance (the band above the
 * composer, each pane), asks again when a drawing goes stale, and forwards
 * what the person does to the mods.
 */

/** What the mods need to draw one instance; read fresh on every ask. */
export interface ModInstanceAsk {
  readonly props: Readonly<Record<string, unknown>>;
  readonly viewport?: ModViewport;
  /** Rows the whole tree laid out to when last drawn; undefined before the first layout. */
  readonly contentRows?: number | undefined;
  readonly keyed?:
    | undefined
    | ReadonlyArray<{
        readonly plugin: string;
        readonly key: string;
        readonly top: number;
        readonly bottom: number;
      }>;
}

export interface ModSurfaceOptions {
  readonly clientId: string;
  /** Sends one operation for `session`; `undefined` when the request itself failed. */
  readonly send: (
    session: string,
    operation: ModOperation,
  ) => Promise<ModRequestResult | undefined>;
  /** Shows a toast or a log line a mod raised, each once and in order. */
  readonly onNotice: (notice: ModToast | ModLogLine) => void;
  /** Settles a request a mod made of this window; `undefined` leaves it unanswered. */
  readonly onAsk: (ask: ModAsk) => Promise<Record<string, unknown> | undefined>;
  /** Runs `retry` after `delayMs`; the window's timer unless a test supplies one. */
  readonly schedule?: (retry: () => void, delayMs: number) => void;
}

interface Instance {
  readonly key: string;
  readonly component: ModComponent;
  readonly instanceId: string;
  /** The newest mount's ask; one instance may be mounted twice. */
  ask: () => ModInstanceAsk;
  mounts: number;
  result: ModRenderResult | null;
  inFlight: boolean;
  /** Why to ask once more when the ask in flight answers. */
  again: "props" | "stale" | null;
  /** No mod drew it when last asked: it is not asked again until it goes stale. */
  unhooked: boolean;
}

const decodeRenderResult = Schema.decodeUnknownOption(ModRenderResult);

/** A failed attach is retried this many times, a little later each time. */
const ATTACH_RETRY_DELAYS_MS = [500, 2000, 8000];
/** Drawings remembered for instances that unmount and come back, like a pane behind another tab. */
const MAX_REMEMBERED_RESULTS = 128;

const instanceKey = (component: string, instanceId: string) => `${component}\u0000${instanceId}`;

const sameViewport = (left: ModViewport | undefined, right: ModViewport | undefined) =>
  left?.columns === right?.columns &&
  left?.rows === right?.rows &&
  left?.isFullscreen === right?.isFullscreen;

export type ModSurface = ReturnType<typeof createModSurface>;

export function createModSurface(options: ModSurfaceOptions) {
  const instances = new Map<string, Instance>();
  // Kept apart from `instances`: a component may subscribe before it mounts.
  const listeners = new Map<string, Set<() => void>>();
  const commandListeners = new Set<(command: ModSiteCommand) => void>();
  // Hover groups a pointer is over, by mod and `scope`; lit across every site.
  const litGroups = new Map<string, number>();
  const groupListeners = new Set<() => void>();
  const handledAsks = new Set<string>();
  let session: string | null = null;
  let attachedSession: string | null = null;
  let attachedViewport: ModViewport | undefined;
  let attaching = false;
  let attachGeneration = 0;
  let attachFailures = 0;
  let viewport: ModViewport | undefined;
  // The last drawing of each instance this session, so one that unmounts and
  // mounts again shows it at once instead of nothing until the mods answer.
  const remembered = new Map<string, ModRenderResult>();
  const schedule =
    options.schedule ?? ((retry: () => void, delayMs: number) => void setTimeout(retry, delayMs));
  let lastSnapshot: ModSnapshot | null = null;
  let renderEpoch = 0;
  // The newest `seq` already handled; snapshots resend their bounded event lists whole.
  let handledSeq = 0;
  const heldNotices: Array<ModToast | ModLogLine> = [];

  /**
   * A sender bound to the session that is live now: `undefined` unless the
   * mods answered, and once the session is replaced it sends nothing, so work
   * queued behind an earlier request never reaches a session it was not drawn
   * for.
   */
  const bind = () => {
    const bound = session;
    return async (operation: ModOperation): Promise<unknown | undefined> => {
      if (bound === null || session !== bound) return undefined;
      const result = await options.send(bound, operation);
      return result?.status === "ok" ? result.response : undefined;
    };
  };

  /** Sends an operation on the current session; `undefined` unless the mods answered. */
  const operate = (operation: ModOperation) => bind()(operation);

  const notify = (instance: Instance) => {
    for (const listener of listeners.get(instance.key) ?? []) listener();
  };

  const remember = (key: string, result: ModRenderResult) => {
    remembered.delete(key);
    remembered.set(key, result);
    if (remembered.size > MAX_REMEMBERED_RESULTS) {
      for (const oldest of remembered.keys()) {
        remembered.delete(oldest);
        break;
      }
    }
  };

  /**
   * Asks the mods to draw one instance; asks arriving meanwhile fold into one
   * more. `because` says why: the instance's own `props` changed, or the mods
   * marked it `stale`, which also means one may have started drawing an
   * instance that last read unhooked.
   */
  const render = (instance: Instance, because: "props" | "stale" = "props") => {
    if (because === "stale") instance.unhooked = false;
    if (session === null || attachedSession !== session || instance.unhooked) return;
    if (instance.inFlight) {
      if (instance.again !== "stale") instance.again = because;
      return;
    }
    instance.inFlight = true;
    const asked = session;
    const ask = instance.ask();
    void operate({
      op: "render",
      component: instance.component,
      instanceId: instance.instanceId,
      props: ask.props,
      ...(ask.viewport === undefined ? {} : { viewport: ask.viewport }),
      ...(ask.contentRows === undefined ? {} : { contentRows: ask.contentRows }),
      ...(ask.keyed === undefined ? {} : { keyed: ask.keyed }),
    }).then((response) => {
      // The session was replaced while the mods drew.
      if (session !== asked) return;
      instance.inFlight = false;
      const again = instance.again;
      instance.again = null;
      const decoded = response === undefined ? undefined : decodeRenderResult(response);
      const result = decoded?._tag === "Some" ? decoded.value : undefined;
      if (result?.hooked === true) remember(instance.key, result);
      if (instances.get(instance.key) !== instance) return;
      // An answer that went stale while it was asked for says nothing about who draws now.
      if (result?.hooked === false && again !== "stale") {
        instance.unhooked = true;
        remembered.delete(instance.key);
        if (instance.result !== null) {
          instance.result = null;
          notify(instance);
        }
        return;
      }
      if (result?.hooked === true) {
        instance.result = result;
        notify(instance);
      }
      // A failed ask taught nothing: it is asked again only if something changed since.
      if (again !== null) render(instance, again);
    });
  };

  const renderAll = (because: "props" | "stale" = "props") => {
    for (const instance of instances.values()) render(instance, because);
  };

  /** Joins the session's roster, or reports a new viewport on it. */
  const attach = () => {
    if (session === null || attaching) return;
    if (attachedSession === session && sameViewport(attachedViewport, viewport)) return;
    attaching = true;
    const generation = ++attachGeneration;
    const asked = session;
    const reported = viewport;
    const first = attachedSession !== session;
    void operate({
      op: "attach",
      ...(reported === undefined ? {} : { viewport: reported }),
      // An absent list keeps the one a repeated attach gave before.
    }).then((response) => {
      // A reset started another attach since: this answer is not its to settle.
      if (generation !== attachGeneration) return;
      attaching = false;
      if (session !== asked) return;
      if (response === undefined) {
        // Refused or lost: try again a few times, later each time, then wait
        // for a new session, viewport or reconnect to ask again.
        const delay = ATTACH_RETRY_DELAYS_MS[attachFailures];
        attachFailures += 1;
        if (delay !== undefined) {
          schedule(() => {
            if (session === asked) attach();
          }, delay);
        }
        return;
      }
      attachFailures = 0;
      attachedSession = asked;
      attachedViewport = reported;
      if (first) renderAll();
      // The viewport moved while the attach was in flight.
      attach();
    });
  };

  const reset = (next: string | null) => {
    session = next;
    attachedSession = null;
    attachedViewport = undefined;
    attaching = false;
    attachGeneration += 1;
    attachFailures = 0;
    remembered.clear();
    renderEpoch = 0;
    handledSeq = 0;
    heldNotices.length = 0;
    handledAsks.clear();
    for (const instance of instances.values()) {
      instance.inFlight = false;
      instance.again = null;
      instance.unhooked = false;
      if (instance.result !== null) {
        instance.result = null;
        notify(instance);
      }
    }
  };

  return {
    operate,
    bind,

    /** Feeds the server's latest snapshot; the same snapshot twice is a no-op. */
    applySnapshot(snapshot: ModSnapshot) {
      if (snapshot === lastSnapshot) return;
      const isFirst = lastSnapshot === null;
      lastSnapshot = snapshot;
      const notices = [...snapshot.toasts, ...snapshot.logs];
      const newestSeq = Math.max(
        0,
        ...[...notices, ...snapshot.stale, ...snapshot.commands].map((entry) => entry.seq),
      );
      const isNewSession = snapshot.session !== session;
      if (isNewSession) {
        reset(snapshot.session);
        renderEpoch = snapshot.renderEpoch;
        // What a session did before this window opened is history, not news.
        if (isFirst) handledSeq = newestSeq;
        attach();
      }
      if (session === null) return;
      const previousSeq = handledSeq;
      handledSeq = Math.max(previousSeq, newestSeq);
      const isNew = (entry: { readonly seq: number }) => entry.seq > previousSeq;
      const holdToasts = snapshot.panes.panes.some(
        (pane) => pane.id === snapshot.panes.shownId && pane.holdToasts === true,
      );
      heldNotices.push(...notices.filter(isNew).sort((left, right) => left.seq - right.seq));
      if (!holdToasts) {
        for (const notice of heldNotices.splice(0)) options.onNotice(notice);
      }
      for (const ask of snapshot.asks) {
        if (ask.clientId !== options.clientId || handledAsks.has(ask.askId)) continue;
        handledAsks.add(ask.askId);
        void options.onAsk(ask).then((result) => {
          if (result !== undefined) void operate({ op: "answer", askId: ask.askId, result });
        });
      }
      // Nothing is drawn yet on a new session: the attach asks for everything.
      if (isNewSession) return;
      // The server dropped this client (its subscription restarted): join again.
      if (
        attachedSession === session &&
        !attaching &&
        !snapshot.clients.includes(options.clientId)
      ) {
        attachedSession = null;
        attachedViewport = undefined;
        attachFailures = 0;
        attach();
      }
      for (const command of snapshot.commands) {
        if (isNew(command) && command.clientId === options.clientId) {
          for (const listener of commandListeners) listener(command);
        }
      }
      if (snapshot.renderEpoch !== renderEpoch) {
        renderEpoch = snapshot.renderEpoch;
        renderAll("stale");
        return;
      }
      for (const stale of snapshot.stale) {
        if (!isNew(stale)) continue;
        const instance = instances.get(instanceKey(stale.component, stale.instanceId));
        if (instance !== undefined) render(instance, "stale");
      }
    },

    /** Reports the window's size in cells; attaches once the first one is known. */
    setViewport(next: ModViewport) {
      if (sameViewport(viewport, next)) return;
      viewport = next;
      attachFailures = 0;
      attach();
    },

    /**
     * Starts drawing one component instance. `ask` is read on every ask, so it
     * may close over refs. Returns the unmount.
     */
    mount(component: ModComponent, instanceId: string, ask: () => ModInstanceAsk): () => void {
      const key = instanceKey(component, instanceId);
      const existing = instances.get(key);
      // A second drawing of the same instance shares the first one's result.
      const instance: Instance = existing ?? {
        key,
        component,
        instanceId,
        ask,
        mounts: 0,
        result: remembered.get(key) ?? null,
        inFlight: false,
        again: null,
        unhooked: false,
      };
      instance.ask = ask;
      instance.mounts += 1;
      if (existing === undefined) {
        instances.set(key, instance);
        render(instance);
      }
      return () => {
        instance.mounts -= 1;
        if (instance.mounts === 0 && instances.get(key) === instance) instances.delete(key);
      };
    },

    /** Asks again for an instance whose props, size or layout changed. */
    refresh(component: ModComponent, instanceId: string) {
      const instance = instances.get(instanceKey(component, instanceId));
      if (instance !== undefined) render(instance);
    },

    /** The instance's latest drawing: null until a mod draws it. */
    result(component: ModComponent, instanceId: string) {
      return instances.get(instanceKey(component, instanceId))?.result ?? null;
    },

    /** Calls `listener` when the instance's drawing changes. */
    subscribe(component: ModComponent, instanceId: string, listener: () => void) {
      const key = instanceKey(component, instanceId);
      let own = listeners.get(key);
      if (own === undefined) {
        own = new Set();
        listeners.set(key, own);
      }
      own.add(listener);
      return () => {
        own.delete(listener);
        if (own.size === 0 && listeners.get(key) === own) listeners.delete(key);
      };
    },

    /** A hover group's pointer entered (`true`) or left one of its members. */
    hoverGroup(group: string, isOver: boolean) {
      const count = (litGroups.get(group) ?? 0) + (isOver ? 1 : -1);
      if (count > 0) litGroups.set(group, count);
      else litGroups.delete(group);
      for (const listener of groupListeners) listener();
    },

    isGroupLit(group: string) {
      return litGroups.has(group);
    },

    onGroupChange(listener: () => void) {
      groupListeners.add(listener);
      return () => {
        groupListeners.delete(listener);
      };
    },

    /** Calls `listener` for each scroll or focus a mod asked of this window. */
    onCommand(listener: (command: ModSiteCommand) => void) {
      commandListeners.add(listener);
      return () => {
        commandListeners.delete(listener);
      };
    },
  };
}
