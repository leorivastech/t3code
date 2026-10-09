import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VoiceScrollTarget = Schema.Literals(["up", "down", "top", "bottom"]);
export type VoiceScrollTarget = typeof VoiceScrollTarget.Type;

export const VoiceEffortLevel = Schema.Literals([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type VoiceEffortLevel = typeof VoiceEffortLevel.Type;

/**
 * One thing a spoken order asks the app to do. Threads go by the number their
 * jump shortcut shows, so "the third one" is the thread `thread.jump.3` opens.
 */
export const VoiceAction = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("jump"),
    n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9 })),
  }),
  Schema.Struct({
    /** `photo` takes a picture of the screen; `attach` puts the last one in the draft. */
    op: Schema.Literals(["next", "prev", "new", "send", "stop", "close", "photo", "attach"]),
  }),
  Schema.Struct({ op: Schema.Literal("model"), query: TrimmedNonEmptyString }),
  Schema.Struct({ op: Schema.Literal("effort"), level: VoiceEffortLevel }),
  Schema.Struct({
    op: Schema.Literal("write"),
    text: TrimmedNonEmptyString,
    send: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }),
  Schema.Struct({
    op: Schema.Literal("scroll"),
    to: VoiceScrollTarget,
    /** Screens to move; ignored when going to either end. */
    pages: Schema.Number.check(Schema.isBetween({ minimum: 0.25, maximum: 10 })).pipe(
      Schema.withDecodingDefault(Effect.succeed(1)),
    ),
  }),
]);
export type VoiceAction = typeof VoiceAction.Type;

/** What was heard and what it means. Nothing runs when it was not understood. */
export const VoiceOrder = Schema.Struct({
  heard: Schema.String,
  /** A short label of the order, in the speaker's language. */
  says: Schema.String,
  understood: Schema.Boolean,
  actions: Schema.Array(VoiceAction),
});
export type VoiceOrder = typeof VoiceOrder.Type;

/** A recording of at most a few minutes of speech, as the browser's recorder made it. */
export const VoiceInterpretInput = Schema.Struct({
  audioBase64: Schema.String.check(Schema.isMaxLength(12_000_000)),
  mimeType: TrimmedNonEmptyString,
});
export type VoiceInterpretInput = typeof VoiceInterpretInput.Type;

const VOICE_FAILURES = {
  "local-unavailable":
    "Local Whisper did not answer. Check the local speech service on this environment.",
  "not-configured":
    "Voice is not set up. Add a Groq or OpenAI key under Settings → Integrations → Voice.",
  "key-rejected": "The voice key was rejected. Check it under Settings → Integrations → Voice.",
  "rate-limited": "The voice provider is over its limit for now. Try again in a moment.",
  unreachable: "The voice provider did not answer.",
} as const;

/** Why a recording did not become an order. */
export class VoiceError extends Schema.TaggedError<VoiceError>()("VoiceError", {
  reason: Schema.Literals([
    "not-configured",
    "key-rejected",
    "rate-limited",
    "unreachable",
    "local-unavailable",
  ]),
}) {
  override get message(): string {
    return VOICE_FAILURES[this.reason];
  }
}
