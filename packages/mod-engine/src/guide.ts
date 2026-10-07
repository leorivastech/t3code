/**
 * How to write a mod, for the agent asked to make one. A host hands this text
 * to its agents (T3 Code does through the `mods_guide` tool), so every model
 * learns the same format whichever editor runs it.
 */
export const MOD_GUIDE = `# Writing a mod

A mod adds interface to the editor: a pane beside the chat, a band above the composer, a status line, toasts, slash commands. It is plain code the editor runs locally. It belongs to no model or provider and costs no tokens to run. Those are all the places a mod draws: it cannot redraw the chat's messages or the composer, or stop or change what the agent does.

## Where it lives

One folder per mod under \`~/.agents/mods/\`:

\`\`\`
~/.agents/mods/todo/
  mod.json    { "name": "todo", "description": "A todo list in a pane." }
  mod.tsx     exports register(on)
\`\`\`

\`name\` is letters, digits, \`.\`, \`_\` or \`-\`. \`mod.tsx\` may be \`.ts\`, \`.jsx\` or \`.js\`, or any file named by \`"main"\` in \`mod.json\`. It may import sibling files with relative paths, \`.json\` files, and \`.html\`, \`.css\`, \`.svg\`, \`.txt\` or \`.md\` files as text (\`import page from "./page.html"\`). It cannot import packages or Node modules: everything outside the mod is reached through \`$\`.

Saving a file reloads every mod at once; state and open panes survive a reload. Call \`mods_list\` to see whether yours loaded and the error if it did not, and \`mods_run\` to run one of its commands.

## The shape of a mod

\`\`\`tsx
import { atom, read, update } from "mods"

const items = atom({ plugin: "todo", key: "items" }, [] as string[])

export function register(on) {
  // Runs once when a conversation opens, before any command. Register commands and load saved state here.
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "todo", description: "Open the todo list", argumentHint: "[item]" })
    return next(e)
  })

  // The person typed /todo, or an agent ran it.
  on("command.run", { command: "todo" }, async ($, e) => {
    if (e.args !== "") await update($, items, (list) => [...list, e.args])
    await $.ui.open({ id: "todo", title: "Todo" })
    return { text: "Todo list opened." }
  })

  // Draw the pane. Runs again after every state change.
  on("ui.render", { component: "Pane", requestId: "todo" }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, items)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{list.length} to do</Text>
        {list.map((item, index) => (
          <Box key={"row" + index} gap={1}>
            <Button key={"done" + index} label="Done" onPress={() => update($, items, (all) => all.filter((_, at) => at !== index))} />
            <Text>{item}</Text>
          </Box>
        ))}
        <Input key="new" label="Add" placeholder="buy milk" submitLabel="Add" onSubmit={(value) => update($, items, (all) => [...all, value])} />
      </Box>
    )
  })
}
\`\`\`

Every hook is \`($, e, next)\`. \`e\` is the event's input. \`next(e)\` passes the event on to the other mods and the editor; return its result unless the hook answers the event itself. The optional second argument of \`on\` filters by fields of \`e\`. JSX needs no import. Element names come from \`$.ui.resolve(e)\`.

## Events

- \`session.start\` — a conversation opened. \`e.cwd\` is the project folder.
- \`command.run\` — \`e.command\`, and \`e.args\`: the text after the command, \`""\` when there is none. It is text: parse a number yourself. Return \`{ text }\` to show a reply; a command no hook answers goes to the agent as a normal message.
- \`ui.render\` — draw. \`e.component\` is \`"Pane"\` (\`e.requestId\` is the pane's id) or \`"AbovePrompt"\` (the band above the composer). \`e.props.bodyColumns\` is the width in characters. Return elements, or \`next(e)\` to draw nothing.
- \`ui.close\` — the person or a mod closes pane \`e.id\`. Return without calling \`next\` to keep it open.
- \`turn.start\`, \`turn.complete\` (\`e.reason\` is \`"answer"\`, \`"aborted"\` or \`"error"\`) and \`tool.call\` (\`e.tool\`, and \`e.command\` for a shell command) — what the agent is doing, whichever model it is. A mod watches these; it cannot block or change them. Always \`return next(e)\`.

## What \`$\` offers

- \`$.ui.open({ id, title, focus?, rows?, columns?, closeOnEscape? })\`, \`$.ui.close({ id })\`, \`$.ui.panes()\`. A pane's \`id\` is letters, digits, \`_\` or \`-\`. Opening a pane that is already open brings it forward. \`focus: true\` also gives it the keyboard, landing on the element with \`autoFocus\` (a game's \`Frame\`, an \`Input\`): pass it when the command means "take me there", so running the command again returns the person to the game after Escape. It is refused while they are writing a message.
- \`$.ui.status(text | null)\` — one line by the composer. It shows the text you last gave it and does not follow your atoms: call it again wherever the value changes (in the button's handler, not in \`ui.render\`). \`$.ui.toast(text)\`. \`$.ui.log(text)\`.
- \`$.ui.invalidate()\` — draw again. State changes do this by themselves.
- \`$.ui.scroll({ in: paneId, to: "start" | "end" | { key } })\`, \`$.ui.copy({ text })\`
- \`$.command.register({ name, description, argumentHint? })\`
- \`$.prompt.read()\` → \`{ text, cursor }\`. \`$.prompt.fill({ text, mode: "replace" | "append" | "insert" })\` writes into the composer; the person still sends it.
- \`$.clock.now()\`, \`$.clock.sleep(ms)\`, and the timers \`$.clock.every(ms, fn)\` and \`$.clock.after(ms, fn)\`, which return \`{ cancel() }\`. There is no \`setTimeout\`, \`setInterval\` or \`clearInterval\`.
- \`$.fs.read(path)\`, \`$.fs.write(path, text)\`, \`$.fs.exists(path)\`, \`$.fs.list(path)\`, \`$.fs.stat(path)\` — paths are relative to the project folder.
- \`$.process.run(["git", "status"], { cwd?, timeoutMs?, stdin? })\` → \`{ exitCode, stdout, stderr }\`
- \`$.http.fetch(url, { method?, headers?, body? })\` → \`{ status, ok, headers, text }\`
- \`$.store.get(key)\`, \`$.store.set(key, value)\`, \`$.store.delete(key)\` — JSON values kept on disk across restarts, each mod with its own keys. \`get\` answers \`undefined\` for a key never set.
- \`$.session.cwd()\`

Anything else on \`$\` rejects with "not available in this host". Catch it or do not call it. A mod has no \`process\`, \`require\`, \`fetch\` or DOM either: only the language itself, \`$\`, and \`console\` (which prints nowhere).

## State

Keep what the drawing depends on in atoms, not in module variables: changing an atom redraws, and atoms survive a reload of the mod.

\`\`\`ts
const open = atom({ plugin: "todo", key: "open" }, false)   // name and initial value
await read($, open)                                         // never undefined
await update($, open, (was) => !was)                        // returns the new value; safe when two updates race
\`\`\`

Atoms last as long as the conversation stays open. For what must survive closing the editor, also keep it in \`$.store\`, which does not redraw by itself: load it into the atom when the session starts, and save it when it changes.

\`\`\`ts
on("session.start", async ($, e, next) => {
  const saved = await $.store.get("items")
  if (saved !== undefined) await update($, items, () => saved)
  return next(e)
})
const add = async ($, item) => $.store.set("items", await update($, items, (all) => [...all, item]))
\`\`\`

## Elements

Sizes count characters of a monospace grid, as in a terminal: \`width={40}\`, \`padding={1}\`, \`gap={1}\`.

- \`Box\` — layout. \`flexDirection\` (\`"row"\` default, \`"column"\`), \`gap\`, \`padding*\`, \`margin*\`, \`width\`, \`height\`, \`alignItems\`, \`justifyContent\`, \`flexGrow\`, \`flexWrap\`, \`borderStyle\` (\`"single"\`, \`"round"\`, \`"double"\`), \`borderColor\`, \`backgroundColor\`, \`hover={{ ...styles }}\`.
- \`Text\` — \`color\`, \`backgroundColor\`, \`bold\`, \`italic\`, \`underline\`, \`strikethrough\`, \`dimColor\`, \`wrap\`.
- \`Button\` — \`key\`, \`label\`, \`onPress\`, \`variant="primary"\`, \`hotkey\`.
- \`Input\` — \`key\`, \`label\`, \`placeholder\`, \`onSubmit(value)\`, \`submitLabel\`. The field empties itself after a submit. To hold its text yourself, give it \`value\` from an atom and update that atom in \`onInput(value)\`.
- \`Select\` — \`key\`, \`label\`, \`options=[{ value, label }]\`, \`value\`, \`onSelect(value)\`.
- \`Markdown\` — \`text\`. \`Code\` — \`source\`, \`language\`, or \`format="diff"\` with a unified diff. \`Link\` — \`href\`, \`label\`. \`Svg\` — \`source\` (an svg document), \`width\`, \`height\` in pixels, \`alt\`.

- \`Frame\` — a page of your own inside the pane, for what elements cannot draw: a game, an animation, a canvas. \`key\`, \`html\` (a complete page: markup, \`<style>\`, \`<script>\`), \`height\` in pixels, \`autoFocus\`, \`onMessage(data)\`. The page runs sealed off from the editor and from your mod's code: it has a real \`<canvas>\`, \`requestAnimationFrame\`, the keyboard while it is clicked, and may open a \`WebSocket\` or \`fetch\` a server. It talks to the mod through \`mod.send(data)\` (arrives at \`onMessage\`) and \`mod.onMessage((data) => ...)\` (hears \`$.ui.post({ key, data })\`); data is JSON. Escape gives the keyboard back to the composer unless the page calls \`preventDefault()\` on it; \`mod.leave()\` does the same from code. Keep \`html\` the same string between drawings or the page restarts, and wait for the page to say it is ready before posting to it.

Colors: theme names that follow the person's theme (\`text\`, \`subtle\`, \`inactive\`, \`accent\`, \`info\`, \`success\`, \`warning\`, \`error\`, \`border\`), terminal names (\`red\`, \`green\`, \`yellow\`, \`blue\`, \`magenta\`, \`cyan\`, \`white\`, each also with \`Bright\`), or \`#rrggbb\`.

Give every \`Button\`, \`Input\` and \`Select\` a stable \`key\`, and every row of a list too.

## Checklist

1. Create the folder, \`mod.json\` and \`mod.tsx\`.
2. \`mods_list\` → the mod is listed with no \`error\` and its commands.
3. \`mods_run\` its command → the pane opens for the person.
4. Tell the person the command to type.
`;
