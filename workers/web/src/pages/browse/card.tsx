import { HoverCard, PublisherMark, ScoreRing, ShapeGlyph, type PublisherProof } from "@packserver/ui";
import type { Card } from "./data";
import { fetchesLine, titleCase } from "./format";

const PARTS = ["rules", "skills", "checks", "guards", "tasks"] as const;

function proofsOf(card: Card): PublisherProof[] {
  return [
    ...(card.verified_domain ? [{ kind: "domain" as const, label: card.verified_domain }] : []),
    ...(card.verified_github_org ? [{ kind: "github" as const, label: `github.com/${card.verified_github_org}` }] : []),
  ];
}

/** The card budget: name, publisher mark, one line of pitch, shape glyph, score, rating, and "No public repo" when it applies. */
export function PackCardRow(props: { card: Card }) {
  const { card } = props;
  const proofs = proofsOf(card);
  const counts = Object.fromEntries(PARTS.map((p) => [p, card.inventory_counts[p] ?? 0])) as Record<(typeof PARTS)[number], number>;
  return (
    <li class="card">
      <div class="top">
        <a class="pk mono" href={`/packs/${card.id}`}>{card.id}</a>
        <a class="plain" href={`/@${card.id.slice(1).split("/")[0]}`}><PublisherMark proof={proofs[0]} proofs={proofs} focusable={false} /></a>
      </div>
      <p class="pitch">{card.pitch}</p>
      <div class="meta">
        <ShapeGlyph counts={counts} />
        <ScoreRing score={card.score} parts={card.score_parts.map((p) => ({ name: titleCase(p.part), score: p.points, max: p.weight }))} />
        <HoverCard align="right" label={card.rating === null ? <span class="rating muted">—</span> : <span class="rating"><b>{card.rating.toFixed(1)}</b></span>}>
          <ul>
            <li>{fetchesLine(card.fetches_30d)}</li>
            <li class="muted">{card.stars} {card.stars === 1 ? "star" : "stars"}</li>
          </ul>
        </HoverCard>
        {card.repository === null ? <span class="muted">No public repo</span> : null}
      </div>
    </li>
  );
}

export function PackCardList(props: { cards: readonly Card[] }) {
  return <ol class="cards">{props.cards.map((card) => <PackCardRow card={card} />)}</ol>;
}
