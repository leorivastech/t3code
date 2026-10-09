import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DesktopScreenCapture } from "@t3tools/contracts";
import { beforeEach, vi } from "vite-plus/test";

const PNG = Buffer.from("picture of the screen");
const decodeCapture = Schema.decodeUnknownEffect(DesktopScreenCapture);

const native = vi.hoisted(() => ({
  pictures: "",
  sources: [] as Array<{
    display_id: string;
    thumbnail: { isEmpty: () => boolean; toPNG: () => Buffer };
  }>,
  copied: [] as Array<unknown>,
}));
vi.mock("electron", () => ({
  app: { getPath: () => native.pictures },
  screen: {
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    getDisplayNearestPoint: () => ({ id: 2, size: { width: 1920, height: 1080 }, scaleFactor: 1 }),
  },
  desktopCapturer: { getSources: () => Promise.resolve(native.sources) },
  clipboard: {
    write: (items: Array<unknown>) => {
      native.copied.push(...items);
      return Promise.resolve();
    },
  },
  ClipboardItem: function ClipboardItem() {},
}));

import { captureScreen } from "./screenCapture.ts";

const display = (id: number, empty = false) => ({
  display_id: String(id),
  thumbnail: { isEmpty: () => empty, toPNG: () => PNG },
});

beforeEach(() => {
  native.sources = [display(1), display(2)];
  native.copied = [];
});

const inPicturesFolder = <A, E>(
  run: (folder: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    native.pictures = yield* fileSystem.makeTempDirectoryScoped();
    return yield* run(native.pictures);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// Live: the file is named after the time it was taken.
it.live("copies the picture and keeps it in Pictures, dropping the oldest past twenty", () =>
  inPicturesFolder((pictures) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(pictures, "T3 Code");
      yield* fileSystem.makeDirectory(folder);
      yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) =>
          fileSystem.writeFileString(
            path.join(folder, `Screenshot 2020-01-${String(index + 1).padStart(2, "0")}.png`),
            "old",
          ),
      );
      yield* fileSystem.writeFileString(path.join(folder, "notes.txt"), "not a capture");

      const capture = yield* decodeCapture(yield* captureScreen.handler(undefined));

      assert.strictEqual(capture.pngBase64, PNG.toString("base64"));
      assert.strictEqual(native.copied.length, 1);
      const kept = (yield* fileSystem.readDirectory(folder)).toSorted();
      assert.strictEqual(kept.length, 21);
      assert.isFalse(kept.includes("Screenshot 2020-01-01.png"));
      assert.isTrue(kept.includes("notes.txt"));
      assert.isTrue(kept.includes(path.basename(capture.path ?? "")));
      assert.deepStrictEqual(yield* fileSystem.readFile(capture.path ?? ""), new Uint8Array(PNG));
    }),
  ),
);

it.effect("answers null when the desktop gives no picture", () =>
  inPicturesFolder(() =>
    Effect.gen(function* () {
      native.sources = [display(2, true)];
      assert.isNull(yield* captureScreen.handler(undefined));
      assert.deepStrictEqual(native.copied, []);
    }),
  ),
);
