/** Least privilege: a client asks for the scopes it needs and the person may approve fewer. */
export const SCOPE_READ = "packs:read";
export const SCOPE_WRITE = "packs:write";

export const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [SCOPE_READ]: "See the private packs you can read, and search them with the public ones.",
  [SCOPE_WRITE]: "Act for you in the community: star packs. Includes reading.",
};

export const SUPPORTED_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_WRITE];

/** Write implies read, as MCP asks servers to honour a broader scope. */
export function allows(granted: readonly string[], needed: string): boolean {
  return granted.includes(needed) || (needed === SCOPE_READ && granted.includes(SCOPE_WRITE));
}

/** Access tokens last an hour (REQ-SEARCH-012). */
export const ACCESS_TOKEN_TTL_S = 3600;
