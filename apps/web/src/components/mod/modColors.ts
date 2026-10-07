/**
 * The theme keys a mod may name, each as the app token that plays that role, so a
 * mod's colors follow the person's T3 Code theme.
 */
const THEME_KEY_COLORS = new Map(
  Object.entries({
    text: "var(--contrast-foreground)",
    inverseText: "var(--background)",
    inactive: "var(--contrast-muted-foreground)",
    subtle: "color-mix(in srgb, var(--contrast-muted-foreground) 60%, transparent)",
    accent: "var(--primary)",
    suggestion: "var(--primary)",
    info: "var(--info)",
    success: "var(--success)",
    error: "var(--destructive)",
    warning: "var(--warning)",
    border: "var(--contrast-border)",
    // The diff keys are backgrounds: a line's tint, a fainter one, and a
    // stronger one behind the words that changed.
    diffAdded: "color-mix(in srgb, var(--diff-addition) 28%, transparent)",
    diffRemoved: "color-mix(in srgb, var(--diff-deletion) 28%, transparent)",
    diffAddedDimmed: "color-mix(in srgb, var(--diff-addition) 14%, transparent)",
    diffRemovedDimmed: "color-mix(in srgb, var(--diff-deletion) 14%, transparent)",
    diffAddedWord: "color-mix(in srgb, var(--diff-addition) 50%, transparent)",
    diffRemovedWord: "color-mix(in srgb, var(--diff-deletion) 50%, transparent)",
  }),
);

/**
 * The sixteen named terminal colors as [light, dark]. The app's terminal has no palette
 * of its own to follow, so these are fixed pairs that stay readable on either canvas.
 */
const ANSI_COLOR_PAIRS = {
  black: ["#24292f", "#484f58"],
  red: ["#cf222e", "#ff7b72"],
  green: ["#116329", "#3fb950"],
  yellow: ["#9a6700", "#d29922"],
  blue: ["#0969da", "#58a6ff"],
  magenta: ["#8250df", "#bc8cff"],
  cyan: ["#1b7c83", "#39c5cf"],
  white: ["#6e7781", "#b1bac4"],
  blackbright: ["#57606a", "#6e7681"],
  redbright: ["#a40e26", "#ffa198"],
  greenbright: ["#1a7f37", "#56d364"],
  yellowbright: ["#bf8700", "#e3b341"],
  bluebright: ["#218bff", "#79c0ff"],
  magentabright: ["#a475f9", "#d2a8ff"],
  cyanbright: ["#3192aa", "#56d4dd"],
  whitebright: ["#8c959f", "#f0f6fc"],
} as const;

const ANSI_COLORS = new Map<string, string>(
  Object.entries(ANSI_COLOR_PAIRS).map(([name, [light, dark]]) => [
    name,
    `light-dark(${light}, ${dark})`,
  ]),
);
// Ink's two spellings of bright black.
ANSI_COLORS.set("gray", ANSI_COLORS.get("blackbright")!);
ANSI_COLORS.set("grey", ANSI_COLORS.get("blackbright")!);

/** The CSS named colors the terminal names above do not already answer. */
const CSS_COLOR_NAMES = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque blanchedalmond blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson darkblue " +
    "darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen " +
    "darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray " +
    "darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
    "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod greenyellow " +
    "honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon " +
    "lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink " +
    "lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue " +
    "lightyellow lime limegreen linen maroon mediumaquamarine mediumblue mediumorchid " +
    "mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
    "mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred " +
    "papayawhip peachpuff peru pink plum powderblue purple rebeccapurple rosybrown royalblue " +
    "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray " +
    "slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat " +
    "whitesmoke yellowgreen"
  ).split(" "),
);

const XTERM_SYSTEM_COLORS = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
] as const;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
const ANSI_256_COLOR = /^ansi256\(\s*(\d{1,3})\s*\)$/;
const ANSI_NAMED_COLOR = /^ansi:([a-z]+)$/i;
const COLOR_NAME = /^[a-z]+$/i;

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** An xterm 256-color index as hex: 16 system colors, a 6×6×6 cube, then 24 grays. */
function xterm256Color(index: number): string | undefined {
  if (index > 255) return undefined;
  if (index < 16) return XTERM_SYSTEM_COLORS[index];
  if (index >= 232) {
    const gray = hexByte(8 + 10 * (index - 232));
    return `#${gray}${gray}${gray}`;
  }
  const cube = index - 16;
  const level = (step: number) => hexByte(step === 0 ? 0 : 55 + 40 * step);
  return `#${level(Math.floor(cube / 36))}${level(Math.floor(cube / 6) % 6)}${level(cube % 6)}`;
}

/**
 * A mod's color as a CSS color for an inline `style`: a theme key, which
 * follows the app theme, or a raw color (a terminal or CSS name, `#rgb`/`#rrggbb`,
 * `rgb(r,g,b)`, `ansi256(n)`, `ansi:red`). Only what one of those forms spells exactly
 * comes back; anything else is `undefined`, so no mod text reaches the style unparsed.
 */
export function resolveModColor(color: unknown): string | undefined {
  if (typeof color !== "string") return undefined;
  const value = color.trim();
  if (value.length === 0 || value.length > 64) return undefined;

  const themed = THEME_KEY_COLORS.get(value);
  if (themed) return themed;

  if (HEX_COLOR.test(value)) return value.toLowerCase();

  const rgb = RGB_COLOR.exec(value);
  if (rgb) {
    const channels = rgb.slice(1).map(Number);
    return channels.every((channel) => channel <= 255) ? `rgb(${channels.join(", ")})` : undefined;
  }

  const ansi256 = ANSI_256_COLOR.exec(value);
  if (ansi256) return xterm256Color(Number(ansi256[1]));

  const ansiNamed = ANSI_NAMED_COLOR.exec(value);
  if (ansiNamed?.[1]) return ANSI_COLORS.get(ansiNamed[1].toLowerCase());

  if (!COLOR_NAME.test(value)) return undefined;
  const name = value.toLowerCase();
  return ANSI_COLORS.get(name) ?? (CSS_COLOR_NAMES.has(name) ? name : undefined);
}
