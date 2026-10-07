import type { MouseEvent } from "react";

import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import {
  MOD_LINK_HREF_ATTRIBUTE,
  isModLinkDrawable,
  isModLinkPress,
  remarkModLinks,
} from "./modLeaves.logic";

const LINK_REMARK_PLUGINS = [remarkModLinks];

/** The element under a click that `selector` matches, when it is inside `container`. */
function closestWithin(container: Element, target: EventTarget, selector: string): Element | null {
  if (!(target instanceof Element)) return null;
  const match = target.closest(selector);
  return match !== null && container.contains(match) ? match : null;
}

/**
 * A mod's `Markdown` element, drawn as the app draws an assistant reply. Raw HTML in
 * the text is shown as written, and a link whose scheme is not `https:`, `http:` or
 * `file:` is drawn as its text. With `onLinkPress`, a plain click on a link (any link,
 * or only those `pressableLinks` names) goes to the mod with the href as the markdown
 * wrote it, and opens nothing; a modified click opens the link as usual.
 */
export function ModMarkdown(props: {
  text: string;
  cwd: string | undefined;
  dimColor?: boolean;
  pressableLinks?: ReadonlyArray<string>;
  onLinkPress?: (href: string) => void;
}) {
  const { onLinkPress, pressableLinks } = props;

  // The markdown tree already drops links a mod may not draw. This holds the same line
  // for any anchor that reaches the page another way, on every button that follows one.
  const blockUndrawableLink = (event: MouseEvent<HTMLDivElement>) => {
    const href = closestWithin(event.currentTarget, event.target, "a[href]")?.getAttribute("href");
    if (href == null || isModLinkDrawable(href)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  // Capture runs before the link's own handlers, so a press the mod answers never
  // reaches the ones that would open it.
  const handleClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (blockUndrawableLink(event) || !onLinkPress) return;
    const href = closestWithin(
      event.currentTarget,
      event.target,
      `[${MOD_LINK_HREF_ATTRIBUTE}]`,
    )?.getAttribute(MOD_LINK_HREF_ATTRIBUTE);
    if (href == null || !isModLinkPress({ href, pressableLinks, event })) return;
    event.preventDefault();
    event.stopPropagation();
    onLinkPress(href);
  };

  return (
    <div
      className={cn("min-w-0", props.dimColor && "opacity-60")}
      onClickCapture={handleClickCapture}
      onAuxClickCapture={blockUndrawableLink}
    >
      <ChatMarkdown
        text={props.text}
        cwd={props.cwd}
        parseRawHtml={false}
        extraRemarkPlugins={LINK_REMARK_PLUGINS}
      />
    </div>
  );
}
