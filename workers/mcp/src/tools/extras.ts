export interface Advisory {
  version: string;
  severity: string;
  id: string | null;
  summary: string;
}

export interface PackRef {
  id: string;
  name: string;
}

/**
 * What `get_pack` reports that other areas own. Each answer is `null` where its source does not
 * exist yet: unknown is not zero, and an unwired source must not read as "no advisories".
 */
export interface PackExtras {
  advisories(pack: PackRef): Promise<Advisory[] | null>;
  reportedUnderReview(pack: PackRef): Promise<boolean | null>;
  verifiedAdoptions(pack: PackRef): Promise<number | null>;
  declaringRepositories(pack: PackRef): Promise<number | null>;
}

/** Advisories and reports arrive with T-092 (Claudinite/PackServer#168), adoption counts with T-090 and the weekly scan. */
export const unwiredExtras: PackExtras = {
  advisories: async () => null,
  reportedUnderReview: async () => null,
  verifiedAdoptions: async () => null,
  declaringRepositories: async () => null,
};
