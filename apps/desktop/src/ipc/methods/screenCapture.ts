import { DesktopScreenCapture } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const FOLDER_NAME = "T3 Code";
const FILE_PREFIX = "Screenshot ";
/** Old captures go as new ones arrive, so what was once on screen does not pile up. */
const KEPT_CAPTURES = 20;

/**
 * Takes a picture of the display the pointer is on, copies it to the clipboard
 * and keeps it in the Pictures folder. Null when the desktop gave no picture.
 */
export const captureScreen = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CAPTURE_SCREEN_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.NullOr(DesktopScreenCapture),
  handler: Effect.fn("desktop.ipc.screenCapture.captureScreen")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const display = Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint());
    const sources = yield* Effect.promise(() =>
      Electron.desktopCapturer
        .getSources({
          types: ["screen"],
          thumbnailSize: {
            width: Math.round(display.size.width * display.scaleFactor),
            height: Math.round(display.size.height * display.scaleFactor),
          },
        })
        .catch(() => []),
    );
    const image = (sources.find((source) => source.display_id === String(display.id)) ?? sources[0])
      ?.thumbnail;
    if (image === undefined || image.isEmpty()) return null;
    const png = image.toPNG();
    yield* Effect.promise(() =>
      Electron.clipboard
        .write([
          new Electron.ClipboardItem({
            "image/png": new Blob([Uint8Array.from(png)], { type: "image/png" }),
          }),
        ])
        .catch(() => undefined),
    );
    const directory = path.join(Electron.app.getPath("pictures"), FOLDER_NAME);
    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
    const file = path.join(directory, `${FILE_PREFIX}${stamp}.png`);
    return yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFile(file, png);
      const captures = (yield* fileSystem.readDirectory(directory))
        .filter((name) => name.startsWith(FILE_PREFIX))
        .toSorted();
      yield* Effect.forEach(captures.slice(0, -KEPT_CAPTURES), (name) =>
        fileSystem.remove(path.join(directory, name)),
      );
      return { path: file, pngBase64: png.toString("base64") };
    }).pipe(
      // The picture reached the clipboard either way; it only was not kept.
      Effect.orElseSucceed(() => ({ path: null, pngBase64: png.toString("base64") })),
    );
  }),
});
