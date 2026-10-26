import type { ReviewView } from "@packserver/core/community";
import type { Context } from "hono";
import { renderPage } from "../../layout";

/** Files nothing but the review: it goes through the JSON API with the session's token. */
const SCRIPT = `
const form = document.getElementById("review-form");
const out = document.getElementById("review-result");
const csrf = async () => (await (await fetch("/api/auth/session")).json()).csrf;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  out.textContent = "Sending...";
  const res = await fetch("/api/packs/" + form.dataset.pack + "/review", {
    method: "PUT",
    headers: { "x-csrf-token": await csrf(), "content-type": "application/json", "idempotency-key": crypto.randomUUID().replaceAll("-", "") },
    body: JSON.stringify({ rating: Number(form.rating.value), body: form.body.value, version: form.version.value }),
  });
  const body = await res.json();
  if (!res.ok) { out.textContent = body.message || "The review was refused."; return; }
  location.reload();
});
`;

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

function Review(props: { review: ReviewView }) {
  const r = props.review;
  return (
    <li class="review">
      <p>
        <span aria-label={`${r.rating} out of 5`}>{stars(r.rating)}</span> {r.author ?? "Someone"} on {r.version}
        {r.verified_adoption ? <> · <span class="verified-adoption">verified adoption</span></> : null}
      </p>
      {r.body === "" ? null : <p>{r.body}</p>}
      {r.reply ? <p class="reply"><b>Publisher reply:</b> {r.reply.body}</p> : null}
    </li>
  );
}

export function renderReviewsPage(
  c: Context,
  props: { pack: string; signedIn: boolean; reviews: ReviewView[]; mine: ReviewView | null; rating: { shown: number; count: number } | null },
) {
  const next = encodeURIComponent(new URL(c.req.url).pathname);
  return renderPage(c, {
    title: `Reviews of ${props.pack}`,
    children: (
      <>
        <h1>Reviews of {props.pack}</h1>
        <p>{props.rating ? `${props.rating.shown.toFixed(1)} from ${props.rating.count} ${props.rating.count === 1 ? "review" : "reviews"}` : "No reviews yet."}</p>
        <ul>{props.reviews.map((r) => <Review review={r} />)}</ul>
        {!props.signedIn ? (
          <p><a href={`/signin?next=${next}`}>Sign in</a> to rate and review this pack.</p>
        ) : (
          <>
            <h2>{props.mine ? "Edit your review" : "Your review"}</h2>
            <form id="review-form" data-pack={props.pack}>
              <label>Rating <select name="rating">{[5, 4, 3, 2, 1].map((n) => <option value={n} selected={props.mine?.rating === n}>{n}</option>)}</select></label>
              <label>Version <input name="version" required pattern="[0-9]+\.[0-9]+\.[0-9]+.*" value={props.mine?.version ?? ""} /></label>
              <label>Review (optional) <textarea name="body" maxlength={4000}>{props.mine?.body ?? ""}</textarea></label>
              <button type="submit">Save review</button>
            </form>
            <p id="review-result" role="status"></p>
            <script nonce={c.get("cspNonce")} dangerouslySetInnerHTML={{ __html: SCRIPT }} />
          </>
        )}
      </>
    ),
  });
}
