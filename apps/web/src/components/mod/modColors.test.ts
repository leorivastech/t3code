import { describe, expect, it } from "vite-plus/test";

import { resolveModColor } from "./modColors";

const THEME_KEYS = [
  "text",
  "inverseText",
  "inactive",
  "subtle",
  "accent",
  "suggestion",
  "info",
  "success",
  "error",
  "warning",
  "border",
  "diffAdded",
  "diffRemoved",
  "diffAddedDimmed",
  "diffRemovedDimmed",
  "diffAddedWord",
  "diffRemovedWord",
];

describe("resolveModColor", () => {
  it.each(THEME_KEYS)("resolves the theme key %s", (key) => {
    expect(resolveModColor(key)).toEqual(expect.any(String));
  });

  it.each([
    ["text", "var(--contrast-foreground)"],
    ["inverseText", "var(--background)"],
    ["inactive", "var(--contrast-muted-foreground)"],
    ["suggestion", "var(--primary)"],
    ["success", "var(--success)"],
    ["error", "var(--destructive)"],
    ["warning", "var(--warning)"],
    ["border", "var(--contrast-border)"],
    ["diffAdded", "color-mix(in srgb, var(--diff-addition) 28%, transparent)"],
    ["diffRemoved", "color-mix(in srgb, var(--diff-deletion) 28%, transparent)"],
    ["accent", "var(--primary)"],
  ])("maps the theme key %s onto the app theme", (key, expected) => {
    expect(resolveModColor(key)).toBe(expected);
  });

  it.each([
    ["#fff", "#fff"],
    ["#1A2b3C", "#1a2b3c"],
    [" #1a2b3c ", "#1a2b3c"],
    ["rgb(1,2,3)", "rgb(1, 2, 3)"],
    ["rgb( 255 , 0 , 128 )", "rgb(255, 0, 128)"],
    ["ansi256(0)", "#000000"],
    ["ansi256(9)", "#ff0000"],
    ["ansi256(15)", "#ffffff"],
    ["ansi256(16)", "#000000"],
    ["ansi256(21)", "#0000ff"],
    ["ansi256(208)", "#ff8700"],
    ["ansi256(231)", "#ffffff"],
    ["ansi256(232)", "#080808"],
    ["ansi256(255)", "#eeeeee"],
    ["orange", "orange"],
    ["RebeccaPurple", "rebeccapurple"],
  ])("resolves the raw color %s", (color, expected) => {
    expect(resolveModColor(color)).toBe(expected);
  });

  it("gives each terminal color one value per appearance", () => {
    const red = resolveModColor("red");
    expect(red).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
    expect(resolveModColor("ansi:red")).toBe(red);
    expect(resolveModColor("RED")).toBe(red);

    const brightRed = resolveModColor("redBright");
    expect(brightRed).toMatch(/^light-dark\(/);
    expect(brightRed).not.toBe(red);
    expect(resolveModColor("ansi:redBright")).toBe(brightRed);

    const gray = resolveModColor("blackBright");
    expect(resolveModColor("gray")).toBe(gray);
    expect(resolveModColor("grey")).toBe(gray);
  });

  it.each(
    ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].flatMap((name) => [
      name,
      `${name}Bright`,
      `ansi:${name}`,
      `ansi:${name}Bright`,
    ]),
  )("resolves the terminal color %s", (name) => {
    expect(resolveModColor(name)).toMatch(/^light-dark\(/);
  });

  it.each([
    [undefined],
    [null],
    [0xff0000],
    [{ color: "red" }],
    [""],
    ["   "],
    ["notacolor"],
    ["Text"],
    ["constructor"],
    ["__proto__"],
    ["#12"],
    ["#12345"],
    ["#1234567"],
    ["#ggg"],
    ["rgb(256,0,0)"],
    ["rgb(1,2)"],
    ["rgb(1 2 3)"],
    ["rgba(1,2,3,0.5)"],
    ["ansi256(256)"],
    ["ansi256(-1)"],
    ["ansi256(1.5)"],
    ["ansi:orange"],
    ["ansi:"],
    ["var(--background)"],
    ["url(https://example.com/x.png)"],
    ["red; background: url(https://example.com)"],
    ["red;"],
    ["red !important"],
    ["expression(alert(1))"],
    ["light-dark(red, blue)"],
    ["color-mix(in srgb, red, blue)"],
    ["#fff\n;position:fixed"],
    ["red".repeat(40)],
  ])("rejects %j", (color) => {
    expect(resolveModColor(color)).toBeUndefined();
  });
});
