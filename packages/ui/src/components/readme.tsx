import { raw } from "hono/html";
import { renderMarkdown } from "../markdown";

/** A pack README, rendered through the sanitising renderer. */
export function Readme(props: { markdown: string }) {
  return <div class="readme">{raw(renderMarkdown(props.markdown))}</div>;
}
