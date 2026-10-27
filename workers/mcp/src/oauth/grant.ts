import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Clock } from "@packserver/ports";
import { ACCESS_TOKEN_TTL_S } from "./scopes";

/** The provider's helpers this Worker calls; the provider itself is only loaded by the Worker's entry point. */
export type OAuthApi = Pick<
  OAuthHelpers,
  "parseAuthRequest" | "describeConsent" | "beginConsent" | "approveConsent" | "denyConsent" | "completeAuthorization" | "unwrapToken" | "listUserGrants" | "revokeGrant"
>;

/** What an OAuth access token stands for once the provider has opened it. */
export interface OAuthGrant {
  userId: string;
  clientId: string;
  grantId: string;
  scopes: string[];
}

/** What the provider keeps with an access token; the issue time is on the Worker's own clock, which tests move. */
export interface TokenProps {
  userId: string;
  issuedAt?: number;
}

const sameResource = (audience: string | string[] | undefined, resource: string): boolean =>
  typeof audience === "string" ? audience === resource : Array.isArray(audience) && audience.length === 1 && audience[0] === resource;

/**
 * The grant behind a presented bearer, or null. A value the provider does not know, one issued for another
 * audience and one older than an hour on the Worker's own clock are all null, so they are indistinguishable.
 */
export async function openAccessToken(api: OAuthApi, clock: Clock, resource: string, presented: string): Promise<OAuthGrant | null> {
  const token = await api.unwrapToken<TokenProps>(presented);
  if (!token || !sameResource(token.audience, resource)) return null;
  const props = token.grant.props;
  if (typeof props?.issuedAt !== "number" || clock.now() - props.issuedAt >= ACCESS_TOKEN_TTL_S * 1000) return null;
  if (props.userId !== token.userId) return null;
  return { userId: token.userId, clientId: token.grant.clientId, grantId: token.grantId, scopes: token.scope };
}
