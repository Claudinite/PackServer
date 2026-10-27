import type { SheetView } from "../dashboard/data";

/** What an owner reads before confirming a staged or widening version: what is new first, then everything else it changes. */
export function ApprovalSheet(props: { runId: string; pack: string; version: string; reasons: string; sheet: SheetView }) {
  const { sheet } = props;
  return (
    <div class="sheet" data-sheet={props.runId}>
      <p class="small muted">Waiting because: {props.reasons}.{sheet.against ? ` Changes are against ${sheet.against}.` : ""}</p>
      {sheet.new.length === 0 ? null : (
        <>
          <h3>New in this version</h3>
          <ul class="list">{sheet.new.map((entry) => <li data-new><span class="grow">{entry} <span class="when">new</span></span></li>)}</ul>
        </>
      )}
      {sheet.capabilities.added.length === 0 && sheet.capabilities.removed.length === 0 ? null : (
        <>
          <h3>Capabilities</h3>
          <ul class="list">
            {sheet.capabilities.added.map((c) => <li><span class="grow">{c} <span class="when">added</span></span></li>)}
            {sheet.capabilities.removed.map((c) => <li><span class="grow">{c} <span class="when">removed</span></span></li>)}
          </ul>
        </>
      )}
      {sheet.files.length === 0 ? null : (
        <details class="fold">
          <summary>Files changed · {sheet.files.length}{sheet.filesTruncated ? "+" : ""}</summary>
          <ul class="list">
            {sheet.files.map((f) => <li><span class="grow"><code>{f.path}</code> <span class="when">{f.change} · +{f.added_lines} −{f.removed_lines}</span></span></li>)}
          </ul>
        </details>
      )}
      <p class="mt2"><button class="btn primary" type="button" data-approve={props.runId} data-pack={props.pack} data-version={props.version}>Approve with your passkey</button></p>
    </div>
  );
}
