import type { D1 } from "@packserver/ports";

/** A job that has spent its share is stopped by this, and the run counts that as a clean stop. */
export class BudgetExhausted extends Error {
  constructor(readonly limit: number) {
    super(`the job's share of ${limit} D1 queries is spent`);
  }
}

export interface QueryBudget {
  d1: D1;
  used(): number;
  /** Whether `queries` more fit in what is left. */
  hasRoom(queries: number): boolean;
}

/** Counts every query and every batch (a batch is one) and refuses the one past `limit` before it reaches D1. */
export function queryBudget(d1: D1, limit: number): QueryBudget {
  let used = 0;
  const spend = () => {
    if (used >= limit) throw new BudgetExhausted(limit);
    used += 1;
  };
  return {
    d1: {
      query: async (sql, params) => (spend(), d1.query(sql, params)),
      batch: async (statements) => (spend(), d1.batch(statements)),
    },
    used: () => used,
    hasRoom: (queries) => used + queries <= limit,
  };
}
