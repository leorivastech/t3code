import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  KeybindingCommand,
  ResolvedKeybindingsConfig,
  VoiceAction,
  VoiceOrder,
  VoiceScrollTarget,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import { toastManager } from "../components/ui/toast";
import { useComposerHandleContext } from "../composerHandleContext";
import { useClientSettings, useEnvironmentSettings } from "../hooks/useSettings";
import { effectiveShortcutsForCommand } from "../keybindings";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { formatEnvironmentQueryError } from "../state/query";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useHoldToTalk } from "./useHoldToTalk";
import { createVoiceQueue } from "./voiceQueue";
import {
  findEffortOptionIndex,
  keyboardEventInitForShortcut,
  screenCaptureFile,
  voiceScrollPagePx,
} from "./voiceOrders";

const NAVIGATION_TIMEOUT_MS = 1_500;
const ATTACHMENT_TIMEOUT_MS = 10_000;
const SCROLL_GLIDE_MS = 220;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

interface VoiceRunner {
  readonly keybindings: () => ResolvedKeybindingsConfig;
  readonly composer: () => ChatComposerHandle | null;
}

/**
 * Run a command the way its shortcut does, so voice reaches the handlers that
 * already own each command (and the thread numbers a person sees) instead of
 * a second copy of their logic.
 */
function runCommand(runner: VoiceRunner, commands: ReadonlyArray<KeybindingCommand>): void {
  for (const command of commands) {
    const shortcut = effectiveShortcutsForCommand(runner.keybindings(), command)[0];
    if (shortcut === undefined) continue;
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", keyboardEventInitForShortcut(shortcut, navigator.platform)),
    );
    return;
  }
  throw new Error(`No shortcut is bound to ${commands[0]}. Add one in Settings → Keybindings.`);
}

const composerForm = () => document.querySelector<HTMLElement>("[data-chat-composer-form]");

/**
 * Waits for the thread a navigation leads to. A jump to the open thread changes nothing;
 * otherwise the thread left stays on screen, composer and all, until the one arrived at
 * renders, and what an order does next must land on the new one. `from` is a whole
 * `location.href`: the desktop app keeps its route in the hash.
 */
async function waitForNavigation(
  from: string,
  composerLeft: HTMLElement | null,
  requireChange = false,
): Promise<void> {
  const deadline = performance.now() + NAVIGATION_TIMEOUT_MS;
  while (window.location.href === from && performance.now() < deadline) await sleep(25);
  if (window.location.href !== from) {
    while (composerForm() === composerLeft && performance.now() < deadline) await sleep(25);
  }
  if (
    (requireChange && window.location.href === from) ||
    (window.location.href !== from && composerForm() === composerLeft)
  ) {
    throw new Error("The new thread is still loading; the remaining voice actions were cancelled.");
  }
  await nextFrame();
  await nextFrame();
}

async function waitForComposer(runner: VoiceRunner): Promise<ChatComposerHandle> {
  const deadline = performance.now() + NAVIGATION_TIMEOUT_MS;
  for (;;) {
    const composer = runner.composer();
    if (composer !== null) return composer;
    if (performance.now() >= deadline) throw new Error("Open a thread first.");
    await sleep(25);
  }
}

async function selectEffort(composer: ChatComposerHandle, level: string): Promise<void> {
  composer.openControl("composer.effort");
  await nextFrame();
  await nextFrame();
  const options = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]'),
  );
  const index = findEffortOptionIndex(
    options.map((option) => option.textContent ?? ""),
    level,
  );
  const option = options[index];
  if (option === undefined) {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    throw new Error(`This model has no "${level}" effort.`);
  }
  option.click();
}

const SCROLL_KEYS: Readonly<Record<VoiceScrollTarget, string>> = {
  up: "PageUp",
  down: "PageDown",
  top: "Home",
  bottom: "End",
};

const firstTimelineRowId = () =>
  document.querySelector<HTMLElement>("[data-timeline-row-id]")?.dataset.timelineRowId ?? null;

/** After a jump the previous thread's rows stay on screen until the new thread's arrive. */
async function waitForTimelineOfNewThread(previousRowId: string | null): Promise<void> {
  const deadline = performance.now() + NAVIGATION_TIMEOUT_MS;
  for (;;) {
    const rowId = firstTimelineRowId();
    if ((rowId !== null && rowId !== previousRowId) || performance.now() >= deadline) return;
    await sleep(25);
  }
}

/**
 * Glide by steps relative to where the list is each frame: a virtualized list
 * corrects its own offset as rows are measured, which cuts a native smooth scroll short.
 */
async function glideBy(area: HTMLElement, distance: number): Promise<void> {
  const start = performance.now();
  let travelled = 0;
  for (;;) {
    await nextFrame();
    const progress = Math.min(1, (performance.now() - start) / SCROLL_GLIDE_MS);
    const target = distance * (1 - (1 - progress) ** 3);
    area.scrollTop += target - travelled;
    travelled = target;
    if (progress >= 1) return;
  }
}

function timelineScrollArea(): HTMLElement | null {
  let node = document.querySelector<HTMLElement>("[data-timeline-root]")?.parentElement ?? null;
  while (node !== null) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Move what the open thread shows. The key press tells the timeline a person is
 * navigating, so it stops following new output; a made-up key scrolls nothing by
 * itself, so the movement is done here.
 */
async function scrollTimeline(to: VoiceScrollTarget, pages: number): Promise<void> {
  const area = timelineScrollArea();
  if (area === null) throw new Error("There is nothing to scroll here.");
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: SCROLL_KEYS[to], bubbles: true, cancelable: true }),
  );
  if (to === "bottom") {
    // The pill is the timeline's own way back to the live end; without it, it is already there.
    document.querySelector<HTMLElement>(".chat-scroll-to-bottom button")?.click();
    return;
  }
  if (to === "top") {
    area.scrollTo({ top: 0 });
    // Rows measured on the way up can push the start further away.
    for (let attempt = 0; attempt < 10 && area.scrollTop > 1; attempt += 1) {
      await nextFrame();
      area.scrollTo({ top: 0 });
    }
    return;
  }
  const areaRect = area.getBoundingClientRect();
  const composerTop = document
    .querySelector<HTMLElement>("[data-chat-composer-form]")
    ?.getBoundingClientRect().top;
  const covered = composerTop === undefined ? 0 : areaRect.bottom - composerTop;
  const distance = voiceScrollPagePx(areaRect.height, covered) * pages;
  await glideBy(area, to === "up" ? -distance : distance);
}

/** The last picture of the screen an order took, for a later "paste it". */
let lastScreenCapture: File | null = null;

/** Copies and saves a picture of the screen, and says where it went. */
async function captureScreen(): Promise<void> {
  const capture = window.desktopBridge?.captureScreen;
  if (capture === undefined) throw new Error("Screenshots need the desktop app.");
  const picture = await capture();
  if (picture === null) throw new Error("The screen could not be captured.");
  lastScreenCapture = screenCaptureFile(picture.path, picture.pngBase64);
  toastManager.add({
    type: "info",
    title: "Screenshot copied",
    ...(picture.path === null ? {} : { description: `Saved to ${picture.path}` }),
  });
}

async function attachScreenCapture(composer: ChatComposerHandle): Promise<void> {
  if (lastScreenCapture === null) throw new Error("Take a screenshot first.");
  composer.addDroppedFiles([lastScreenCapture]);
  // A later "send" in the same order must not leave before the picture is in the draft.
  const deadline = performance.now() + ATTACHMENT_TIMEOUT_MS;
  await nextFrame();
  while (composer.hasPendingAttachments() && performance.now() < deadline) await sleep(50);
  await nextFrame();
}

async function runVoiceActions(
  runner: VoiceRunner,
  actions: ReadonlyArray<VoiceAction>,
): Promise<void> {
  let cameFromJump = false;
  // The first row of the thread an order just left, while its timeline may still be on screen.
  let leftRowId: string | null | undefined;
  for (const action of actions) {
    const from = window.location.href;
    const composerLeft = composerForm();
    const rowId = firstTimelineRowId();
    switch (action.op) {
      case "jump":
        runCommand(runner, [`thread.jump.${action.n}` as KeybindingCommand]);
        await waitForNavigation(from, composerLeft);
        break;
      case "next":
        runCommand(runner, ["thread.next"]);
        await waitForNavigation(from, composerLeft);
        break;
      case "prev":
        runCommand(runner, ["thread.previous"]);
        await waitForNavigation(from, composerLeft);
        break;
      case "new":
        runCommand(runner, ["chat.newLocal", "chat.new"]);
        await waitForNavigation(from, composerLeft, true);
        break;
      case "stop":
        runCommand(runner, ["thread.stop"]);
        // "Stop the second one" only visited that thread to stop it.
        if (cameFromJump) {
          await nextFrame();
          runCommand(runner, ["navigation.back"]);
          await waitForNavigation(window.location.href, composerForm());
        }
        break;
      case "close":
        runCommand(runner, ["thread.settle"]);
        break;
      case "model": {
        const composer = await waitForComposer(runner);
        if (composer.selectModelByQuery(action.query) === null) {
          throw new Error(`No available model matches "${action.query}".`);
        }
        await nextFrame();
        break;
      }
      case "effort":
        await selectEffort(await waitForComposer(runner), action.level);
        await nextFrame();
        break;
      case "write": {
        const composer = await waitForComposer(runner);
        if (!composer.insertTextAtEnd(action.text, { ensureLeadingBoundary: true })) {
          throw new Error("The composer is busy; try again once it is ready.");
        }
        if (action.send) {
          await nextFrame();
          await nextFrame();
          runner.composer()?.submit();
        }
        break;
      }
      case "send":
        (await waitForComposer(runner)).submit();
        break;
      case "scroll":
        if (leftRowId !== undefined) await waitForTimelineOfNewThread(leftRowId);
        await scrollTimeline(action.to, action.pages);
        break;
      case "photo":
        await captureScreen();
        break;
      case "attach":
        await attachScreenCapture(await waitForComposer(runner));
        break;
    }
    cameFromJump = action.op === "jump";
    leftRowId = window.location.href === from ? undefined : rowId;
  }
}

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1] ?? ""));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });

/**
 * Spoken orders: hold the voice key, say it, let go. The recording goes to the
 * primary environment, which answers with what was asked, and this carries it
 * out. Listening requires local mode or a saved cloud key.
 */
export function VoiceCommands() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  return environmentId === null ? null : <VoiceOrders environmentId={environmentId} />;
}

function VoiceOrders({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const composerRef = useComposerHandleContext();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindingsRef = useRef(keybindings);
  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);
  const enabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.voice.localWhisper || settings.voice.apiKey !== "",
  );
  const holdKey = useClientSettings((settings) => settings.voiceHoldKey);
  const interpretVoice = useAtomCommand(serverEnvironment.interpretVoice, { reportFailure: false });

  const carryOut = async (order: VoiceOrder) => {
    const says = () =>
      toastManager.add(
        order.understood
          ? { type: "info", title: order.says, timeout: 2_500 }
          : {
              type: "warning",
              title: "Not understood",
              description: order.heard || "Nothing was heard.",
              timeout: 2_500,
            },
      );
    // What was understood shows first, except where it would end up in the picture.
    const picturesScreen = order.actions.some((action) => action.op === "photo");
    if (!picturesScreen) says();
    await runVoiceActions(
      { keybindings: () => keybindingsRef.current, composer: () => composerRef?.current ?? null },
      order.actions,
    );
    if (picturesScreen) says();
  };

  const interpretRecording = useEffectEvent(async (recording: Blob) => {
    let timer: number | undefined;
    try {
      const result = await Promise.race([
        interpretVoice({
          environmentId,
          input: { audioBase64: await blobToBase64(recording), mimeType: recording.type },
        }),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error("The voice order timed out.")), 25_000);
        }),
      ]);
      if (result._tag === "Success") return result.value;
      throw new Error(formatEnvironmentQueryError(result.cause));
    } finally {
      window.clearTimeout(timer);
    }
  });
  const runOrder = useEffectEvent(carryOut);
  const [queue] = useState(() =>
    createVoiceQueue({
      interpret: (recording) => interpretRecording(recording),
      run: (order) => runOrder(order),
      failed: (cause) =>
        toastManager.add({
          type: "error",
          title: cause instanceof Error ? cause.message : "The voice order failed.",
        }),
    }),
  );

  const listening = useHoldToTalk({
    holdKey,
    enabled,
    scopeKey: environmentId,
    onMicrophoneError: () =>
      toastManager.add({ type: "error", title: "The microphone could not be opened." }),
    onSpoken: (recording, hold, live, tail) => {
      void queue.submit(recording, hold, live, tail);
    },
  });

  return listening ? (
    <div
      role="status"
      className="pointer-events-none fixed bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-full border bg-popover px-3 py-1 text-xs text-popover-foreground shadow-lg"
    >
      Listening…
    </div>
  ) : null;
}
