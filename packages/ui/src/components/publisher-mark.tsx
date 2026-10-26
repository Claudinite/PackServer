import { HoverCard } from "./hover";

export interface PublisherProof {
  kind: "domain" | "github";
  /** The proven thing itself: `acme.com` or `github.com/acme`. */
  label: string;
  /** ISO date the proof was established, when known. */
  since?: string;
}

export interface PublisherMarkProps {
  /** The proof the mark shows; absent for an unproven scope. */
  proof?: PublisherProof;
  /** Every proof the scope holds, for the hover. */
  proofs?: readonly PublisherProof[];
  verifiedPublisher?: boolean;
  packCount?: number;
  /** False when the mark sits inside a link, so it is one tab stop. */
  focusable?: boolean;
}

/** `● acme.com`, `● github.com/acme` or `○ Unproven`. "Verified Publisher" only ever appears in the hover. */
export function PublisherMark(props: PublisherMarkProps) {
  const proven = props.proof !== undefined;
  const text = props.proof?.label ?? "Unproven";
  const proofs = props.proofs ?? (props.proof ? [props.proof] : []);
  return (
    <HoverCard
      focusable={props.focusable}
      label={
        <span class={proven ? "mark pub" : "mark pub unproven"}>
          <span class="dot" aria-hidden="true" />
          <span class="name">{text}</span>
          <span class="sr">{proven ? " (proven)" : ""}</span>
        </span>
      }
    >
      <ul>
        {props.verifiedPublisher ? <li><b>Verified Publisher</b></li> : null}
        {proofs.length === 0 ? <li>No domain or GitHub organisation proven</li> : proofs.map((p) => <li>{p.since ? `${p.label} · since ${p.since}` : p.label}</li>)}
        {props.packCount === undefined ? null : <li class="muted">{props.packCount} public {props.packCount === 1 ? "pack" : "packs"}</li>}
      </ul>
    </HoverCard>
  );
}
