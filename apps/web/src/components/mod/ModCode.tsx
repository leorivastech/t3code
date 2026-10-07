import { FileDiff } from "@pierre/diffs/react";
import { Suspense, useMemo, type CSSProperties } from "react";

import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName, resolveFileDiffPath } from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { cn } from "../../lib/utils";
import { HighlightedTokens } from "../chat/HighlightedTokens";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import {
  modCodeGutter,
  modCodeLines,
  modCodeText,
  parseModCodeDiff,
  resolveModCodeLanguage,
} from "./modLeaves.logic";

type CodeWrap = "wrap" | "truncate-end";

// Each line is one child of the <pre>, numbered by a counter in front of it, so a
// wrapped line continues on rows under the gutter and a copy never carries a number.
const GUTTER_CLASS_NAME =
  "*:before:mr-[1ch] *:before:inline-block *:before:w-(--mods-gutter) *:before:text-right *:before:text-muted-foreground/70 *:before:select-none *:before:content-[counter(mods-line)] *:before:[counter-increment:mods-line]";

function CodeText(props: {
  code: string;
  language: string;
  startLine?: number | undefined;
  wrap: CodeWrap;
}) {
  const { resolvedTheme } = useTheme();
  const lines = modCodeLines(props.code);
  const gutter = modCodeGutter(props.startLine, lines.length);
  // One span per line, the shape the highlighter draws, so its arrival moves nothing.
  const plain = lines.map((line) => <span key={line.key}>{line.text}</span>);
  return (
    <pre
      className={cn(
        "m-0 min-w-0 max-w-full font-mono text-foreground/85",
        props.wrap === "truncate-end"
          ? "overflow-hidden text-ellipsis whitespace-pre"
          : "wrap-anywhere whitespace-pre-wrap",
        gutter && GUTTER_CLASS_NAME,
      )}
      style={
        gutter
          ? ({
              counterReset: `mods-line ${gutter.firstLine - 1}`,
              "--mods-gutter": `${gutter.digits}ch`,
            } as CSSProperties)
          : undefined
      }
    >
      {props.language === "text" ? (
        plain
      ) : (
        <RenderErrorBoundary fallback={plain} resetKeys={[props.code, props.language]}>
          <Suspense fallback={plain}>
            <HighlightedTokens code={props.code} language={props.language} theme={resolvedTheme} />
          </Suspense>
        </RenderErrorBoundary>
      )}
    </pre>
  );
}

function CodeDiff(props: {
  source: string;
  language?: string | undefined;
  path?: string | undefined;
  wrap: CodeWrap;
}) {
  const { resolvedTheme } = useTheme();
  const files = useMemo(
    () =>
      parseModCodeDiff({
        source: props.source,
        language: props.language,
        path: props.path,
      }),
    [props.language, props.path, props.source],
  );
  const plain = <CodeText code={modCodeText(props.source)} language="text" wrap={props.wrap} />;
  if (files === null) return plain;
  return (
    <RenderErrorBoundary fallback={plain} resetKeys={[files]}>
      {/* The diff renderer sizes its text from this hook; 1em is the parent's size. */}
      <div className="min-w-0 max-w-full [--diffs-font-size:1em]">
        <DiffWorkerPoolProvider>
          {files.map((fileDiff) => (
            <FileDiff
              key={resolveFileDiffPath(fileDiff)}
              fileDiff={fileDiff}
              options={{
                collapsed: false,
                diffStyle: "unified",
                // The path only names the grammar; a mod's diff shows no file header.
                disableFileHeader: true,
                overflow: props.wrap === "truncate-end" ? "scroll" : "wrap",
                theme: resolveDiffThemeName(resolvedTheme),
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
              }}
            />
          ))}
        </DiffWorkerPoolProvider>
      </div>
    </RenderErrorBoundary>
  );
}

/**
 * A mod's `Code` element: source text in the app's own highlighter, at the font size of
 * whatever it sits in. `language` is a highlight.js id or alias; without one the
 * language comes from `path`, which is only a name and is never read. `startLine`
 * numbers a line gutter from there. `wrap: "truncate-end"` cuts a long line with an
 * ellipsis instead of wrapping it. Under `format: "diff"` the source is unified-diff
 * hunks drawn as a diff, or as plain text when they do not parse.
 */
export function ModCode(props: {
  source: string;
  language?: string;
  path?: string;
  startLine?: number;
  format?: "source" | "diff";
  wrap?: "wrap" | "truncate-end";
}) {
  const wrap = props.wrap === "truncate-end" ? "truncate-end" : "wrap";
  if (typeof props.source !== "string" || props.source.length === 0) return null;
  if (props.format === "diff") {
    return (
      <CodeDiff source={props.source} language={props.language} path={props.path} wrap={wrap} />
    );
  }
  return (
    <CodeText
      code={modCodeText(props.source)}
      language={resolveModCodeLanguage(props)}
      startLine={props.startLine}
      wrap={wrap}
    />
  );
}
