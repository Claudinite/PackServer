/** A pack file shown read-only as escaped text; HTML and SVG never render as markup. */
export function FileText(props: { path: string; text: string }) {
  return (
    <pre data-path={props.path}><code>{props.text}</code></pre>
  );
}
