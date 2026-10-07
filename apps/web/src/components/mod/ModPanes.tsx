import type { EnvironmentId, ModPane, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";

import { cn } from "~/lib/utils";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { ModSite } from "./ModSite";
import type { ModSurface } from "./modSurface";
import { useMod } from "./useMod";

/**
 * Keeps the right panel's Mods tab in step with the panes mods have open for
 * the thread: there while one is open, gone with the last. Pass a null thread
 * to stay idle.
 */
/**
 * Whether a command just asked for a pane, going by the reveal count of two
 * snapshots in a row. The first snapshot seen of a thread, or of a new engine
 * session, only says what happened before: coming back to a thread must not
 * reopen a panel the person put away.
 */
export function isModPaneRevealed(
  previous: { readonly session: string | null; readonly reveal: number } | null,
  current: { readonly session: string | null; readonly reveal: number },
): boolean {
  return (
    previous !== null &&
    previous.session !== null &&
    previous.session === current.session &&
    current.reveal > previous.reveal
  );
}

export function useModPanesTab(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  threadRef: ScopedThreadRef | null,
) {
  const mod = useMod(environmentId, threadId);
  const snapshot = mod?.snapshot;
  const roster = snapshot?.panes;
  const session = snapshot?.session ?? null;
  const isKnown = mod?.isLoaded === true;
  const hasPanes = (roster?.panes.length ?? 0) > 0;
  const reveal = roster?.reveal ?? 0;
  useEffect(() => {
    // Until the thread's first snapshot arrives nothing is known: taking that for
    // "no panes" would forget that the person had put the panel away.
    if (threadRef === null || !isKnown) return;
    const store = useRightPanelStore.getState();
    if (hasPanes) store.showModPanes(threadRef);
    else store.hideModPanes(threadRef);
  }, [hasPanes, isKnown, threadRef]);
  // A command asked for a pane: it comes forward even if the panel was put away.
  const seen = useRef<{ session: string | null; reveal: number } | null>(null);
  useEffect(() => {
    // Nothing is known of the thread's mods until its first snapshot arrives.
    if (threadRef === null || !isKnown) return;
    const previous = seen.current;
    seen.current = { session, reveal };
    if (hasPanes && isModPaneRevealed(previous, seen.current)) {
      useRightPanelStore.getState().revealModPanes(threadRef);
    }
  }, [hasPanes, isKnown, reveal, session, threadRef]);
}

/** One pane's body. It stays mounted while hidden, so what its mod drew keeps its state. */
function PaneBody(props: {
  readonly surface: ModSurface;
  readonly pane: ModPane;
  readonly isShown: boolean;
  readonly isFocused: boolean;
  readonly cwd: string | undefined;
  readonly onReturnFocus: () => void;
}) {
  const { surface, pane, isShown, isFocused } = props;
  const siteProps = useMemo(
    () => ({ title: pane.title, isFocused, placement: "dock" }),
    [pane.title, isFocused],
  );
  return (
    <div
      role="tabpanel"
      aria-hidden={!isShown}
      className={cn("absolute inset-0 p-2", !isShown && "invisible")}
    >
      <ModSite
        surface={surface}
        component="Pane"
        instanceId={pane.id}
        plugin={pane.plugin}
        cwd={props.cwd}
        siteProps={siteProps}
        focusToken={isShown && isFocused ? pane.id : null}
        onHeldChange={(isHeld) =>
          void surface.operate({ op: "paneFocus", id: isHeld ? pane.id : null })
        }
        onEscape={() => {
          if (pane.closeOnEscape === true) void surface.operate({ op: "close", id: pane.id });
          props.onReturnFocus();
        }}
      />
    </div>
  );
}

/**
 * The panes mods opened with `$.ui.open`: one shown, the rest tabs. The mod
 * draws each pane's body; the person shows, focuses and closes them, and a mod
 * may refuse a close.
 */
export function ModPanes(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | undefined;
  /** Whose composer draft decides whether a pane may take the keyboard. */
  readonly draftTarget: ScopedThreadRef | DraftId;
  /** Hands the keyboard back to the composer. */
  readonly onReturnFocus: () => void;
}) {
  const ui = useMod(props.environmentId, props.threadId);
  const surface = ui?.surface ?? null;
  const roster = ui?.snapshot.panes;
  const shown =
    roster?.panes.find((pane) => pane.id === roster.shownId) ?? roster?.panes[0] ?? null;
  // The command that opened the pane may still be in the composer: that is not a draft.
  const isComposerFree = useComposerDraftStore((store) => {
    const draft = (store.getComposerDraft(props.draftTarget)?.prompt ?? "").trim();
    return draft === "" || draft.startsWith("/");
  });
  // A mod may ask for the keyboard (a game, a field to type in), but never
  // takes it from someone writing a message: such a request is refused. A
  // running turn does not refuse it; playing while the agent works is the
  // point. Judged once per request, so later typing does not refuse one
  // already honoured.
  const focusRequestedId = roster?.focusRequestedId ?? null;
  const judgeFocusRequest = useEffectEvent((id: string) => {
    if (surface === null) return;
    const hasModal =
      document.querySelector(
        '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
      ) !== null;
    if (!isComposerFree || hasModal) {
      void surface.operate({ op: "paneFocus", id: null });
      return;
    }
    void surface
      .operate({ op: "paneShow", id })
      .then(() => surface.operate({ op: "paneFocus", id }));
  });
  useEffect(() => {
    if (focusRequestedId === null) return;
    // Only the window the person is in judges: another one, idle in the
    // background, must neither take the keyboard nor refuse on their behalf.
    if (document.hasFocus()) {
      judgeFocusRequest(focusRequestedId);
      return;
    }
    const onFocus = () => judgeFocusRequest(focusRequestedId);
    window.addEventListener("focus", onFocus, { once: true });
    return () => window.removeEventListener("focus", onFocus);
  }, [focusRequestedId]);

  if (surface === null || roster === undefined || shown === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-muted-foreground text-sm">
        No mod pane is open.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-border/60 border-b px-2 py-1">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {roster.panes.map((pane) => (
            <button
              key={pane.id}
              type="button"
              role="tab"
              aria-selected={pane.id === shown.id}
              className={cn(
                "max-w-48 shrink-0 truncate rounded-sm px-2 py-0.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
                pane.id === shown.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => void surface.operate({ op: "paneShow", id: pane.id })}
            >
              {pane.title}
            </button>
          ))}
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Close ${shown.title}`}
          onClick={() => void surface.operate({ op: "close", id: shown.id })}
        >
          <XIcon />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {roster.panes.map((pane) => (
          <PaneBody
            key={pane.id}
            surface={surface}
            pane={pane}
            isShown={pane.id === shown.id}
            isFocused={roster.focusedId === pane.id}
            cwd={props.cwd}
            onReturnFocus={props.onReturnFocus}
          />
        ))}
      </div>
    </div>
  );
}
