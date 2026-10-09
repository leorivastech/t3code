import { VoiceAction, type VoiceOrder, type VoiceScrollTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The two calls an order needs, as one OpenAI-style service answers them. */
export interface VoiceProvider {
  readonly origin: string;
  readonly hearingModel: string;
  /** Tried in order; the next one answers when the one before is over its limit. */
  readonly understandingModels: ReadonlyArray<string>;
  readonly understandingOptions: Readonly<Record<string, unknown>>;
}

const GROQ: VoiceProvider = {
  origin: "https://api.groq.com/openai/v1",
  hearingModel: "whisper-large-v3-turbo",
  understandingModels: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"],
  understandingOptions: { temperature: 0 },
};

const OPENAI: VoiceProvider = {
  origin: "https://api.openai.com/v1",
  hearingModel: "gpt-transcribe",
  understandingModels: ["gpt-5.4-nano"],
  understandingOptions: {},
};

/** Groq keys say so; anything else is taken to be an OpenAI key. */
export const voiceProviderForKey = (key: string): VoiceProvider =>
  key.startsWith("gsk_") ? GROQ : OPENAI;

/** Providers tell the audio format from the file name. */
export const voiceRecordingFileName = (mimeType: string): string =>
  `order.${/^audio\/([a-z0-9]+)/i.exec(mimeType)?.[1]?.toLowerCase() ?? "webm"}`;

export const VOICE_INSTRUCTIONS = `You turn a short spoken order (transcribed, possibly with errors, fillers or politeness, in English or Spanish) into actions for T3 Code: an app with threads numbered 1 to 9, each running a coding agent. You do not converse: you only translate.

Answer ONLY with JSON: {"ok":bool,"actions":[...]}. Each action has "op" and only the fields it uses:
- {"op":"jump","n":3} open thread n. "open the third one", "abre el 3", "podrías abrir el chat número tres".
- {"op":"next"} / {"op":"prev"} next / previous thread.
- {"op":"new"} new thread ("new thread", "sesión nueva").
- {"op":"model","query":"opus"} change model: one lowercase word (opus, sonnet, haiku, fable, gpt for ChatGPT/GPT, codex, gemini, grok…).
- {"op":"effort","level":"high"} effort: minimal, low, medium, high, xhigh (extra high), max.
- {"op":"write","text":"…","send":false} put text in the open thread's composer; send true to also send it.
- {"op":"send"} send what is already written ("send it", "mándalo"). {"op":"stop"} stop the agent ("stop", "para", "detente"). {"op":"close"} close the open thread ("close it", "ciérrala").
- {"op":"scroll","to":"up","pages":1} move what the thread shows. to: up, down, top ("go to the top", "hasta arriba"), bottom ("to the bottom", "al final"). pages: 0.5 for a little ("súbele tantito"), 1 normally, 3 for a lot.
- {"op":"photo"} take a screenshot ("take a screenshot", "toma una foto", "captura la pantalla"). It is copied and saved, not attached.
- {"op":"attach"} put the last screenshot in the composer ("paste it", "attach the screenshot", "pégala").

Rules:
- Stopping or closing a numbered thread ("stop the second one", "para la 2", "para la dos", "cierra el 1") = jump to it, then stop or close.
- Several things go in order: "open 3 and tell it to…" = jump, write. "new thread with Opus and ask it to…" = new, model, write. "switch to GPT and have it continue" = model, write. "take a screenshot and ask what's wrong" = photo, attach, write.
- send false: "write…", "write this, …", "type…", "note…", "escribe…", "anota…". A leading "right" is "write" misheard: "Right, check the login test" = write "Check the login test" with send false. send true: "tell it…", "ask it…", "have it…", "dile…", "escríbele…", "pídele…", "pregúntale…", "que haga…", "que siga…".
- When it starts with one of those verbs, it is an order and EVERYTHING after it is the text, even after a comma or a period, even when short, long, a question, or about orders, threads, numbers or this system. "Write this, apply that fix." = write "Apply that fix." with send false. "Escribe. También quisiera que al decir 1, 2 cambie de chat." = write that text with send false.
- "text" is the message for the agent in the user's own words and language, without the order part ("write the following", "dile que"). Only fix capitalization, accents and punctuation. Do not answer it, summarize it, translate it or add to it.
- Asking for subagents ("launch three subagents to…") = write the whole sentence with send true.
- "raise the effort", "bájale a bajo" is effort; "up", "down", "sube", "bájale" alone is scroll.
- "cancel", "never mind", "cancela", "olvídalo" = ok true and actions [].
- Not an order for the app (chatter, a half sentence, noise), or a required detail is missing ("open thread number" with no number) = ok false and actions []. When in doubt, do nothing.`;

const SCROLL_LABELS: Readonly<Record<VoiceScrollTarget, string>> = {
  up: "Scroll up",
  down: "Scroll down",
  top: "Go to the top",
  bottom: "Go to the bottom",
};
const LABEL_TEXT_LENGTH = 60;

function describeVoiceAction(action: VoiceAction): string {
  switch (action.op) {
    case "jump":
      return `Thread ${action.n}`;
    case "next":
      return "Next thread";
    case "prev":
      return "Previous thread";
    case "new":
      return "New thread";
    case "model":
      return `Model: ${action.query}`;
    case "effort":
      return `Effort: ${action.level}`;
    case "write": {
      const text =
        action.text.length > LABEL_TEXT_LENGTH
          ? `${action.text.slice(0, LABEL_TEXT_LENGTH - 1).trimEnd()}…`
          : action.text;
      return `${action.send ? "Send" : "Write"}: ${text}`;
    }
    case "send":
      return "Send";
    case "stop":
      return "Stop";
    case "close":
      return "Close";
    case "scroll":
      return SCROLL_LABELS[action.to];
    case "photo":
      return "Screenshot";
    case "attach":
      return "Attach screenshot";
  }
}

/** What an order is about to do, as the toast says it. Written here so it always reads the same. */
export const describeVoiceActions = (actions: ReadonlyArray<VoiceAction>): string =>
  actions.length === 0 ? "Cancelled" : actions.map(describeVoiceAction).join(" · ");

const understoodVoiceOrder = (heard: string, actions: ReadonlyArray<VoiceAction>): VoiceOrder => ({
  heard,
  says: describeVoiceActions(actions),
  understood: true,
  actions,
});

const NUMBERS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [String(index + 1), index + 1])),
  ...Object.fromEntries(
    ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].map((word, index) => [
      word,
      index + 1,
    ]),
  ),
  ...Object.fromEntries(
    ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"].map(
      (word, index) => [word, index + 1],
    ),
  ),
};

const SCROLLS: Readonly<Record<string, VoiceScrollTarget>> = {
  up: "up",
  "scroll up": "up",
  sube: "up",
  "dale para arriba": "up",
  "dale mas para arriba": "up",
  "mas para arriba": "up",
  "sube mas": "up",
  "up again": "up",
  arriba: "up",
  down: "down",
  "scroll down": "down",
  baja: "down",
  "dale para abajo": "down",
  "dale mas para abajo": "down",
  "mas para abajo": "down",
  "baja mas": "down",
  "down again": "down",
  abajo: "down",
  "hasta arriba": "top",
  "hasta el inicio": "top",
  "go to the top": "top",
  "hasta abajo": "bottom",
  "al final": "bottom",
  "to the bottom": "bottom",
};

/**
 * The orders said most often, and most often several in a row, need no model: a
 * bare thread number, or a bare "up" or "down".
 */
export function instantVoiceOrder(heard: string): VoiceOrder | null {
  const said = heard
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim()
    .replace(/\s+/g, " ");
  const number = said.replace(
    /^(?:(?:por favor|podrias|puedes|abre|abrir|cambia|cambiar|al|a|el|la|the|open|go to|numero|number|chat|hilo|thread) )+/,
    "",
  );
  const n = NUMBERS[number];
  if (n !== undefined) return understoodVoiceOrder(heard, [{ op: "jump", n }]);
  if (["siguiente", "next", "next thread"].includes(said))
    return understoodVoiceOrder(heard, [{ op: "next" }]);
  if (["anterior", "previous", "previous thread"].includes(said))
    return understoodVoiceOrder(heard, [{ op: "prev" }]);
  const to = SCROLLS[said];
  if (to !== undefined) return understoodVoiceOrder(heard, [{ op: "scroll", to, pages: 1 }]);
  const scroll =
    /^(?:dale|scroll|sube|baja|subele|bajale|mueve|move)(?: (?:mas|un poco|tantito|mucho))?(?: (?:para|hacia|a))? (arriba|abajo|up|down)(?: (mucho|a lot))?$/.exec(
      said,
    );
  if (!scroll) return null;
  const direction = scroll[1] === "arriba" || scroll[1] === "up" ? "up" : "down";
  const pages = /mucho|a lot/.test(said) ? 3 : /tantito|un poco/.test(said) ? 0.5 : 1;
  return understoodVoiceOrder(heard, [{ op: "scroll", to: direction, pages }]);
}

const ModelAnswer = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    actions: Schema.Array(VoiceAction).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
);
const decodeModelAnswer = Schema.decodeUnknownOption(ModelAnswer);

/** One action the app does not know makes the whole answer unsafe to run in part. */
export function voiceOrderFromModelAnswer(heard: string, answer: string): VoiceOrder {
  const understood = Option.filter(decodeModelAnswer(answer), ({ ok }) => ok);
  return Option.match(understood, {
    onNone: () => ({ heard, says: "", understood: false, actions: [] }),
    onSome: ({ actions }) => understoodVoiceOrder(heard, actions),
  });
}
