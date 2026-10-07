/**
 * The page a mod's `Frame` runs. It is the mod's own html behind a small
 * bridge: `mod.send(data)` reaches the mod's `onMessage`, and
 * `mod.onMessage(listener)` hears what the mod posts with `$.ui.post`.
 * `mod.leave()` hands the keyboard back to the composer, as Escape does unless
 * the page keeps that key for itself. The frame is sandboxed without an
 * origin, so the page reaches nothing of the app.
 */

/** Marks the messages that cross between a frame and the app. */
export const MOD_FRAME_MESSAGE = "modFrame";

const BRIDGE = `<script>(() => {
  const listeners = [];
  window.mod = {
    send: (data) => parent.postMessage({ ${MOD_FRAME_MESSAGE}: true, data }, "*"),
    onMessage: (listener) => { listeners.push(listener); },
    leave: () => parent.postMessage({ ${MOD_FRAME_MESSAGE}: true, leave: true }, "*"),
  };
  addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) window.mod.leave();
  });
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.${MOD_FRAME_MESSAGE} !== true) return;
    for (const listener of listeners) listener(event.data.data);
  });
})();</script>`;

const BASE_STYLE =
  "<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent;color-scheme:light dark}</style>";

/** The frame's document: the bridge first, so the page's own scripts find `mod`. */
export function modFrameDocument(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0];
  return doctype === undefined
    ? `<!doctype html>${BASE_STYLE}${BRIDGE}${html}`
    : `${doctype}${BRIDGE}${html.slice(doctype.length)}`;
}

/**
 * What a frame's page sent: something for its mod, or that it gives the
 * keyboard back. Undefined when the message is not one of its own.
 */
export function readModFrameMessage(
  data: unknown,
): { readonly data: unknown } | { readonly leave: true } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as {
    readonly [MOD_FRAME_MESSAGE]?: unknown;
    readonly data?: unknown;
    readonly leave?: unknown;
  };
  if (message[MOD_FRAME_MESSAGE] !== true) return undefined;
  return message.leave === true ? { leave: true } : { data: message.data ?? null };
}
