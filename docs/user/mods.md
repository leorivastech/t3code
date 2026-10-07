# Mods

A mod adds interface of your own to T3 Code: a pane beside the chat, a band above the composer, a status line, a slash command. A todo list, a deploy checklist, a clock, a view of your CI. Mods are small folders of code on the environment's machine. They are yours rather than a provider's, so the same mod works in every thread whichever model it talks to, and running one costs no tokens.

## Using a mod

Type its slash command in the composer, for example `/clock`. Mod commands appear in the slash menu with every provider. A mod's panes open in the right panel; close a pane with its tab's close button. You can also ask the agent to open one.

## Making a mod

Ask the agent: "make a mod that shows my open pull requests in a pane". Any provider can write one. The agent reads the mod guide, writes the folder, checks that it loaded, and opens it for you.

Mods live in `~/.agents/mods/`, one folder each, holding a `mod.json` with the mod's name and a `mod.tsx` with its code. Editing a file reloads the mods in every open thread without restarting anything. Delete the folder to remove a mod.

## What a mod can do

A mod runs on the environment's machine with your permissions: it can read and write files in the project, run commands, and fetch URLs. Install mods only from people you trust, as you would a script.

Mods are drawn on web and desktop. The mobile app does not show them.

## Where a mod draws, and where it does not yet

A mod shows itself in four places: a pane in the right panel, a band above the composer, a one-line status, and toasts. Inside a pane it can also run a page of its own, sealed off from the app, with a canvas and the keyboard: enough for a game. It can also watch what the agent does (a turn starting, a tool running, a turn ending) and react.

There are more places a mod could reach, left out for now to keep mods small and the same with every provider:

- redrawing the chat itself: your messages, the agent's replies, tool calls and their results, the working indicator;
- the composer: coloring what you type, suggesting text, reacting to each key;
- stopping or changing what the agent does. A mod only watches.
