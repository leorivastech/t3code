import { describe, expect, it } from "vite-plus/test";

import { fillModPrompt, matchModCommand, withModSlashCommands } from "./modComposer";

const pets = { name: "pets", description: "Open the pets pane", plugin: "pets" };
const feed = { name: "feed", description: "", argumentHint: "<pet>", plugin: "pets" };

describe("matchModCommand", () => {
  it("matches a message whose first word is a mod's command and trims its arguments", () => {
    expect(matchModCommand("/pets", [pets, feed])).toEqual({ command: pets, args: "" });
    expect(matchModCommand("  /feed  the cat \n now  ", [pets, feed])).toEqual({
      command: feed,
      args: "the cat \n now",
    });
  });

  it("leaves every other message to the provider", () => {
    expect(matchModCommand("/compact", [pets])).toBeNull();
    expect(matchModCommand("/petshop", [pets])).toBeNull();
    expect(matchModCommand("/Pets", [pets])).toBeNull();
    expect(matchModCommand("run /pets", [pets])).toBeNull();
    expect(matchModCommand("/ pets", [pets])).toBeNull();
    expect(matchModCommand("", [pets])).toBeNull();
  });
});

describe("withModSlashCommands", () => {
  it("offers the mods' commands beside the provider's", () => {
    const provided = [{ name: "compact", description: "Compact the conversation" }];
    expect(withModSlashCommands(provided, [])).toBe(provided);
    expect(withModSlashCommands(provided, [pets, feed])).toEqual([
      provided[0],
      { name: "pets", description: "Open the pets pane" },
      { name: "feed", description: "pets mod", input: { hint: "<pet>" } },
    ]);
  });

  it("lets a mod's command stand in for a provider's of the same name", () => {
    expect(
      withModSlashCommands(
        [{ name: "pets", description: "The provider's" }, { name: "init" }],
        [pets],
      ),
    ).toEqual([{ name: "init" }, { name: "pets", description: "Open the pets pane" }]);
  });
});

describe("fillModPrompt", () => {
  const draft = { text: "hello world", cursor: 5 };

  it("replaces the draft, ends it, or goes in at the cursor", () => {
    expect(fillModPrompt(draft, { text: "new", mode: "replace" })).toEqual({
      text: "new",
      cursor: 3,
    });
    expect(fillModPrompt(draft, { text: "!", mode: "append" })).toEqual({
      text: "hello world!",
      cursor: 12,
    });
    expect(fillModPrompt(draft, { text: ",", mode: "insert" })).toEqual({
      text: "hello, world",
      cursor: 6,
    });
  });
});
