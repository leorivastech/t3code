import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import {
  MOD_LINK_HREF_ATTRIBUTE,
  MOD_SVG_MAX_SOURCE_LENGTH,
  modCodeGutter,
  modCodeLines,
  modCodeText,
  modLinkScheme,
  modSvgBoxStyle,
  modSvgDataUrl,
  modSvgFrameDocument,
  modSvgIntrinsicSize,
  isModLinkDrawable,
  isModLinkPress,
  parseModCodeDiff,
  remarkModLinks,
  resolveModCodeLanguage,
} from "./modLeaves.logic";

describe("resolveModCodeLanguage", () => {
  it.each([
    [{ language: "typescript" }, "typescript"],
    [{ language: " TS " }, "ts"],
    [{ language: "py" }, "py"],
    [{ language: "golang" }, "go"],
    [{ language: "objectivec" }, "objective-c"],
    [{ language: "patch" }, "diff"],
    [{ language: "plaintext" }, "text"],
    [{ language: "c++" }, "c++"],
    [{ language: "python", path: "src/main.rs" }, "python"],
    [{ path: "src/main.rs" }, "rust"],
    [{ path: "C:\\repo\\src\\App.TSX" }, "tsx"],
    [{ path: "deploy/Dockerfile" }, "dockerfile"],
    [{ path: "/repo/Makefile" }, "makefile"],
    [{ path: "notes.unknownext" }, "text"],
    [{ path: "bin/run", source: "#!/usr/bin/env python3\nprint(1)\n" }, "python"],
    [{ path: "bin/run", source: "#!/bin/sh\necho hi" }, "bash"],
    [{ source: "#!/usr/bin/env -S deno run --allow-net\n" }, "typescript"],
    [{ path: "main.rs", source: "#!/usr/bin/env python\n" }, "rust"],
    [{ language: "not a language", path: "a.json" }, "json"],
    [{ language: "", path: "" }, "text"],
    [{}, "text"],
  ])("resolves %j to %s", (input, expected) => {
    expect(resolveModCodeLanguage({ source: "", ...input })).toBe(expected);
  });
});

describe("code lines and gutter", () => {
  it("drops only the newline that ends the last line", () => {
    expect(modCodeText("a\nb\n")).toBe("a\nb");
    expect(modCodeText("a\r\n")).toBe("a");
    expect(modCodeText("a\n\n")).toBe("a\n");
    expect(modCodeText("")).toBe("");
  });

  it("splits text into lines that join back into it", () => {
    const text = "one\n\nthree\r\nfour";
    const lines = modCodeLines(text);
    expect(lines.map((line) => line.text)).toEqual(["one\n", "\n", "three\r\n", "four"]);
    expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
    expect(modCodeLines("")).toEqual([{ key: "0", text: "" }]);
  });

  it("sizes the gutter for the last line's number", () => {
    expect(modCodeGutter(1, 9)).toEqual({ firstLine: 1, digits: 1 });
    expect(modCodeGutter(1, 10)).toEqual({ firstLine: 1, digits: 2 });
    expect(modCodeGutter(98, 3)).toEqual({ firstLine: 98, digits: 3 });
  });

  it.each([undefined, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -3])(
    "draws no gutter for startLine %s",
    (startLine) => {
      expect(modCodeGutter(startLine, 4)).toBeNull();
    },
  );
});

describe("parseModCodeDiff", () => {
  const HUNK = [
    "@@ -1,3 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    " const c = 4;",
  ]
    .join("\n")
    .concat("\n");

  it("reads bare hunks as one file named for the path", () => {
    const files = parseModCodeDiff({ source: HUNK, path: "src/app config.ts" });
    expect(files).toHaveLength(1);
    expect(files?.[0]?.name).toBe("app_config.ts");
    expect(files?.[0]?.hunks).toHaveLength(1);
    expect(files?.[0]?.hunks[0]).toMatchObject({ additionLines: 1, deletionLines: 1 });
  });

  it("names the file for the language when the mod gives one", () => {
    expect(parseModCodeDiff({ source: HUNK, language: "python" })?.[0]?.name).toBe("file.py");
    expect(parseModCodeDiff({ source: HUNK, language: "rs", path: "a.py" })?.[0]?.name).toBe(
      "file.rs",
    );
    expect(parseModCodeDiff({ source: HUNK })?.[0]?.name).toBe("file.txt");
  });

  it("keeps a file header the source brought", () => {
    const withHeader = `--- a/old.ts\n+++ b/new.ts\n${HUNK}`;
    const files = parseModCodeDiff({ source: withHeader, path: "ignored.py" });
    expect(files).toHaveLength(1);
    expect(files?.[0]?.hunks).toHaveLength(1);

    const gitPatch = `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n${HUNK}`;
    expect(parseModCodeDiff({ source: gitPatch })?.[0]?.name).toBe("x.ts");
  });

  it("reads several hunks and a missing final newline", () => {
    const source = [
      "@@ -1,2 +1,2 @@",
      "-a",
      "+b",
      " c",
      "@@ -10,2 +10,3 @@",
      " x",
      "+y",
      " z",
      "\\ No newline at end of file",
    ].join("\n");
    const files = parseModCodeDiff({ source, path: "a.txt" });
    expect(files?.[0]?.hunks).toHaveLength(2);
  });

  it.each([
    ["", "empty"],
    ["   \n", "blank"],
    ["just some text\nwith lines", "prose"],
    ["--- a/x.ts\n+++ b/x.ts\n", "a header with no hunk"],
    ["+added\n-removed", "markers with no hunk header"],
  ])("draws %j as plain text (%s)", (source) => {
    expect(parseModCodeDiff({ source, path: "x.ts" })).toBeNull();
  });
});

describe("markdown link rules", () => {
  it.each([
    ["https://example.com/a", "https"],
    ["HTTP://example.com", "http"],
    ["file:///tmp/a.txt", "file"],
    ["mailto:me@example.com", "mailto"],
    ["javascript:alert(1)", "javascript"],
    ["  javascript:alert(1)", "javascript"],
    ["java\tscript:alert(1)", "javascript"],
    ["\u0001vscode://file/x", "vscode"],
    ["t3-context://thing", "t3-context"],
    ["src/app.ts", null],
    ["./docs/a.md#top", null],
    ["#heading", null],
    ["//example.com/x", null],
    ["C:\\repo\\a.ts", null],
    ["C:/repo/a.ts", null],
    ["src/a.ts:12", null],
    ["", null],
  ])("reads the scheme of %j as %s", (href, scheme) => {
    expect(modLinkScheme(href)).toBe(scheme);
  });

  it("draws only https, http, file and scheme-less links", () => {
    for (const href of ["https://a.dev", "http://a.dev", "file:///a", "docs/a.md", "#top"]) {
      expect(isModLinkDrawable(href)).toBe(true);
    }
    for (const href of [
      "mailto:a@b.c",
      "javascript:alert(1)",
      "java\nscript:alert(1)",
      "vscode://file/x",
      "data:text/html,<b>x</b>",
      "tel:+1",
      "t3-citation:1",
      "c:evil",
    ]) {
      expect(isModLinkDrawable(href)).toBe(false);
    }
  });

  const plainClick = { button: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

  it("treats a plain primary click as a press on any link when none are named", () => {
    expect(
      isModLinkPress({
        href: "docs/a.md",
        pressableLinks: undefined,
        event: plainClick,
      }),
    ).toBe(true);
  });

  it("presses only the links the mod named, compared as written", () => {
    const pressableLinks = ["docs/a.md", "https://example.com/"];
    const press = (href: string) => isModLinkPress({ href, pressableLinks, event: plainClick });
    expect(press("docs/a.md")).toBe(true);
    expect(press("https://example.com/")).toBe(true);
    expect(press("https://example.com")).toBe(false);
    expect(press("/repo/docs/a.md")).toBe(false);
    expect(isModLinkPress({ href: "docs/a.md", pressableLinks: [], event: plainClick })).toBe(
      false,
    );
  });

  it.each([
    [{ button: 1 }],
    [{ button: 2 }],
    [{ ctrlKey: true }],
    [{ metaKey: true }],
    [{ altKey: true }],
    [{ shiftKey: true }],
  ])("leaves a click with %j to the surface", (modifier) => {
    expect(
      isModLinkPress({
        href: "docs/a.md",
        pressableLinks: undefined,
        event: { ...plainClick, ...modifier },
      }),
    ).toBe(false);
  });
});

describe("remarkModLinks", () => {
  const render = (markdown: string) =>
    renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkModLinks]}>{markdown}</ReactMarkdown>,
    );

  it("draws a link with another scheme as its text", () => {
    const html = render(
      [
        "[mail me](mailto:me@example.com) or [open](vscode://file/x) or <tel:+123>.",
        "Write to someone@example.com, see [the ref][r] and [**bold** app](myapp://go).",
        "",
        "[r]: slack://channel/1",
      ].join("\n"),
    );
    expect(html).not.toContain("<a");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("slack:");
    expect(html).toContain("mail me");
    expect(html).toContain("someone@example.com");
    expect(html).toContain("the ref");
    expect(html).toContain("<strong>bold</strong> app");
  });

  it("keeps drawable links and records each href as written", () => {
    const html = render(
      [
        "[site](https://example.com/a?b=1&c=2) [file](docs/My%20Notes.md#top) www.example.org",
        "[ref][r]",
        "",
        "[r]: file:///tmp/a.txt",
      ].join("\n"),
    );
    const recorded = [
      ...html.matchAll(new RegExp(`<span ${MOD_LINK_HREF_ATTRIBUTE}="([^"]*)"><a `, "g")),
    ].map((match) => match[1]);
    expect(recorded).toEqual([
      "https://example.com/a?b=1&amp;c=2",
      "docs/My%20Notes.md#top",
      "http://www.example.org",
      "file:///tmp/a.txt",
    ]);
    expect(html.match(/<a /g)).toHaveLength(4);
  });

  it("leaves text that only looks like a link alone", () => {
    const html = render("`[x](mailto:a@b.c)` and [not a link] and [dangling][nowhere]");
    expect(html).toContain("<code>[x](mailto:a@b.c)</code>");
    expect(html).toContain("[not a link]");
    expect(html).toContain("[dangling][nowhere]");
    expect(html).not.toContain(MOD_LINK_HREF_ATTRIBUTE);
  });
});

describe("svg", () => {
  const SVG = '<svg viewBox="0 0 20 10"><rect width="20" height="10" fill="#f00"/></svg>';

  it("builds an image URL that decodes back to namespaced markup", () => {
    const url = modSvgDataUrl(SVG);
    expect(url).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(decodeURIComponent(url!.slice(url!.indexOf(",") + 1))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#f00"/></svg>',
    );
    // Nothing in the URL can end the attribute or the URL it sits in.
    expect(url).not.toMatch(/["<>#\s]/);
  });

  it("keeps a namespace the markup declared", () => {
    const namespaced =
      '<?xml version="1.0"?>\n<svg\n  xmlns="http://www.w3.org/2000/svg"><g/></svg>';
    const url = modSvgDataUrl(namespaced)!;
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(namespaced);
  });

  it("adds the namespace when only a prefixed one is declared", () => {
    const url = modSvgDataUrl('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><g/></svg>')!;
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g/></svg>',
    );
  });

  it("draws nothing for markup that is empty, too long or not encodable", () => {
    const atCap = `<svg>${" ".repeat(MOD_SVG_MAX_SOURCE_LENGTH - 11)}</svg>`;
    expect(atCap).toHaveLength(MOD_SVG_MAX_SOURCE_LENGTH);
    expect(modSvgDataUrl(atCap)).not.toBeNull();
    expect(modSvgFrameDocument(atCap)).not.toBeNull();

    const overCap = `${atCap} `;
    expect(modSvgDataUrl(overCap)).toBeNull();
    expect(modSvgFrameDocument(overCap)).toBeNull();

    expect(modSvgDataUrl("")).toBeNull();
    expect(modSvgDataUrl("  \n")).toBeNull();
    expect(modSvgFrameDocument("")).toBeNull();
    expect(modSvgDataUrl("<svg>\ud800</svg>")).toBeNull();
  });

  it("wraps interactive markup in a document that allows no script and no request", () => {
    const frameDocument = modSvgFrameDocument(SVG)!;
    expect(frameDocument).toContain(SVG);
    const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(
      frameDocument,
    )?.[1];
    expect(policy).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(frameDocument.indexOf("Content-Security-Policy")).toBeLessThan(
      frameDocument.indexOf(SVG),
    );
  });

  it.each([
    ['<svg width="120" height="40"></svg>', { width: 120, height: 40 }],
    ['<svg width="120px" height=\'40.5px\' viewBox="0 0 1 1"></svg>', { width: 120, height: 40.5 }],
    ['<svg viewBox="0 0 200 100"></svg>', { width: 200, height: 100 }],
    ['<svg viewBox="0,0,200,100" width="50"></svg>', { width: 50, height: 25 }],
    ['<svg viewBox="0 0 200 100" height="50"></svg>', { width: 100, height: 50 }],
    ['<svg width="100%" height="100%" viewBox="0 0 30 10"></svg>', { width: 30, height: 10 }],
    ['<svg width="100%" height="2em"></svg>', null],
    ['<svg stroke-width="3"></svg>', null],
    ["<svg></svg>", null],
    ["not markup", null],
  ])("reads the size %s gives itself", (source, size) => {
    expect(modSvgIntrinsicSize(source)).toEqual(size);
  });

  it("sizes the box in CSS pixels and follows the markup for a missing side", () => {
    const intrinsic = { width: 200, height: 100 };
    expect(modSvgBoxStyle({ width: 300, height: 120, intrinsic })).toEqual({
      width: "300px",
      height: "120px",
    });
    expect(modSvgBoxStyle({ width: 300, intrinsic })).toEqual({
      width: "300px",
      aspectRatio: "200 / 100",
    });
    expect(modSvgBoxStyle({ height: 50, intrinsic })).toEqual({
      height: "50px",
      aspectRatio: "200 / 100",
    });
    expect(modSvgBoxStyle({ intrinsic })).toEqual({
      width: "200px",
      aspectRatio: "200 / 100",
    });
    expect(modSvgBoxStyle({ width: 300 })).toEqual({ width: "300px" });
    expect(modSvgBoxStyle({})).toEqual({});
    expect(modSvgBoxStyle({ width: Number.NaN, height: -4 })).toEqual({});
  });
});
