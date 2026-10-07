import type { ModSite as SiteComponent, ModSiteCommand } from "@t3tools/contracts";
import {
  type KeyboardEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";

import {
  MOD_AUTOFOCUS_ATTRIBUTE,
  MOD_HOTKEY_ATTRIBUTE,
  MOD_KEY_ATTRIBUTE,
  MOD_PLUGIN_ATTRIBUTE,
  ModTree,
} from "./ModTree";
import type { ModSurface } from "./modSurface";
import { useModInstance } from "./useMod";

/** Digits and lowercase letters press a Button's `hotkey`. */
const HOTKEY_PATTERN = /^[0-9a-z]$/;
const MAX_KEYED_ELEMENTS = 512;
/** How far the type may shrink to fit `minColumns`; narrower still, fewer columns are reported. */
const MIN_FIT_SCALE = 0.75;
/** How long the scrolling must rest before the mods hear where it stopped. */
const SCROLL_REPORT_MS = 150;

interface SiteSize {
  readonly columns: number;
  readonly bodyRows: number;
  /** The type's scale: below 1 when the site is narrower than `minColumns`. */
  readonly scale: number;
  /** One row's height in pixels at that scale. */
  readonly rowHeight: number;
}

/**
 * Scrolls a site's body from code. Returns the position the scroll event it
 * causes will report, which is not the person's scroll, or null when the
 * position was clamped or unchanged and no event follows.
 */
const moveBody = (body: HTMLDivElement, top: number): number | null => {
  const before = body.scrollTop;
  body.scrollTop = top;
  return body.scrollTop === before ? null : body.scrollTop;
};

const attributeSelector = (attribute: string, value: string) =>
  `[${attribute}="${CSS.escape(value)}"]`;

/**
 * A scrolling, focusable site a mod draws in: a pane's body or the band above
 * the composer. It measures itself in terminal cells, asks the mods for the
 * tree, and reports the person's scrolling and hotkeys back.
 */
export function ModSite(props: {
  readonly surface: ModSurface;
  readonly component: SiteComponent;
  readonly instanceId: string;
  readonly cwd: string | undefined;
  /** The component's own props; the site adds `bodyColumns`, `scroll` and `view`. */
  readonly siteProps: Readonly<Record<string, unknown>>;
  /** Rows the body may take before it scrolls; without it the body fills its parent. */
  readonly maxRows?: number;
  /**
   * The columns a mod's layout is made for. A narrower site shrinks its
   * type, down to a floor, to fit them instead of wrapping a layout made for
   * a terminal's width into fragments.
   */
  readonly minColumns?: number;
  /** The mod that opened the site, when one did: who a keyed Box belongs to. */
  readonly plugin?: string;
  readonly className?: string;
  /** Whether the site now holds the keyboard. */
  readonly onHeldChange?: (isHeld: boolean) => void;
  /** Escape was pressed while the site held the keyboard. */
  readonly onEscape?: () => void;
  /** The body's width in cells and one row's height in pixels, once measured. */
  readonly onMeasure?: (measure: { readonly columns: number; readonly rowHeight: number }) => void;
  /** Gives the site the keyboard each time it changes to a new non-null value. */
  readonly focusToken?: string | null;
}) {
  const { surface, component, instanceId, maxRows, minColumns, plugin } = props;
  const { onHeldChange, onMeasure, focusToken } = props;
  const frameRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [size, setSize] = useState<SiteSize | null>(null);
  const [offset, setOffset] = useState(0);
  const [isHeld, setIsHeld] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const followsEnd = useRef(false);
  // A scroll this site made itself is not the person's and is not reported.
  const expectedScrollTop = useRef<number | null>(null);
  const wheelRows = useRef(0);
  const reportedOffset = useRef(0);
  const report = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: boolean;
    again: boolean;
  }>({
    timer: null,
    inFlight: false,
    again: false,
  });
  const rowHeight = size?.rowHeight ?? 0;

  /** Where the keyed elements sit in the content, in rows from its top. */
  const measureKeyed = () => {
    const body = bodyRef.current;
    if (body === null || rowHeight === 0) return undefined;
    const top = body.getBoundingClientRect().top - body.scrollTop;
    const keyed: Array<{ plugin: string; key: string; top: number; bottom: number }> = [];
    for (const element of body.querySelectorAll(`[${MOD_KEY_ATTRIBUTE}]`)) {
      const owner = element.getAttribute(MOD_PLUGIN_ATTRIBUTE) ?? plugin;
      const key = element.getAttribute(MOD_KEY_ATTRIBUTE);
      if (owner === undefined || key === null || keyed.length >= MAX_KEYED_ELEMENTS) continue;
      const rect = element.getBoundingClientRect();
      keyed.push({
        plugin: owner,
        key,
        top: Math.max(0, Math.floor((rect.top - top) / rowHeight)),
        bottom: Math.max(0, Math.ceil((rect.bottom - top) / rowHeight)),
      });
    }
    return keyed;
  };

  const measureContentRows = () => {
    const body = bodyRef.current;
    return body === null || rowHeight === 0 ? undefined : Math.ceil(body.scrollHeight / rowHeight);
  };

  const bodyRows = size?.bodyRows ?? maxRows ?? 1;
  const columns = size?.columns ?? minColumns ?? 80;
  const ask = {
    props: {
      ...props.siteProps,
      bodyColumns: columns,
      scroll: { offset, bodyRows },
      view: {},
    },
    viewport: { columns, rows: bodyRows, isFullscreen: true },
    // Read when the surface asks, so the mods see the layout as it stands.
    get contentRows() {
      return measureContentRows();
    },
    get keyed() {
      return measureKeyed();
    },
  };
  const askKey = useMemo(
    () => JSON.stringify([props.siteProps, columns, bodyRows, offset]),
    [props.siteProps, columns, bodyRows, offset],
  );
  const result = useModInstance(size === null ? null : surface, component, instanceId, ask, askKey);
  const tree = result === null || result.tree.type === "engine" ? null : result.tree;

  // Measure the site in cells, and again whenever it resizes.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const probe = probeRef.current;
    if (frame === null || probe === null) return;
    const measure = () => {
      const probeBox = probe.getBoundingClientRect();
      const cellWidth = probeBox.width / 10;
      const width = frame.clientWidth;
      // A site that is not laid out (a hidden pane) keeps its last size.
      if (cellWidth === 0 || probeBox.height === 0 || width === 0) return;
      const fits = Math.floor(width / cellWidth);
      const scale =
        minColumns === undefined || fits >= minColumns
          ? 1
          : Math.max(MIN_FIT_SCALE, width / (minColumns * cellWidth));
      const next: SiteSize = {
        columns: Math.max(1, Math.floor(width / (cellWidth * scale))),
        bodyRows:
          maxRows ?? Math.max(1, Math.floor(frame.clientHeight / (probeBox.height * scale))),
        scale,
        rowHeight: probeBox.height * scale,
      };
      setSize((current) =>
        current !== null &&
        current.columns === next.columns &&
        current.bodyRows === next.bodyRows &&
        current.scale === next.scale
          ? current
          : next,
      );
      onMeasure?.({ columns: next.columns, rowHeight: next.rowHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [maxRows, minColumns, onMeasure]);

  // Scroll bars only when the tree is taller than its window.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null || rowHeight === 0) return;
    // Measured again for each tree and window size.
    setOverflows(
      tree !== null && bodyRows > 0 && body.scrollHeight - body.clientHeight > rowHeight / 2,
    );
  }, [tree, rowHeight, bodyRows]);

  useEffect(() => {
    const body = bodyRef.current;
    // A click into the site already put the keyboard on one of its elements.
    if (focusToken != null && body !== null && !body.contains(document.activeElement)) {
      body.focus();
    }
  }, [focusToken]);

  const scrollTo = (rows: number) => {
    const body = bodyRef.current;
    if (body === null) return;
    expectedScrollTop.current = moveBody(body, Math.round(rows * rowHeight));
    reportedOffset.current = rows;
    setOffset(rows);
  };

  // Keep the end in view while a mod asked to follow it.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null || tree === null || !followsEnd.current) return;
    expectedScrollTop.current = moveBody(body, body.scrollHeight);
  }, [tree]);

  // A mod moved this site's window.
  const onCommand = useEffectEvent((command: ModSiteCommand) => {
    if (command.component !== component || command.instanceId !== instanceId) return;
    if (command.kind !== "scroll") return;
    followsEnd.current = command.followEnd === true;
    scrollTo(command.offset);
  });
  useEffect(() => surface.onCommand(onCommand), [surface]);

  /** Tells the mods where the person scrolled; the answer is where the window stays. */
  const reportScroll = () => {
    const state = report.current;
    if (state.inFlight) {
      state.again = true;
      return;
    }
    const body = bodyRef.current;
    if (body === null || rowHeight === 0) return;
    const next = Math.max(0, Math.round(body.scrollTop / rowHeight));
    // A wheel over a body with nothing to scroll still moves a mod's own window.
    const by = next !== reportedOffset.current ? next - reportedOffset.current : wheelRows.current;
    wheelRows.current = 0;
    if (by === 0) return;
    followsEnd.current = false;
    reportedOffset.current = next;
    state.inFlight = true;
    const keyed = measureKeyed();
    void surface
      .operate({
        op: "scroll",
        component,
        instanceId,
        offset: next,
        by,
        bodyRows,
        contentRows: measureContentRows() ?? bodyRows,
        ...(keyed === undefined ? {} : { keyed }),
      })
      .then((response) => {
        state.inFlight = false;
        const answer =
          typeof response === "object" && response !== null
            ? (response as { offset?: unknown; follow_end?: unknown })
            : {};
        followsEnd.current = answer.follow_end === true;
        if (typeof answer.offset === "number" && answer.offset !== reportedOffset.current) {
          scrollTo(answer.offset);
        } else {
          setOffset(reportedOffset.current);
        }
        if (state.again) {
          state.again = false;
          reportScroll();
        }
      });
  };

  /**
   * Reports once the scrolling pauses. The body scrolls natively meanwhile, and a
   * report per step would redraw the site over the wire many times a second.
   */
  const scheduleScrollReport = () => {
    const state = report.current;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      reportScroll();
    }, SCROLL_REPORT_MS);
  };

  useEffect(() => {
    const state = report.current;
    return () => {
      if (state.timer !== null) clearTimeout(state.timer);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      props.onEscape?.();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || !HOTKEY_PATTERN.test(event.key)) return;
    // A field the person types into keeps its keys.
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true'], [role='combobox']")) {
      return;
    }
    const button = bodyRef.current?.querySelector<HTMLButtonElement>(
      `${attributeSelector(MOD_HOTKEY_ATTRIBUTE, event.key)}:not(:disabled)`,
    );
    if (button == null) return;
    event.preventDefault();
    button.click();
  };

  const scale = size?.scale ?? 1;
  return (
    <div
      ref={frameRef}
      className={cn(
        "relative min-w-0 font-mono text-xs leading-4",
        maxRows === undefined && "h-full",
        props.className,
      )}
    >
      <span ref={probeRef} aria-hidden className="invisible absolute whitespace-pre">
        0000000000
      </span>
      <div
        ref={bodyRef}
        tabIndex={-1}
        data-mods-site=""
        {...(tree === null ? {} : { "data-mods-drawn": "" })}
        className={cn(
          "relative min-w-0 outline-none",
          maxRows === undefined && "h-full",
          "overflow-x-hidden",
          overflows ? "overflow-y-auto" : "overflow-y-hidden",
        )}
        style={{
          ...(maxRows === undefined ? {} : { maxHeight: `${maxRows}lh` }),
          ...(scale === 1 ? {} : { fontSize: `${scale}em`, lineHeight: `${rowHeight}px` }),
        }}
        onScroll={(event) => {
          if (expectedScrollTop.current !== null) {
            const expected = expectedScrollTop.current;
            expectedScrollTop.current = null;
            if (Math.abs(event.currentTarget.scrollTop - expected) <= 1) return;
          }
          scheduleScrollReport();
        }}
        onWheel={(event) => {
          if (rowHeight === 0) return;
          wheelRows.current +=
            Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / rowHeight));
          scheduleScrollReport();
        }}
        onFocus={(event) => {
          const body = event.currentTarget;
          if (!isHeld) {
            setIsHeld(true);
            onHeldChange?.(true);
          }
          // Focus landing on the site itself starts at the element that asked for it.
          if (event.target === body) {
            body.querySelector<HTMLElement>(`[${MOD_AUTOFOCUS_ATTRIBUTE}]`)?.focus();
          }
        }}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setIsHeld(false);
          onHeldChange?.(false);
        }}
        onKeyDown={onKeyDown}
      >
        {tree === null ? null : (
          <ModTree
            tree={tree}
            surface={surface}
            component={component}
            instanceId={instanceId}
            cwd={props.cwd}
          />
        )}
      </div>
    </div>
  );
}
