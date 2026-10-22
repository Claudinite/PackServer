import { sql } from "drizzle-orm";

/** The `in (...)` list for a CHECK constraint, built from the enum that types the column. */
export const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
