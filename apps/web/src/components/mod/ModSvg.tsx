import {
  modSvgBoxStyle,
  modSvgDataUrl,
  modSvgFrameDocument,
  modSvgIntrinsicSize,
} from "./modLeaves.logic";

/**
 * A mod's `Svg` element. The markup never joins the page: it is drawn as an image, or
 * with `isInteractive` in a sandboxed frame that runs no script, so hover styles and
 * animation work and nothing else does. `width` and `height` are CSS pixels; without
 * them the drawing keeps its own size, never wider than its slot. Markup that cannot be
 * drawn (empty, or over the size cap) shows `alt` instead.
 */
export function ModSvg(props: {
  source: string;
  alt: string;
  width?: number;
  height?: number;
  isInteractive?: boolean;
}) {
  const source = typeof props.source === "string" ? props.source : "";

  if (props.isInteractive) {
    const frameDocument = modSvgFrameDocument(source);
    if (frameDocument === null) return <span>{props.alt}</span>;
    return (
      <iframe
        className="block max-w-full border-0 bg-transparent"
        style={modSvgBoxStyle({
          width: props.width,
          height: props.height,
          intrinsic: modSvgIntrinsicSize(source),
        })}
        sandbox=""
        srcDoc={frameDocument}
        title={props.alt}
      />
    );
  }

  const src = modSvgDataUrl(source);
  if (src === null) return <span>{props.alt}</span>;
  return (
    <img
      className="block h-auto max-w-full object-contain"
      style={modSvgBoxStyle({ width: props.width, height: props.height })}
      src={src}
      alt={props.alt}
    />
  );
}
