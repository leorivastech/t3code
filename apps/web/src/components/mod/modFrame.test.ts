import { describe, expect, it } from "vite-plus/test";

import { modFrameDocument, readModFrameMessage } from "./modFrame";

describe("modFrameDocument", () => {
  it("puts the bridge before the page's own scripts", () => {
    const page = modFrameDocument("<canvas></canvas><script>mod.send(1)</script>");

    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page.indexOf("window.mod")).toBeLessThan(page.indexOf("mod.send(1)"));
  });

  it("keeps a page's own doctype first, so it is not drawn in quirks mode", () => {
    const page = modFrameDocument("<!DOCTYPE html><html><body>hi</body></html>");

    expect(page.startsWith("<!DOCTYPE html><script>")).toBe(true);
    expect(page.endsWith("<html><body>hi</body></html>")).toBe(true);
  });
});

describe("readModFrameMessage", () => {
  it("reads only messages a frame's bridge sent", () => {
    expect(readModFrameMessage({ modFrame: true, data: { key: "a" } })).toEqual({
      data: { key: "a" },
    });
    expect(readModFrameMessage({ modFrame: true, leave: true })).toEqual({ leave: true });
    expect(readModFrameMessage({ data: { key: "a" } })).toBeUndefined();
    expect(readModFrameMessage("modFrame")).toBeUndefined();
  });
});
