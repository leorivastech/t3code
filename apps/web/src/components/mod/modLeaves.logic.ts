import type { FileDiffMetadata } from "@pierre/diffs/types";
import {
  EXTENSION_TO_FILE_FORMAT,
  getFiletypeFromFileName,
} from "@pierre/diffs/utils/getFiletypeFromFileName";

import { getRenderablePatch } from "../../lib/diffRendering";

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

/** What the highlighter draws as it is written. */
const PLAIN_LANGUAGE = "text";

/**
 * highlight.js ids and aliases the app's highlighter (Shiki) names differently. A mod
 * names its language in highlight.js's vocabulary; every other id the two share.
 */
const SHIKI_LANGUAGE_BY_HIGHLIGHT_JS_NAME = new Map(
  (
    [
      [PLAIN_LANGUAGE, "plaintext txt plain nohighlight"],
      ["c", "h"],
      ["cpp", "cc h++ hpp hh hxx cxx"],
      ["diff", "patch"],
      ["go", "golang"],
      ["makefile", "mk mak"],
      ["markdown", "mkdown mkd"],
      ["objective-c", "objectivec obj-c"],
      ["objective-cpp", "mm obj-c++ objective-c++"],
      ["perl", "pl pm"],
      ["python", "gyp pycon python-repl"],
      ["ruby", "gemspec podspec thor irb"],
      ["vb", "vbnet"],
      ["xml", "xhtml rss atom xjb xsd plist wsf svg"],
      ["nginx", "nginxconf"],
      ["powershell", "pwsh"],
      ["elixir", "ex exs"],
      ["ocaml", "ml"],
      ["http", "https"],
      ["apache", "apacheconf"],
      ["coffeescript", "cson iced"],
      ["crystal", "cr"],
      ["pascal", "delphi"],
      ["jinja", "django"],
      ["handlebars", "html.hbs html.handlebars"],
      ["tcl", "tk"],
      ["twig", "craftcms"],
      ["system-verilog", "sv svh"],
      ["asm", "x86asm armasm arm"],
      ["solidity", "sol"],
      ["sql", "pgsql postgres postgresql"],
      ["bat", "dos"],
      ["groovy", "gradle"],
      ["fortran-free-form", "fortran"],
      ["puppet", "pp"],
    ] as const
  ).flatMap(([language, names]) => names.split(" ").map((name) => [name, language] as const)),
);

const LANGUAGE_NAME = /^[a-z0-9][a-z0-9+#._-]{0,39}$/;

/** A mod's `language` as the highlighter names it, or `null` when it names none. */
function highlighterLanguage(language: string | undefined): string | null {
  const name = language?.trim().toLowerCase() ?? "";
  return LANGUAGE_NAME.test(name) ? (SHIKI_LANGUAGE_BY_HIGHLIGHT_JS_NAME.get(name) ?? name) : null;
}

/** A script's interpreter, as its shebang names it, to the language it runs. */
const LANGUAGE_BY_INTERPRETER = new Map(
  Object.entries({
    sh: "bash",
    bash: "bash",
    dash: "bash",
    ksh: "bash",
    zsh: "zsh",
    fish: "fish",
    python: "python",
    node: "javascript",
    nodejs: "javascript",
    deno: "typescript",
    bun: "typescript",
    tsx: "typescript",
    "ts-node": "typescript",
    ruby: "ruby",
    perl: "perl",
    php: "php",
    lua: "lua",
    rscript: "r",
    pwsh: "powershell",
    osascript: "applescript",
  }),
);

function pathBaseName(path: string | undefined): string {
  return path?.split(/[\\/]/).at(-1)?.trim() ?? "";
}

function languageFromFileName(fileName: string): string {
  if (fileName.length === 0) return PLAIN_LANGUAGE;
  const exact = getFiletypeFromFileName(fileName);
  return exact === PLAIN_LANGUAGE ? getFiletypeFromFileName(fileName.toLowerCase()) : exact;
}

function languageFromShebang(source: string): string {
  const shebang = /^#!([^\n]*)/.exec(source)?.[1];
  if (shebang === undefined) return PLAIN_LANGUAGE;
  const words = shebang.trim().split(/\s+/);
  // `#!/usr/bin/env -S deno run` names the interpreter after env and its flags.
  const command = pathBaseName(words[0]) === "env" ? words.slice(1) : words;
  const interpreter = pathBaseName(command.find((word) => !word.startsWith("-")))
    .toLowerCase()
    .replace(/[\d.]+$/, "");
  return LANGUAGE_BY_INTERPRETER.get(interpreter) ?? PLAIN_LANGUAGE;
}

/**
 * The highlighter language a Code element is drawn in: its `language`, a highlight.js
 * id or alias, else what `path` says by name or extension, else its shebang. `"text"`
 * when none resolves. The path is only ever a name here; nothing reads the file.
 */
export function resolveModCodeLanguage(input: {
  readonly language?: string | undefined;
  readonly path?: string | undefined;
  readonly source: string;
}): string {
  const named = highlighterLanguage(input.language);
  if (named !== null) return named;
  const fromPath = languageFromFileName(pathBaseName(input.path));
  return fromPath === PLAIN_LANGUAGE ? languageFromShebang(input.source) : fromPath;
}

/** The text a Code element draws: `source` without the newline that ends its last line. */
export function modCodeText(source: string): string {
  return source.replace(/\r?\n$/, "");
}

/** `text` as the lines drawn, each keyed by where it starts and holding its own line ending. */
export function modCodeLines(
  text: string,
): ReadonlyArray<{ readonly key: string; readonly text: string }> {
  const lines: Array<{ key: string; text: string }> = [];
  let start = 0;
  for (const lineBreak of text.matchAll(/\r?\n/g)) {
    const end = lineBreak.index + lineBreak[0].length;
    lines.push({ key: String(start), text: text.slice(start, end) });
    start = end;
  }
  lines.push({ key: String(start), text: text.slice(start) });
  return lines;
}

/**
 * The line gutter of a Code element: the number its first line shows and how many
 * digits the widest number needs. `null` without a whole `startLine`, which draws none.
 */
export function modCodeGutter(
  startLine: number | undefined,
  lineCount: number,
): { readonly firstLine: number; readonly digits: number } | null {
  if (startLine === undefined || !Number.isSafeInteger(startLine) || startLine < 0) return null;
  const lastLine = startLine + Math.max(lineCount, 1) - 1;
  return { firstLine: startLine, digits: String(lastLine).length };
}

const fileExtensionByLanguage = new Map<string, string>();
for (const [extension, language] of Object.entries(EXTENSION_TO_FILE_FORMAT)) {
  if (language && !fileExtensionByLanguage.has(language)) {
    fileExtensionByLanguage.set(language, extension);
  }
}

/**
 * The file name a Code diff is parsed under, which is how the diff renderer picks its
 * grammar: one that reads as `language` when the mod names one, else the name in `path`.
 */
function diffFileName(language: string | undefined, path: string | undefined): string {
  const named = highlighterLanguage(language);
  if (named !== null) {
    // A language that is itself a file extension (`ts`, `py`) names the file as it is.
    const extension =
      fileExtensionByLanguage.get(named) ??
      (EXTENSION_TO_FILE_FORMAT[named] === undefined ? undefined : named);
    if (extension) return `file.${extension}`;
  }
  // A diff header ends its path at a tab or a line break.
  const fileName = pathBaseName(path).replace(/\s+/g, "_");
  return fileName.length > 0 ? fileName : "file.txt";
}

/**
 * A Code element's `format: "diff"` source as the files the diff renderer draws. The
 * source is bare hunks (`@@ -a,b +c,d @@` and their lines), so it gets the file header
 * a patch needs unless it brought its own. `null` when no hunk parses, which the
 * element draws as plain text.
 */
export function parseModCodeDiff(input: {
  readonly source: string;
  readonly language?: string | undefined;
  readonly path?: string | undefined;
}): ReadonlyArray<FileDiffMetadata> | null {
  const source = input.source.trim();
  if (!/^@@ /m.test(source)) return null;
  const fileName = diffFileName(input.language, input.path);
  const patch = /^(?:diff --git |--- )/.test(source)
    ? source
    : `diff --git a/${fileName} b/${fileName}\n--- a/${fileName}\n+++ b/${fileName}\n${source}`;
  const renderable = getRenderablePatch(patch, "mods");
  if (renderable?.kind !== "files") return null;
  const files = renderable.files.filter((file) => file.hunks.length > 0);
  return files.length > 0 ? files : null;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * Where the markdown renderer keeps a link's href as the markdown wrote it. The
 * rendered anchor cannot be asked: a file link's href there is the resolved path.
 */
export const MOD_LINK_HREF_ATTRIBUTE = "data-mods-link-href";

const DRAWABLE_LINK_SCHEMES = new Set(["https", "http", "file"]);

/**
 * The URL scheme a click on `href` would reach, read as a browser reads it: leading
 * spaces and control characters dropped, tabs and line breaks removed anywhere. `null`
 * for a link without one, which is a path or a fragment, a Windows drive path included.
 */
export function modLinkScheme(href: string): string | null {
  const compact = href.replace(/[\t\n\r]/g, "");
  let start = 0;
  while (start < compact.length && compact.charCodeAt(start) <= 0x20) start += 1;
  const url = compact.slice(start);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
  if (scheme === undefined) return null;
  if (scheme.length === 1 && /^[\\/]/.test(url.slice(2))) return null;
  return scheme.toLowerCase();
}

/**
 * Whether a link in a mod's markdown may be drawn as a link. Only `https:`, `http:`
 * and `file:` are; any other scheme is drawn as text, so a mod never chooses the URL
 * handler a click reaches. A link without a scheme stays inside the workspace.
 */
export function isModLinkDrawable(href: string): boolean {
  const scheme = modLinkScheme(href);
  return scheme === null || DRAWABLE_LINK_SCHEMES.has(scheme);
}

/**
 * Whether a click on a markdown link is a press the mod answers, in which case the
 * surface opens nothing: a plain primary click on a link the mod asked for, which is
 * every link when it named none. A modified click keeps opening the link.
 */
export function isModLinkPress(input: {
  readonly href: string;
  readonly pressableLinks: ReadonlyArray<string> | undefined;
  readonly event: {
    readonly button: number;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
  };
}): boolean {
  const { event } = input;
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return false;
  }
  return input.pressableLinks === undefined || input.pressableLinks.includes(input.href);
}

interface MarkdownAstNode {
  type?: string;
  url?: string;
  identifier?: string;
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
}

/**
 * A remark plugin applying a mod's link rules to the markdown tree. A link whose scheme
 * may not be drawn is replaced by its own text, whatever wrote it: an inline link, a
 * reference, an autolink, a bare email. Every other link is wrapped in a span carrying
 * its href as written, for the press handler to read.
 */
export function remarkModLinks() {
  return (tree: MarkdownAstNode) => {
    const urlByIdentifier = new Map<string, string>();
    const collectDefinitions = (node: MarkdownAstNode) => {
      if (node.type === "definition" && node.identifier !== undefined && node.url !== undefined) {
        urlByIdentifier.set(node.identifier, node.url);
      }
      node.children?.forEach(collectDefinitions);
    };
    collectDefinitions(tree);

    const rewriteLinks = (node: MarkdownAstNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        rewriteLinks(child);
        const url =
          child.type === "link"
            ? child.url
            : child.type === "linkReference"
              ? urlByIdentifier.get(child.identifier ?? "")
              : undefined;
        if (url === undefined) return [child];
        if (!isModLinkDrawable(url)) return child.children ?? [];
        return [
          {
            type: "modLink",
            data: { hName: "span", hProperties: { [MOD_LINK_HREF_ATTRIBUTE]: url } },
            children: [child],
          },
        ];
      });
    };
    rewriteLinks(tree);
  };
}

// ---------------------------------------------------------------------------
// Svg
// ---------------------------------------------------------------------------

/** The most SVG markup one element draws; past it only its `alt` is. */
export const MOD_SVG_MAX_SOURCE_LENGTH = 131_072;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SVG_ROOT_TAG = /<svg(?=[\s/>])[^>]*>/i;

/** `source` when it is markup the surface draws: not empty and within the size cap. */
function drawableSvgSource(source: string): string | null {
  return source.trim().length > 0 && source.length <= MOD_SVG_MAX_SOURCE_LENGTH ? source : null;
}

/**
 * An Svg element's markup as the `src` of an image, which runs no script and loads
 * nothing the markup points at. An image only draws SVG that declares its namespace,
 * so a root without one gets it. `null` when the markup is empty, over the size cap or
 * not text a URL can hold; the element then draws its `alt`.
 */
export function modSvgDataUrl(source: string): string | null {
  const markup = drawableSvgSource(source);
  if (markup === null) return null;
  const namespaced = markup.replace(SVG_ROOT_TAG, (rootTag) =>
    /\sxmlns\s*=/i.test(rootTag) ? rootTag : `<svg xmlns="${SVG_NAMESPACE}"${rootTag.slice(4)}`,
  );
  try {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(namespaced)}`;
  } catch {
    // A lone surrogate has no UTF-8 encoding.
    return null;
  }
}

/**
 * The document a sandboxed frame draws an interactive Svg element in. Its policy lets
 * the markup style itself and embed `data:` images, and nothing else: no script, no
 * request. `null` when the markup is empty or over the size cap.
 */
export function modSvgFrameDocument(source: string): string | null {
  const markup = drawableSvgSource(source);
  if (markup === null) return null;
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    // Matching the app's appearance keeps the frame's canvas transparent.
    '<meta name="color-scheme" content="light dark">',
    // The frame may open nothing, so a link inside the drawing goes nowhere.
    '<base target="_blank">',
    "<style>html,body{height:100%;margin:0;overflow:hidden;background:transparent}",
    "body>svg{display:block;width:100%;height:100%}</style>",
    "</head><body>",
    markup,
    "</body></html>",
  ].join("");
}

function svgLength(value: string | undefined): number | null {
  const match = value === undefined ? null : /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/.exec(value);
  const length = match ? Number(match[1]) : 0;
  return length > 0 ? length : null;
}

/**
 * The size an Svg element's markup gives itself, in CSS pixels: its root's `width` and
 * `height`, else its `viewBox`. A frame has no intrinsic size to take from its content
 * the way an image does, so this is what sizes one. `null` when the root states neither.
 */
export function modSvgIntrinsicSize(
  source: string,
): { readonly width: number; readonly height: number } | null {
  const rootTag = SVG_ROOT_TAG.exec(source)?.[0];
  if (rootTag === undefined) return null;
  const attribute = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
      .exec(rootTag)
      ?.slice(1)
      .find((value) => value !== undefined);
  const viewBox = attribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBoxWidth = viewBox?.length === 4 && viewBox[2]! > 0 ? viewBox[2]! : null;
  const viewBoxHeight = viewBox?.length === 4 && viewBox[3]! > 0 ? viewBox[3]! : null;
  const width = svgLength(attribute("width"));
  const height = svgLength(attribute("height"));
  if (width !== null && height !== null) return { width, height };
  if (viewBoxWidth === null || viewBoxHeight === null) return null;
  // One stated side keeps the viewBox's proportions.
  if (width !== null) return { width, height: (width * viewBoxHeight) / viewBoxWidth };
  if (height !== null) return { width: (height * viewBoxWidth) / viewBoxHeight, height };
  return { width: viewBoxWidth, height: viewBoxHeight };
}

function svgBoxLength(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The box an Svg element is drawn in. `width` and `height` are CSS pixels, as the mod
 * API defines them; a missing side follows `intrinsic`, the markup's own proportions,
 * and the box never grows wider than its slot. Empty when nothing sizes it, which
 * leaves an image at its own size.
 */
export function modSvgBoxStyle(input: {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly intrinsic?: { readonly width: number; readonly height: number } | null | undefined;
}): { width?: string; height?: string; aspectRatio?: string } {
  const width = svgBoxLength(input.width);
  const height = svgBoxLength(input.height);
  if (width !== null && height !== null) return { width: `${width}px`, height: `${height}px` };
  const ratio = input.intrinsic
    ? { aspectRatio: `${input.intrinsic.width} / ${input.intrinsic.height}` }
    : {};
  if (width !== null) return { width: `${width}px`, ...ratio };
  if (height !== null) return { height: `${height}px`, ...ratio };
  return input.intrinsic ? { width: `${input.intrinsic.width}px`, ...ratio } : {};
}
