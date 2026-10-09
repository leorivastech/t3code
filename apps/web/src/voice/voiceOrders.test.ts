import { describe, expect, it } from "vite-plus/test";

import {
  findEffortOptionIndex,
  holdKeyLabel,
  keyboardEventInitForShortcut,
  screenCaptureFile,
  voiceScrollPagePx,
} from "./voiceOrders";

describe("keyboardEventInitForShortcut", () => {
  const shortcut = {
    key: "3",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
  };

  it("turns mod into Control off the Mac and Command on it", () => {
    expect(keyboardEventInitForShortcut(shortcut, "Linux x86_64")).toMatchObject({
      key: "3",
      ctrlKey: true,
      metaKey: false,
    });
    expect(keyboardEventInitForShortcut(shortcut, "MacIntel")).toMatchObject({
      key: "3",
      ctrlKey: false,
      metaKey: true,
    });
  });
});

describe("findEffortOptionIndex", () => {
  it("tells High from Extra High and reads past the default marker and description", () => {
    const labels = ["Low", "Medium", "High Default Balanced for most work", "Extra High", "Max"];
    expect(findEffortOptionIndex(labels, "high")).toBe(2);
    expect(findEffortOptionIndex(labels, "xhigh")).toBe(3);
    expect(findEffortOptionIndex(labels, "max")).toBe(4);
    expect(findEffortOptionIndex(labels, "minimal")).toBe(-1);
  });
});

describe("screenCaptureFile", () => {
  it("rebuilds the picture under the name it was saved with", async () => {
    const file = screenCaptureFile(
      "/home/ada/Pictures/T3 Code/Screenshot 1.png",
      btoa("\u0089PNG"),
    );
    expect(file).toMatchObject({ name: "Screenshot 1.png", type: "image/png" });
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(screenCaptureFile(null, btoa("x")).name).toBe("Screenshot.png");
  });
});

describe("holdKeyLabel", () => {
  it("names a key the way a keyboard does", () => {
    expect(holdKeyLabel("ControlRight")).toBe("Right Ctrl");
    expect(holdKeyLabel("AltLeft")).toBe("Left Alt");
    expect(holdKeyLabel("KeyK")).toBe("K");
    expect(holdKeyLabel("F8")).toBe("F8");
  });
});

describe("voiceScrollPagePx", () => {
  it("moves by what can be read, less the part the composer covers", () => {
    expect(voiceScrollPagePx(1000, 200)).toBe(680);
    expect(voiceScrollPagePx(1000, -40)).toBe(850);
    expect(voiceScrollPagePx(100, 300)).toBe(0);
  });
});
