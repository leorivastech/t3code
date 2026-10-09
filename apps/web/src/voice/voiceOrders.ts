import type { KeybindingShortcut } from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";

/** The key press that reaches the same handlers a person's shortcut does. */
export function keyboardEventInitForShortcut(
  shortcut: KeybindingShortcut,
  platform: string,
): KeyboardEventInit {
  const useMetaForMod = isMacPlatform(platform);
  return {
    key: shortcut.key,
    metaKey: shortcut.metaKey || (shortcut.modKey && useMetaForMod),
    ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod),
    shiftKey: shortcut.shiftKey,
    altKey: shortcut.altKey,
    bubbles: true,
    cancelable: true,
  };
}

// Effort levels as providers label them in the composer's effort menu.
const EFFORT_LABELS: Readonly<Record<string, ReadonlyArray<string>>> = {
  minimal: ["minimal", "none", "off"],
  low: ["low"],
  medium: ["medium"],
  high: ["high"],
  xhigh: ["extra high", "xhigh", "x-high", "very high"],
  max: ["max", "maximum"],
};

/**
 * The index of the menu entry a spoken effort level means, or -1. An entry's
 * text is its label, then a default marker and a description when it has them.
 */
export function findEffortOptionIndex(labels: ReadonlyArray<string>, level: string): number {
  const wanted = EFFORT_LABELS[level];
  if (wanted === undefined) return -1;
  const normalized = labels.map((label) => label.toLowerCase().replace(/\s+/g, " ").trim());
  for (const candidate of wanted) {
    const index = normalized.findIndex(
      (label) => label === candidate || label.startsWith(`${candidate} `),
    );
    if (index >= 0) return index;
  }
  return -1;
}

/** The picture a desktop screen capture carries, as a file the composer can take. */
export function screenCaptureFile(path: string | null, pngBase64: string): File {
  const binary = atob(pngBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const name = path?.split(/[\\/]/).at(-1) ?? "Screenshot.png";
  return new File([bytes], name, { type: "image/png" });
}

/**
 * What a key is called on the keyboard, from its `KeyboardEvent.code`:
 * "ControlRight" is "Right Ctrl", "KeyK" is "K", "F8" stays "F8".
 */
export function holdKeyLabel(code: string): string {
  const side = /^(.+)(Left|Right)$/.exec(code);
  if (side !== null) return `${side[2]} ${side[1] === "Control" ? "Ctrl" : side[1]}`;
  return code.replace(/^(Key|Digit)/, "");
}

// A screen of reading keeps a few lines of the previous one in view.
const SCROLL_PAGE_OVERLAP = 0.15;

/**
 * How far one spoken screen moves the timeline: what is actually readable, which
 * is the scroll area less whatever the composer covers at its bottom.
 */
export function voiceScrollPagePx(scrollAreaHeightPx: number, coveredBottomPx: number): number {
  const readable = Math.max(0, scrollAreaHeightPx - Math.max(0, coveredBottomPx));
  return Math.round(readable * (1 - SCROLL_PAGE_OVERLAP));
}
