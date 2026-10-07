import type { ModChild, ModComponent, ModElement, ModSiteCommand } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ModCode } from "./ModCode";
import { ModMarkdown } from "./ModMarkdown";
import { ModSvg } from "./ModSvg";
import { resolveModColor } from "./modColors";
import { MOD_FRAME_MESSAGE, modFrameDocument, readModFrameMessage } from "./modFrame";
import type { ModSurface } from "./modSurface";

/**
 * Draws a mod's render tree from the desktop element table. Mods lay out
 * in terminal cells, so the tree sizes in `ch` across and `lh` down and
 * expects a monospace parent.
 */

/** Marks an element a mod drew under a `key`, for scroll targets and focus. */
export const MOD_KEY_ATTRIBUTE = "data-mods-key";
export const MOD_PLUGIN_ATTRIBUTE = "data-mods-plugin";
/** Marks a Button's `hotkey`, pressed while its site holds the keyboard. */
export const MOD_HOTKEY_ATTRIBUTE = "data-mods-hotkey";
export const MOD_AUTOFOCUS_ATTRIBUTE = "data-mods-autofocus";

interface TreeContextValue {
  readonly surface: ModSurface;
  readonly component: ModComponent;
  readonly instanceId: string;
  readonly cwd: string | undefined;
}

const TreeContext = createContext<TreeContextValue | null>(null);
/** Whether the pointer is over the nearest keyed Box. */
const HoverScopeContext = createContext(false);

type Props = Readonly<Record<string, unknown>>;

/** A horizontal size in terminal cells (`ch`); percentages pass through. */
const cells = (value: unknown): string | undefined =>
  typeof value === "number"
    ? `${value}ch`
    : typeof value === "string" && /^\d+(\.\d+)?%$/.test(value)
      ? value
      : undefined;

/** A vertical size in terminal rows (`lh`); percentages pass through. */
const rows = (value: unknown): string | undefined =>
  typeof value === "number"
    ? `${value}lh`
    : typeof value === "string" && /^\d+(\.\d+)?%$/.test(value)
      ? value
      : undefined;

const number = (value: unknown): number => (typeof value === "number" ? value : 0);

const oneOf = <T extends string>(value: unknown, allowed: ReadonlyArray<T>): T | undefined =>
  allowed.includes(value as T) ? (value as T) : undefined;

const BORDER_LINES: Readonly<Record<string, string>> = {
  single: "1px solid",
  round: "1px solid",
  classic: "1px solid",
  arrow: "1px solid",
  singleDouble: "1px solid",
  doubleSingle: "1px solid",
  double: "3px double",
  bold: "2px solid",
  dashed: "1px dashed",
  quote: "1px solid",
};

/** Maps an Ink-style Box's layout props to flexbox CSS. */
function boxStyle(props: Props): CSSProperties {
  const style: CSSProperties = {
    display: props.display === "none" ? "none" : "flex",
    position: props.position === "absolute" ? "absolute" : "relative",
    flexDirection: oneOf(props.flexDirection, ["row", "column", "row-reverse", "column-reverse"]),
    flexWrap: oneOf(props.flexWrap, ["nowrap", "wrap", "wrap-reverse"]),
    alignItems: oneOf(props.alignItems, ["flex-start", "center", "flex-end", "stretch"]),
    alignSelf: oneOf(props.alignSelf, ["flex-start", "center", "flex-end", "auto"]),
    justifyContent: oneOf(props.justifyContent, [
      "flex-start",
      "center",
      "flex-end",
      "space-between",
      "space-around",
      "space-evenly",
    ]),
    flexGrow: typeof props.flexGrow === "number" ? props.flexGrow : undefined,
    flexShrink: typeof props.flexShrink === "number" ? props.flexShrink : undefined,
    columnGap: cells(props.columnGap ?? props.gap),
    rowGap: rows(props.rowGap ?? props.gap),
    width: cells(props.width),
    minWidth: cells(props.minWidth) ?? 0,
    height: rows(props.height),
    minHeight: rows(props.minHeight),
    top: rows(props.top),
    bottom: rows(props.bottom),
    left: cells(props.left),
    right: cells(props.right),
    overflow: props.overflow === "hidden" ? "hidden" : undefined,
    backgroundColor: resolveModColor(props.backgroundColor),
    boxSizing: "border-box",
  };
  if (props.position === "absolute") style.zIndex = 1;
  const margin = number(props.margin);
  const marginX = number(props.marginX) || margin;
  const marginY = number(props.marginY) || margin;
  const padding = number(props.padding);
  const paddingX = number(props.paddingX) || padding;
  const paddingY = number(props.paddingY) || padding;
  const sides = {
    Left: [number(props.marginLeft) || marginX, number(props.paddingLeft) || paddingX, "ch"],
    Right: [number(props.marginRight) || marginX, number(props.paddingRight) || paddingX, "ch"],
    Top: [number(props.marginTop) || marginY, number(props.paddingTop) || paddingY, "lh"],
    Bottom: [number(props.marginBottom) || marginY, number(props.paddingBottom) || paddingY, "lh"],
  } as const;
  const border =
    typeof props.borderStyle === "string" ? BORDER_LINES[props.borderStyle] : undefined;
  if (border !== undefined) {
    const color = resolveModColor(props.borderColor) ?? "currentColor";
    style.border = `${border} ${
      props.borderDimColor === true ? `color-mix(in srgb, ${color} 50%, transparent)` : color
    }`;
    if (props.borderStyle === "round") style.borderRadius = "0.375rem";
  }
  for (const [side, [marginCells, paddingCells, unit]] of Object.entries(sides)) {
    if (marginCells !== 0) style[`margin${side as "Left"}`] = `${marginCells}${unit}`;
    // A border takes a whole cell across, as in the terminal, so columns still add up.
    const borderCells = border === undefined ? 0 : unit === "ch" ? 1 : 0.5;
    if (paddingCells !== 0 || borderCells !== 0) {
      style[`padding${side as "Left"}`] =
        borderCells === 0
          ? `${paddingCells}${unit}`
          : `calc(${paddingCells + borderCells}${unit} - 1px)`;
    }
  }
  return style;
}

/** Maps an Ink-style Text's color and style props to CSS. */
function textStyle(props: Props): CSSProperties {
  const inverse = props.inverse === true;
  const foreground = resolveModColor(props.color);
  const background = resolveModColor(props.backgroundColor);
  const decorations = [
    props.underline === true ? "underline" : null,
    props.strikethrough === true ? "line-through" : null,
  ].filter((decoration) => decoration !== null);
  const wrap = typeof props.wrap === "string" ? props.wrap : "wrap";
  return {
    minWidth: 0,
    // Ink wraps Text by default; the other modes cut it to one line.
    ...(wrap === "wrap"
      ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" }
      : {
          whiteSpace: "pre",
          overflow: "hidden",
          textOverflow: wrap === "end" ? "clip" : "ellipsis",
          ...(wrap === "truncate-start" ? { direction: "rtl", textAlign: "left" } : {}),
        }),
    ...(foreground === undefined && !inverse
      ? {}
      : { color: inverse ? (background ?? "var(--background)") : foreground }),
    ...(background === undefined && !inverse
      ? {}
      : { backgroundColor: inverse ? (foreground ?? "var(--foreground)") : background }),
    ...(props.bold === true ? { fontWeight: 600 } : {}),
    ...(props.italic === true ? { fontStyle: "italic" } : {}),
    ...(props.dimColor === true ? { opacity: 0.6 } : {}),
    ...(decorations.length === 0 ? {} : { textDecoration: decorations.join(" ") }),
  };
}

/** Text styling a mod may set on a div/span/b; layout and positioning stay ours. */
const ALLOWED_DECLARATIONS = new Set([
  "color",
  "backgroundColor",
  "fontWeight",
  "fontStyle",
  "textDecoration",
  "opacity",
  "whiteSpace",
]);

/** Parses the `style` declaration string a mod put on a div/span/b. */
function declarations(value: unknown): CSSProperties {
  if (typeof value !== "string") return {};
  const style: Record<string, string> = {};
  for (const declaration of value.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator <= 0) continue;
    const property = declaration
      .slice(0, separator)
      .trim()
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const propertyValue = declaration.slice(separator + 1).trim();
    if (!ALLOWED_DECLARATIONS.has(property) || /url\(/i.test(propertyValue)) continue;
    style[property] = propertyValue;
  }
  return style as CSSProperties;
}

/** Only web links open from a mod's tree. */
function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// Block elements drawn as shapes, not glyphs: a font's block glyphs leave
// anti-aliased seams between cells, which stripes a mod's pixel art.
// Quadrant bits: 8 top-left, 4 top-right, 2 bottom-left, 1 bottom-right.
const BLOCK_QUADRANTS: Readonly<Record<string, number>> = {
  "█": 15,
  "▀": 12,
  "▄": 3,
  "▌": 10,
  "▐": 5,
  "▘": 8,
  "▝": 4,
  "▖": 2,
  "▗": 1,
  "▙": 11,
  "▛": 14,
  "▜": 13,
  "▟": 7,
  "▚": 9,
  "▞": 6,
};
const QUADRANT_POSITIONS: ReadonlyArray<readonly [number, string]> = [
  [8, "0 0"],
  [4, "100% 0"],
  [2, "0 100%"],
  [1, "100% 100%"],
];
const SOLID = "linear-gradient(currentColor, currentColor)";

/**
 * One block element, or a run of `count` identical full or half blocks, as a
 * painted box. Boxes overlap their right and bottom neighbours by half a pixel
 * so fractional cell edges never leave a seam.
 */
function blockStyle(mask: number, count: number): CSSProperties {
  const layers = QUADRANT_POSITIONS.filter(([bit]) => (mask & bit) !== 0);
  const half = "calc(50% + 0.5px)";
  return {
    display: "inline-block",
    width: `calc(${count}ch + 0.5px)`,
    marginRight: "-0.5px",
    height: "calc(1lh + 0.5px)",
    marginBottom: "-0.5px",
    verticalAlign: "top",
    backgroundImage: layers.map(() => SOLID).join(", "),
    backgroundPosition: layers.map(([, position]) => position).join(", "),
    backgroundSize: count === 1 ? `${half} ${half}` : mask === 15 ? "100% 100%" : `100% ${half}`,
    backgroundRepeat: "no-repeat",
  };
}

/** Full and half blocks look the same at any width, so their runs draw as one box. */
const MERGEABLE_MASKS = new Set([15, 12, 3]);

/** Draws a string, painting block elements as boxes and everything else as text. */
function renderText(text: string, key: string): ReactNode {
  const chars = [...text];
  if (!chars.some((char) => char in BLOCK_QUADRANTS)) return text;
  const parts: ReactNode[] = [];
  let plain = "";
  for (let index = 0; index < chars.length;) {
    const char = chars[index] as string;
    const mask = BLOCK_QUADRANTS[char];
    if (mask === undefined) {
      plain += char;
      index += 1;
      continue;
    }
    if (plain !== "") {
      parts.push(plain);
      plain = "";
    }
    let count = 1;
    if (MERGEABLE_MASKS.has(mask)) while (chars[index + count] === char) count += 1;
    parts.push(<span key={index} aria-hidden style={blockStyle(mask, count)} />);
    index += count;
  }
  if (plain !== "") parts.push(plain);
  return (
    <span key={key} className="whitespace-pre">
      {parts}
    </span>
  );
}

function useTree(): TreeContextValue {
  const tree = useContext(TreeContext);
  if (tree === null) throw new Error("A mod element was drawn outside a ModTree.");
  return tree;
}

/**
 * The element's props with its `hover` overrides applied while the pointer is
 * over the nearest keyed Box (`ownHover` for a keyed Box itself), or over any
 * member of the hover group it names; plus the handlers that light that group.
 */
function useHover(node: ModElement, ownHover?: boolean) {
  const { surface } = useTree();
  const inheritedHover = useContext(HoverScopeContext);
  const scope = typeof node.hover?.scope === "string" ? node.hover.scope : undefined;
  const group = scope === undefined ? undefined : `${node.group?.plugin ?? ""}\u0000${scope}`;
  const isGroupLit = useSyncExternalStore(surface.onGroupChange, () =>
    group === undefined ? false : surface.isGroupLit(group),
  );
  const isOver = useRef(false);
  useEffect(
    () => () => {
      if (group !== undefined && isOver.current) surface.hoverGroup(group, false);
    },
    [group, surface],
  );
  const isActive = group === undefined ? (ownHover ?? inheritedHover) : isGroupLit;
  const props = useMemo(() => {
    const base = node.props ?? {};
    if (node.hover === undefined || !isActive) return base;
    const { scope: _scope, ...overrides } = node.hover;
    return { ...base, ...overrides };
  }, [isActive, node.hover, node.props]);
  const setGroupHover = (next: boolean) => {
    if (group === undefined || isOver.current === next) return;
    isOver.current = next;
    surface.hoverGroup(group, next);
  };
  return { props, setGroupHover, hasGroup: group !== undefined };
}

/** Draws a node's children in order. */
function Children(props: {
  readonly nodes: ReadonlyArray<ModChild> | undefined;
  readonly path: string;
}): ReactNode {
  // A mod's tree is positional: children carry no ids unless they are keyed.
  return props.nodes?.map((child, index) => {
    const path = `${props.path}.${index}`;
    if (typeof child === "string") return renderText(child, path);
    const key = typeof child.props?.key === "string" ? `key:${child.props.key}` : path;
    return <Node key={key} node={child} path={path} />;
  });
}

function BoxNode(props: { readonly node: ModElement; readonly path: string }) {
  const { node } = props;
  const [isHovered, setIsHovered] = useState(false);
  const inheritedHover = useContext(HoverScopeContext);
  const key = typeof node.props?.key === "string" ? node.props.key : undefined;
  // A keyed Box scopes its own hover and that of everything beneath it.
  const isScope = key !== undefined;
  const hover = useHover(node, isScope ? isHovered : undefined);
  const style = useMemo(() => boxStyle(hover.props), [hover.props]);
  const tracksPointer = isScope || hover.hasGroup;
  return (
    <div
      style={style}
      {...(isScope ? { [MOD_KEY_ATTRIBUTE]: key } : {})}
      {...(tracksPointer
        ? {
            onPointerEnter: () => {
              if (isScope) setIsHovered(true);
              hover.setGroupHover(true);
            },
            onPointerLeave: () => {
              if (isScope) setIsHovered(false);
              hover.setGroupHover(false);
            },
          }
        : {})}
    >
      <HoverScopeContext.Provider value={isScope ? isHovered : inheritedHover}>
        <Children nodes={node.children} path={props.path} />
      </HoverScopeContext.Provider>
    </div>
  );
}

function TextNode(props: { readonly node: ModElement; readonly path: string }) {
  const hover = useHover(props.node);
  return (
    <span
      style={textStyle(hover.props)}
      {...(hover.hasGroup
        ? {
            onPointerEnter: () => hover.setGroupHover(true),
            onPointerLeave: () => hover.setGroupHover(false),
          }
        : {})}
    >
      <Children nodes={props.node.children} path={props.path} />
    </span>
  );
}

/** Sends an element's press, input or pick, and redraws its instance when the handle went stale. */
function useElementOperation() {
  const { surface, component, instanceId } = useTree();
  return async (operation: Parameters<ModSurface["operate"]>[0]) => {
    // A press says where its element sits, so the mod finds it by key when a
    // redraw retired the handle while the click was on its way.
    const response = await surface.operate(
      operation.op === "press" ? { ...operation, component, instanceId } : operation,
    );
    const handled =
      typeof response === "object" && response !== null && "handled" in response
        ? response.handled
        : undefined;
    // The tree this window holds is not the mod's any more.
    if (handled === false) surface.refresh(component, instanceId);
  };
}

function ButtonNode(props: { readonly node: ModElement }) {
  const { node } = props;
  const hoverProps = useHover(node).props;
  const operate = useElementOperation();
  const label = typeof hoverProps.label === "string" ? hoverProps.label : "";
  const key = typeof hoverProps.key === "string" ? hoverProps.key : undefined;
  const hotkey = typeof hoverProps.hotkey === "string" ? hoverProps.hotkey : undefined;
  const target = node.press;
  const press = () => {
    if (target === undefined) return;
    void operate({ op: "press", ...target, ...(key === undefined ? {} : { key }) });
  };
  const attributes = {
    [MOD_KEY_ATTRIBUTE]: key,
    [MOD_PLUGIN_ATTRIBUTE]: target?.plugin,
    [MOD_HOTKEY_ATTRIBUTE]: hotkey,
    [MOD_AUTOFOCUS_ATTRIBUTE]: hoverProps.autoFocus === true ? "" : undefined,
  };
  const dim = hoverProps.dimColor === true ? { opacity: 0.6 } : undefined;
  if (hoverProps.plain === true) {
    // A plain Button is text that presses: the label, or `hotkey: label`.
    return (
      <button
        type="button"
        disabled={target === undefined}
        onClick={press}
        className="cursor-pointer whitespace-pre rounded-sm outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring"
        style={{ ...textStyle(hoverProps), ...dim }}
        {...attributes}
      >
        {hotkey === undefined ? label : `${hotkey}: ${label}`}
      </button>
    );
  }
  if (hoverProps.role === "dismiss") {
    // The Button that closes its site draws as the app's close control.
    return (
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={label}
        disabled={target === undefined}
        onClick={press}
        {...attributes}
      >
        <XIcon />
      </Button>
    );
  }
  return (
    <Button
      size="xs"
      variant={hoverProps.variant === "primary" ? "default" : "outline"}
      disabled={target === undefined}
      onClick={press}
      style={dim}
      {...attributes}
    >
      {label}
    </Button>
  );
}

function InputNode(props: { readonly node: ModElement }) {
  const { node } = props;
  const { surface, component, instanceId } = useTree();
  const nodeProps = node.props ?? {};
  const drawn = typeof nodeProps.value === "string" ? nodeProps.value : "";
  const key = typeof nodeProps.key === "string" ? nodeProps.key : undefined;
  // `sent` holds texts sent and not yet drawn back: a redraw carrying one is an
  // echo of an older keystroke and must not overwrite what was typed since.
  const [field, setField] = useState({ text: drawn, drawn, sent: [] as ReadonlyArray<string> });
  if (drawn !== field.drawn) {
    const echo = field.sent.indexOf(drawn);
    setField(
      echo >= 0
        ? { ...field, drawn, sent: field.sent.slice(echo + 1) }
        : { text: drawn, drawn, sent: [] },
    );
  }
  const text = field.text;
  // One input at a time, so typing reaches the mod in order. Changes that
  // pile up behind the one in flight fold into the newest; a submit never folds.
  const queueRef = useRef({
    busy: false,
    waiting: [] as Array<{ kind: "change" | "submit"; value: string; run: () => Promise<void> }>,
    isMounted: true,
  });
  useEffect(() => {
    const queue = queueRef.current;
    queue.isMounted = true;
    return () => {
      queue.isMounted = false;
      queue.waiting.length = 0;
    };
  }, []);
  const send = (kind: "change" | "submit", value: string) => {
    const target = node.press;
    if (target === undefined) return;
    const queue = queueRef.current;
    // Bound now: an input queued behind another never reaches a later session.
    const operate = surface.bind();
    const run = async () => {
      if (!queue.isMounted) return;
      // Marked when it really leaves, so only texts the mod will see count as echoes.
      setField((current) => ({ ...current, sent: [...current.sent.slice(-63), value] }));
      const response = await operate({
        op: "input",
        ...target,
        kind,
        value,
        component,
        instanceId,
        ...(key === undefined ? {} : { key }),
      });
      const handled =
        typeof response === "object" && response !== null && "handled" in response
          ? response.handled
          : undefined;
      if (handled === false) surface.refresh(component, instanceId);
      // A field the mod does not hold the text of starts empty again once sent.
      if (kind === "submit" && typeof nodeProps.value !== "string") {
        setField({ text: "", drawn: "", sent: [] });
      }
    };
    const pump = async () => {
      queue.busy = true;
      for (let job = queue.waiting.shift(); job !== undefined; job = queue.waiting.shift()) {
        await job.run();
      }
      queue.busy = false;
    };
    const last = queue.waiting.at(-1);
    if (kind === "change" && last?.kind === "change")
      queue.waiting[queue.waiting.length - 1] = { kind, value, run };
    else queue.waiting.push({ kind, value, run });
    if (!queue.busy) void pump();
  };
  const label = typeof nodeProps.label === "string" ? nodeProps.label : undefined;
  const submitLabel = typeof nodeProps.submitLabel === "string" ? nodeProps.submitLabel : undefined;
  return (
    <label className="flex min-w-0 flex-1 items-center gap-2">
      {label === undefined ? null : <span className="shrink-0 whitespace-pre">{label}</span>}
      <Input
        size="compact"
        font="mono"
        value={text}
        placeholder={typeof nodeProps.placeholder === "string" ? nodeProps.placeholder : undefined}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setField((current) => ({ ...current, text: value }));
          send("change", value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send("submit", event.currentTarget.value);
        }}
        {...{
          [MOD_KEY_ATTRIBUTE]: key,
          [MOD_PLUGIN_ATTRIBUTE]: node.press?.plugin,
          [MOD_AUTOFOCUS_ATTRIBUTE]: nodeProps.autoFocus === true ? "" : undefined,
        }}
      />
      {submitLabel === undefined ? null : (
        <Button size="xs" variant="outline" onClick={() => send("submit", text)}>
          {submitLabel}
        </Button>
      )}
    </label>
  );
}

function SelectNode(props: { readonly node: ModElement }) {
  const { node } = props;
  const { component, instanceId } = useTree();
  const operate = useElementOperation();
  const nodeProps = node.props ?? {};
  const key = typeof nodeProps.key === "string" ? nodeProps.key : undefined;
  const options = (Array.isArray(nodeProps.options) ? nodeProps.options : []).flatMap(
    (option: unknown) =>
      typeof option === "object" &&
      option !== null &&
      "value" in option &&
      typeof option.value === "string"
        ? [
            {
              value: option.value,
              label:
                "label" in option && typeof option.label === "string" ? option.label : option.value,
            },
          ]
        : [],
  );
  const label = typeof nodeProps.label === "string" ? nodeProps.label : undefined;
  return (
    <label className="flex min-w-0 items-center gap-2">
      {label === undefined ? null : <span className="shrink-0 whitespace-pre">{label}</span>}
      <Select
        value={typeof nodeProps.value === "string" ? nodeProps.value : null}
        items={Object.fromEntries(options.map((option) => [option.value, option.label]))}
        onValueChange={(value) => {
          const target = node.press;
          if (target === undefined || typeof value !== "string") return;
          void operate({
            op: "select",
            ...target,
            value,
            component,
            instanceId,
            ...(key === undefined ? {} : { key }),
          });
        }}
      >
        <SelectTrigger
          size="xs"
          {...{
            [MOD_KEY_ATTRIBUTE]: key,
            [MOD_PLUGIN_ATTRIBUTE]: node.press?.plugin,
            [MOD_AUTOFOCUS_ATTRIBUTE]: nodeProps.autoFocus === true ? "" : undefined,
          }}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </label>
  );
}

function MarkdownNode(props: { readonly node: ModElement }) {
  const { node } = props;
  const { cwd } = useTree();
  const operate = useElementOperation();
  const nodeProps = node.props ?? {};
  const target = node.press;
  const key = typeof nodeProps.key === "string" ? nodeProps.key : undefined;
  const pressableLinks = Array.isArray(nodeProps.pressableLinks)
    ? nodeProps.pressableLinks.filter((link): link is string => typeof link === "string")
    : undefined;
  return (
    <ModMarkdown
      text={typeof nodeProps.text === "string" ? nodeProps.text : ""}
      cwd={cwd}
      dimColor={nodeProps.dimColor === true}
      {...(pressableLinks === undefined ? {} : { pressableLinks })}
      {...(target === undefined
        ? {}
        : {
            onLinkPress: (href: string) =>
              void operate({
                op: "press",
                ...target,
                href,
                ...(key === undefined ? {} : { key }),
              }),
          })}
    />
  );
}

/**
 * A mod's own page, for what the elements cannot draw: a game, a chart that
 * moves. It runs in a frame with no origin, takes the keyboard while focused,
 * and talks to its mod only through messages.
 */
function FrameNode(props: { readonly node: ModElement }) {
  const { node } = props;
  const { surface, component, instanceId } = useTree();
  const nodeProps = node.props ?? {};
  const frameRef = useRef<HTMLIFrameElement>(null);
  const html = typeof nodeProps.html === "string" ? nodeProps.html : "";
  const key = typeof nodeProps.key === "string" ? nodeProps.key : "";
  const page = useMemo(() => modFrameDocument(html), [html]);

  const onPageMessage = useEffectEvent((event: MessageEvent) => {
    if (event.source !== frameRef.current?.contentWindow || node.press === undefined) return;
    const message = readModFrameMessage(event.data);
    if (message === undefined) return;
    if ("leave" in message) {
      // The same Escape the pane's other elements bubble: its site returns the keyboard.
      frameRef.current?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      return;
    }
    void surface.operate({
      op: "message",
      ...node.press,
      key,
      component,
      instanceId,
      data: message.data,
    });
  });
  useEffect(() => {
    window.addEventListener("message", onPageMessage);
    return () => window.removeEventListener("message", onPageMessage);
  }, []);

  const onCommand = useEffectEvent((command: ModSiteCommand) => {
    if (
      command.kind !== "post" ||
      command.component !== component ||
      command.instanceId !== instanceId ||
      command.key !== key ||
      command.plugin !== node.press?.plugin
    ) {
      return;
    }
    frameRef.current?.contentWindow?.postMessage(
      { [MOD_FRAME_MESSAGE]: true, data: command.data },
      "*",
    );
  });
  useEffect(() => surface.onCommand(onCommand), [surface]);

  return (
    <iframe
      ref={frameRef}
      className="block w-full border-0 bg-transparent"
      style={{ height: typeof nodeProps.height === "number" ? nodeProps.height : 360 }}
      // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
      sandbox="allow-scripts"
      srcDoc={page}
      title={key}
      {...{ [MOD_AUTOFOCUS_ATTRIBUTE]: nodeProps.autoFocus === true ? "" : undefined }}
      onLoad={nodeProps.autoFocus === true ? () => frameRef.current?.focus() : undefined}
    />
  );
}

/** Draws one node of a mod's tree; unknown types draw nothing. */
function Node(props: { readonly node: ModElement; readonly path: string }): ReactNode {
  const { node, path } = props;
  const nodeProps = node.props ?? {};
  switch (node.type) {
    case "Box":
      return <BoxNode node={node} path={path} />;
    case "Text":
      return <TextNode node={node} path={path} />;
    case "div":
    case "span":
    case "b": {
      const Tag = node.type;
      return (
        <Tag style={declarations(nodeProps.style)}>
          <Children nodes={node.children} path={path} />
        </Tag>
      );
    }
    case "Button":
      return <ButtonNode node={node} />;
    case "Input":
      return <InputNode node={node} />;
    case "Select":
      return <SelectNode node={node} />;
    case "Link": {
      const href = safeHref(nodeProps.href);
      const hasChildren = node.children !== undefined && node.children.length > 0;
      return (
        <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {hasChildren ? (
            <Children nodes={node.children} path={path} />
          ) : typeof nodeProps.label === "string" ? (
            nodeProps.label
          ) : (
            href
          )}
        </a>
      );
    }
    case "Code":
      return (
        <ModCode
          source={typeof nodeProps.source === "string" ? nodeProps.source : ""}
          {...(typeof nodeProps.language === "string" ? { language: nodeProps.language } : {})}
          {...(typeof nodeProps.path === "string" ? { path: nodeProps.path } : {})}
          {...(typeof nodeProps.startLine === "number" ? { startLine: nodeProps.startLine } : {})}
          {...(nodeProps.format === "diff" || nodeProps.format === "source"
            ? { format: nodeProps.format }
            : {})}
          {...(nodeProps.wrap === "wrap" || nodeProps.wrap === "truncate-end"
            ? { wrap: nodeProps.wrap }
            : {})}
        />
      );
    case "Markdown":
      return <MarkdownNode node={node} />;
    case "Frame":
      return <FrameNode node={node} />;
    case "Svg":
      return (
        <ModSvg
          source={typeof nodeProps.source === "string" ? nodeProps.source : ""}
          alt={typeof nodeProps.alt === "string" ? nodeProps.alt : ""}
          {...(typeof nodeProps.width === "number" ? { width: nodeProps.width } : {})}
          {...(typeof nodeProps.height === "number" ? { height: nodeProps.height } : {})}
          {...(nodeProps.isInteractive === true ? { isInteractive: true } : {})}
        />
      );
    default:
      return null;
  }
}

/** Draws a mod's render tree for one component instance. */
export function ModTree(props: {
  readonly tree: ModElement;
  readonly surface: ModSurface;
  readonly component: ModComponent;
  readonly instanceId: string;
  readonly cwd: string | undefined;
}) {
  const { surface, component, instanceId, cwd } = props;
  const context = useMemo(
    () => ({ surface, component, instanceId, cwd }),
    [surface, component, instanceId, cwd],
  );
  return (
    <TreeContext.Provider value={context}>
      <Node node={props.tree} path="root" />
    </TreeContext.Provider>
  );
}
