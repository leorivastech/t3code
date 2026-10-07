// @vitest-environment jsdom

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  prompt: "",
  focusRequestedId: "list" as string | null,
  operate: vi.fn(async (_operation: unknown) => ({})),
}));

vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({ getComposerDraft: () => ({ prompt: state.prompt }) }),
}));
vi.mock("./useMod", () => ({
  useMod: () => ({
    surface: { operate: state.operate },
    snapshot: {
      panes: {
        panes: [
          { id: "lab", title: "Lab", plugin: "lab" },
          { id: "list", title: "Long list", plugin: "lab" },
        ],
        shownId: "lab",
        focusedId: null,
        focusRequestedId: state.focusRequestedId,
      },
    },
  }),
}));
vi.mock("./ModSite", () => ({ ModSite: () => <div /> }));
vi.mock("../ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

import { isModPaneRevealed, ModPanes } from "./ModPanes";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread");
const draftTarget = { environmentId, threadId };
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let focused = true;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.operate.mockClear();
  state.prompt = "";
  state.focusRequestedId = "list";
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function show() {
  await act(async () => {
    root.render(
      <ModPanes
        environmentId={environmentId}
        threadId={threadId}
        draftTarget={draftTarget}
        cwd={undefined}
        onReturnFocus={() => {}}
      />,
    );
  });
}

describe("isModPaneRevealed", () => {
  it("brings the panes forward only when a command opened one while the thread was shown", () => {
    const before = { session: "s1", reveal: 2 };
    expect(isModPaneRevealed(before, { session: "s1", reveal: 3 })).toBe(true);
    expect(isModPaneRevealed(before, { session: "s1", reveal: 2 })).toBe(false);
  });

  it("does not reopen a panel on coming back to a thread or on a new engine session", () => {
    // Back from another thread: the first snapshot seen is history.
    expect(isModPaneRevealed(null, { session: "s1", reveal: 3 })).toBe(false);
    expect(isModPaneRevealed({ session: "other", reveal: 0 }, { session: "s1", reveal: 3 })).toBe(
      false,
    );
    expect(isModPaneRevealed({ session: null, reveal: 0 }, { session: "s1", reveal: 1 })).toBe(
      false,
    );
  });
});

describe("mod pane keyboard requests", () => {
  it("shows the requested pane before granting it the keyboard", async () => {
    await show();
    expect(state.operate.mock.calls.map(([op]) => op)).toEqual([
      { op: "paneShow", id: "list" },
      { op: "paneFocus", id: "list" },
    ]);
  });

  it("grants it over the slash command that opened the pane, still in the composer", async () => {
    state.prompt = "/fight ";
    await show();
    expect(state.operate.mock.calls.map(([op]) => op)).toEqual([
      { op: "paneShow", id: "list" },
      { op: "paneFocus", id: "list" },
    ]);
  });

  it.each(["draft", "dialog", "alertdialog"])(
    "refuses a request while a %s occupies the composer or keyboard",
    async (kind) => {
      if (kind === "draft") state.prompt = "keep my draft";
      if (kind === "dialog" || kind === "alertdialog") {
        const modal = document.createElement("div");
        modal.setAttribute("role", kind);
        modal.setAttribute("aria-modal", "true");
        document.body.append(modal);
      }
      await show();
      expect(state.operate.mock.calls.map(([op]) => op)).toEqual([{ op: "paneFocus", id: null }]);
      if (kind === "draft") expect(state.prompt).toBe("keep my draft");
    },
  );

  it("a background window leaves the request to the active window", async () => {
    focused = false;
    await show();
    expect(state.operate).not.toHaveBeenCalled();
    state.prompt = "typed before focusing";
    await show();
    focused = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(state.operate.mock.calls.map(([op]) => op)).toEqual([{ op: "paneFocus", id: null }]);
  });

  it("drops a deferred request when the pane request is withdrawn", async () => {
    focused = false;
    await show();
    state.focusRequestedId = null;
    await show();
    focused = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(state.operate).not.toHaveBeenCalled();
  });
});
