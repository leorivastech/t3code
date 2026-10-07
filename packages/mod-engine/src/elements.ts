import type { ModElement, ModSurface } from "./protocol.ts";

/**
 * The elements a mod builds its trees from, and the pass that turns what a
 * hook returned into the plain-data tree a host draws.
 */

/** A node as a hook builds it: props may still hold closures. */
export interface DraftElement {
  readonly isModElement: true;
  readonly type: string;
  readonly plugin: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: ReadonlyArray<unknown>;
}

/** The handlers of one drawn Button, Input, Select or Markdown, by handle. */
export interface HeldElement {
  readonly plugin: string;
  readonly key: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
}

const ELEMENTS_BY_SURFACE: Readonly<Record<ModSurface, ReadonlyArray<string>>> = {
  terminal: ["Box", "Text", "Button", "Input", "Select", "Link", "Code", "Markdown"],
  desktop: ["Box", "Text", "Button", "Input", "Select", "Svg", "Link", "Code", "Markdown", "Frame"],
  vscode: ["Box", "Text", "Button", "Input", "Select", "Svg", "Link", "Code", "Markdown"],
  mobile: ["Box", "Text", "Button", "Svg", "Link", "Code", "Markdown"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDraft = (value: unknown): value is DraftElement =>
  isRecord(value) && value.isModElement === true && typeof value.type === "string";

/** The node that marks where the host draws its own component. */
export const engineNode = (ref: number): ModElement => ({ type: "engine", ref });

const isEngineNode = (value: unknown): value is ModElement =>
  isRecord(value) && value.type === "engine" && typeof value.ref === "number";

/**
 * The element table of one surface for one plugin: what `$.ui.resolve(e)`
 * hands a hook. Each constructor stamps the plugin, so a press finds its way
 * back to the mod that drew the element.
 */
export function elementsFor(
  surface: ModSurface,
  plugin: string,
): Readonly<Record<string, (props?: Record<string, unknown> | null) => DraftElement>> {
  const table: Record<string, (props?: Record<string, unknown> | null) => DraftElement> = {};
  for (const type of ELEMENTS_BY_SURFACE[surface]) {
    table[type] = (props) => {
      const { children, ...rest } = props ?? {};
      return {
        isModElement: true,
        type,
        plugin,
        props: rest,
        children: children === undefined ? [] : Array.isArray(children) ? children : [children],
      };
    };
  }
  return table;
}

/** The JSX factory a hooks module is compiled against. */
export function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
  if (typeof type !== "function") {
    throw new Error("A mod's JSX element must come from $.ui.resolve(e), as in <Box>.");
  }
  return (type as (props: Record<string, unknown>) => unknown)(
    children.length === 0 ? { ...props } : { ...props, children },
  );
}

/** `<>...</>`: a column, as the terminal stacks what a hook returns. */
export function Fragment(props: { readonly children?: unknown }) {
  return {
    isModElement: true,
    type: "Box",
    plugin: "",
    props: { flexDirection: "column" },
    children:
      props.children === undefined
        ? []
        : Array.isArray(props.children)
          ? props.children
          : [props.children],
  } satisfies DraftElement;
}

const pick = (props: Readonly<Record<string, unknown>>, names: ReadonlyArray<string>) => {
  const picked: Record<string, unknown> = {};
  for (const name of names) {
    const value = props[name];
    if (value !== undefined && typeof value !== "function") picked[name] = value;
  }
  return picked;
};

/** A plain-data copy of a mod's value: no closures, no cycles past `depth`. */
const plain = (value: unknown, depth = 0): unknown => {
  if (depth > 16 || typeof value === "function" || typeof value === "symbol") return undefined;
  if (Array.isArray(value)) return value.map((entry) => plain(entry, depth + 1));
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const copied = plain(entry, depth + 1);
      if (copied !== undefined) copy[key] = copied;
    }
    return copy;
  }
  return value;
};

/**
 * Turns what a `ui.render` hook returned into the tree a host draws. Every
 * Button, Input, Select and pressable Markdown is given a handle through
 * `hold`, which keeps its closures on the engine's side.
 */
export function exportTree(
  value: unknown,
  fallbackPlugin: string,
  hold: (element: HeldElement) => number,
): ModElement {
  const children = (nodes: ReadonlyArray<unknown>, plugin: string) => {
    const out: Array<string | ModElement> = [];
    const visit = (node: unknown) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) {
        for (const entry of node) visit(entry);
      } else if (typeof node === "string") {
        out.push(node);
      } else if (typeof node === "number" || typeof node === "bigint") {
        out.push(String(node));
      } else {
        out.push(element(node, plugin));
      }
    };
    visit(nodes);
    return out;
  };

  const element = (node: unknown, inherited: string): ModElement => {
    if (isEngineNode(node)) return node;
    if (!isDraft(node)) {
      throw new Error("A ui.render hook must return elements from $.ui.resolve(e), or next(e).");
    }
    const plugin = node.plugin === "" ? inherited : node.plugin;
    const { props } = node;
    const hover = isRecord(props.hover) ? (plain(props.hover) as Record<string, unknown>) : null;
    const hoverFields = {
      ...(hover === null ? {} : { hover }),
      ...(hover !== null && typeof hover.scope === "string" ? { group: { plugin } } : {}),
    };
    const kids = children(node.children, plugin);
    switch (node.type) {
      case "Box":
      case "Text": {
        const { hover: _hover, ...rest } = props;
        const plainProps = plain(rest) as Record<string, unknown>;
        return {
          type: node.type,
          ...(Object.keys(plainProps).length === 0 ? {} : { props: plainProps }),
          ...hoverFields,
          ...(kids.length === 0 ? {} : { children: kids }),
        };
      }
      case "Button": {
        const childLabel = kids.length === 1 && typeof kids[0] === "string" ? kids[0] : undefined;
        const label = typeof props.label === "string" ? props.label : (childLabel ?? "");
        const key = typeof props.key === "string" ? props.key : label;
        const drawn = {
          key,
          label,
          ...pick(props, ["hotkey", "action", "plain", "dimColor", "variant", "role", "autoFocus"]),
        };
        return {
          type: "Button",
          props: drawn,
          press: { plugin, handle: hold({ plugin, key, type: "Button", props }) },
          ...hoverFields,
        };
      }
      case "Input":
      case "Select": {
        const key = typeof props.key === "string" ? props.key : node.type.toLowerCase();
        const names =
          node.type === "Input"
            ? ["label", "placeholder", "value", "submitLabel", "autoFocus"]
            : ["label", "options", "value", "autoFocus"];
        return {
          type: node.type,
          props: { key, ...(plain(pick(props, names)) as Record<string, unknown>) },
          press: { plugin, handle: hold({ plugin, key, type: node.type, props }) },
        };
      }
      case "Markdown": {
        const drawn = plain(pick(props, ["key", "text", "dimColor", "pressableLinks"])) as Record<
          string,
          unknown
        >;
        const key = typeof props.key === "string" ? props.key : undefined;
        return typeof props.onLinkPress === "function" && key !== undefined
          ? {
              type: "Markdown",
              props: drawn,
              press: { plugin, handle: hold({ plugin, key, type: "Markdown", props }) },
            }
          : { type: "Markdown", props: drawn };
      }
      case "Frame": {
        // A page of the mod's own, run apart from the app: only its text crosses.
        if (typeof props.key !== "string" || typeof props.html !== "string") {
          throw new Error("A Frame needs a key and its page as html.");
        }
        const { key } = props;
        return {
          type: "Frame",
          props: { key, ...(plain(pick(props, ["html", "height", "autoFocus"])) as object) },
          press: { plugin, handle: hold({ plugin, key, type: "Frame", props }) },
        };
      }
      case "Link":
        return {
          type: "Link",
          props: plain(pick(props, ["href", "label"])) as Record<string, unknown>,
          ...(kids.length === 0 ? {} : { children: kids }),
        };
      default:
        // Code, Svg and anything a later surface adds: plain props, no children.
        return { type: node.type, props: plain(props) as Record<string, unknown> };
    }
  };

  return element(value, fallbackPlugin);
}
