import { HoverCard } from "./hover";

export interface ScorePart {
  name: string;
  score: number;
  max: number;
}

const R = 14;
const CIRC = 2 * Math.PI * R;

export function scoreTone(score: number): "ok" | "warn" | "fail" {
  return score >= 80 ? "ok" : score >= 60 ? "warn" : "fail";
}

/** A 0 to 100 ring with the single largest improvement beside it; the five parts are the hover. */
export function ScoreRing(props: { score: number; improvement?: string; parts?: readonly ScorePart[]; capReason?: string }) {
  const score = Math.max(0, Math.min(100, Math.round(props.score)));
  const dash = (CIRC * score) / 100;
  return (
    <HoverCard
      label={
        <span class="ring">
          <svg viewBox="0 0 32 32" role="img" aria-label={`Score ${score} of 100`}>
            <circle class="track" cx="16" cy="16" r={R} fill="none" stroke-width="3" />
            <circle class={`arc ${scoreTone(score)}`} cx="16" cy="16" r={R} fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray={`${dash.toFixed(2)} ${CIRC.toFixed(2)}`} />
          </svg>
          <b>{score}</b>
          {props.improvement ? <span class="improve">{props.improvement}</span> : null}
        </span>
      }
    >
      <ul>
        {(props.parts ?? []).map((p) => <li>{p.name} · {p.score}/{p.max}</li>)}
      </ul>
      {props.capReason ? <p class="hint">Capped: {props.capReason}</p> : null}
    </HoverCard>
  );
}
