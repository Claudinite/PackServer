import type { TokenGrant } from "@packserver/core/tokens";

/** Who is asking to read private packs, once the credential has been verified. */
export type Caller =
  | { kind: "oidc"; ownerId: string; repository: string; visibility: string | undefined }
  | { kind: "session"; userId: string }
  | { kind: "device"; userId: string }
  | { kind: "token"; grant: TokenGrant };

export interface PackRef {
  id: string;
  /** Without the `@`. */
  scope: string;
  name: string;
}

export const systemName = (pack: PackRef): string => `@${pack.scope}/${pack.name}`;
