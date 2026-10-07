import { MOD_BAND_INSTANCE_ID, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { ComposerBanner } from "../chat/ComposerBanner";
import { ModSite } from "./ModSite";
import { useMod } from "./useMod";

/** Rows the band may take before it scrolls. */
const BAND_MAX_ROWS = 12;
/** Mods lay a band out for a terminal's width; a narrower composer shrinks the type to fit. */
const BAND_MIN_COLUMNS = 80;

/**
 * Draws what mods put above the composer for this thread: the band a mod's
 * `ui.render` hook draws (`AbovePrompt`) and the lines mods pin with
 * `$.ui.status`. It also reports this window's size to the mods, which every
 * other drawing waits on.
 */
export function ModBand(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | undefined;
  readonly isWorking: boolean;
}) {
  const ui = useMod(props.environmentId, props.threadId);
  const surface = ui?.surface ?? null;
  const siteProps = useMemo(
    () => ({ hasSurvey: false, isWorking: props.isWorking, maxRows: BAND_MAX_ROWS }),
    [props.isWorking],
  );
  const onMeasure = useCallback(
    (measure: { readonly columns: number; readonly rowHeight: number }) => {
      surface?.setViewport({
        columns: measure.columns,
        rows: Math.max(1, Math.floor(window.innerHeight / measure.rowHeight)),
        isFullscreen: true,
      });
    },
    [surface],
  );

  if (ui === null) return null;
  const statuses = ui.snapshot.statuses;
  // The glass behind it all appears only while something is drawn, which each
  // drawn piece says with `data-mods-drawn`.
  return (
    <div className="group/mods relative mx-auto w-full max-w-208 px-1 has-[[data-mods-drawn]]:mb-1.5">
      <ComposerBanner.Surface
        aria-hidden
        placement="floating"
        className="absolute inset-0 hidden group-has-[[data-mods-drawn]]/mods:block"
      />
      <div className="relative flex flex-col gap-1 has-[[data-mods-drawn]]:p-1.5">
        <ModSite
          surface={ui.surface}
          component="AbovePrompt"
          instanceId={MOD_BAND_INSTANCE_ID}
          cwd={props.cwd}
          siteProps={siteProps}
          maxRows={BAND_MAX_ROWS}
          minColumns={BAND_MIN_COLUMNS}
          onMeasure={onMeasure}
        />
        {statuses.length === 0 ? null : (
          <div
            data-mods-drawn=""
            className="flex flex-wrap gap-x-3 gap-y-0.5 px-1 font-mono text-muted-foreground text-xs leading-4"
          >
            {statuses.map((status) => (
              <span key={status.plugin} className="whitespace-pre-wrap">
                {status.text}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
