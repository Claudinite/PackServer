/** A price is always the goal price struck through, with "free through 2026" beside it (REQ-PAY-017). */
export function Price(props: { amount: string; unit?: string }) {
  return (
    <span class="price">
      <s>{props.unit ? `${props.amount} ${props.unit}` : props.amount}</s>
      <span class="free">free through 2026</span>
    </span>
  );
}

export const PRICES = {
  newPack: { amount: "$1", unit: "per new pack" },
  verifiedPublisher: { amount: "$99", unit: "a year" },
  seat: { amount: "$7", unit: "per seat per month" },
} as const;
