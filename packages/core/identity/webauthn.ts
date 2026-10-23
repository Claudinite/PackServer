import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";
import type { Clock, D1, Rng } from "@packserver/ports";

export interface MfaPorts {
  d1: D1;
  clock: Clock;
  rng: Rng;
}

/** Where ceremonies happen: the RP id is the site's host, which the browser ties every credential to. */
export interface RelyingParty {
  id: string;
  name: string;
  origin: string;
}

export const RP_NAME = "Claudinite Packs";
export const CHALLENGE_TTL_MS = 5 * 60_000;

export const relyingPartyFor = (origin: string): RelyingParty => ({ id: new URL(origin).hostname, name: RP_NAME, origin });

export type ChallengeKind = "signup" | "signin" | "enrol" | "assert";

export interface ChallengeBinding {
  user_id?: string | undefined;
  sid_hash?: string | undefined;
  action?: string | undefined;
  target?: string | undefined;
  payload?: string | undefined;
}

export interface TakenChallenge {
  user_id: string | null;
  sid_hash: string | null;
  action: string | null;
  target: string | null;
  payload: string | null;
}

export const isoAt = (clock: Clock, offsetMs = 0): string => new Date(clock.now() + offsetMs).toISOString();

const newChallenge = (rng: Rng): Uint8Array<ArrayBuffer> => rng.bytes(32) as Uint8Array<ArrayBuffer>;

async function storeChallenge(ports: MfaPorts, challenge: string, kind: ChallengeKind, binding: ChallengeBinding): Promise<void> {
  await ports.d1.batch([
    { sql: "delete from webauthn_challenges where expires_at <= ?", params: [isoAt(ports.clock)] },
    {
      sql: "insert into webauthn_challenges (challenge, kind, user_id, sid_hash, action, target, payload, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      params: [
        challenge, kind, binding.user_id ?? null, binding.sid_hash ?? null, binding.action ?? null, binding.target ?? null, binding.payload ?? null,
        isoAt(ports.clock, CHALLENGE_TTL_MS),
      ],
    },
  ]);
}

/**
 * Spends a challenge: it exists once, for its kind and, when it was issued to a session, for that
 * session only. Anything else leaves it untouched, so another session cannot burn it.
 */
export async function takeChallenge(
  ports: MfaPorts, challenge: string, kind: ChallengeKind, sidHash?: string,
): Promise<TakenChallenge | null> {
  const { rows } = await ports.d1.query(
    `delete from webauthn_challenges where challenge = ? and kind = ? and expires_at > ? and (sid_hash is null or sid_hash = ?)
     returning user_id, sid_hash, action, target, payload`,
    [challenge, kind, isoAt(ports.clock), sidHash ?? ""],
  );
  const row = rows[0];
  return row ? (row as unknown as TakenChallenge) : null;
}

/** The challenge a browser signed, read from the client data it returns. */
export function challengeOf(response: { response: { clientDataJSON: string } }): string | null {
  try {
    const data = JSON.parse(isoBase64URL.toUTF8String(response.response.clientDataJSON)) as { challenge?: unknown };
    return typeof data.challenge === "string" ? data.challenge : null;
  } catch {
    return null;
  }
}

export interface CredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  sign_count: number;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  hold_until: string | null;
  transports: string | null;
}

const CREDENTIAL_COLUMNS = "id, user_id, credential_id, public_key, sign_count, label, created_at, last_used_at, hold_until, transports";

export async function credentialsOf(d1: D1, userId: string): Promise<CredentialRow[]> {
  const { rows } = await d1.query(`select ${CREDENTIAL_COLUMNS} from credentials where user_id = ? order by created_at, id`, [userId]);
  return rows as unknown as CredentialRow[];
}

const transportsOf = (row: CredentialRow) => (row.transports ? row.transports.split(",") : undefined);

export interface RegistrationStart {
  kind: "signup" | "enrol";
  /** The account the credential will belong to; for sign-up, the id the new account will get. */
  user_id: string;
  user_name: string;
  display_name?: string;
  sid_hash?: string;
  existing?: CredentialRow[];
}

/** Discoverable credential, user verification required, nothing about the authenticator's make asked for. */
export async function beginRegistration(ports: MfaPorts, rp: RelyingParty, input: RegistrationStart): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: input.user_name,
    userDisplayName: input.display_name ?? input.user_name,
    userID: isoUint8Array.fromUTF8String(input.user_id),
    challenge: newChallenge(ports.rng),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: (input.existing ?? []).map((c) => ({ id: c.credential_id, ...(transportsOf(c) ? { transports: transportsOf(c)! } : {}) })),
    timeout: CHALLENGE_TTL_MS,
  });
  await storeChallenge(ports, options.challenge, input.kind, { user_id: input.user_id, sid_hash: input.sid_hash });
  return options;
}

export interface VerifiedRegistration {
  user_id: string;
  credential_id: string;
  public_key: string;
  sign_count: number;
  transports: string | null;
}

export async function finishRegistration(
  ports: MfaPorts, rp: RelyingParty, kind: "signup" | "enrol", response: RegistrationResponseJSON, sidHash?: string,
): Promise<VerifiedRegistration | null> {
  const challenge = challengeOf(response);
  const taken = challenge ? await takeChallenge(ports, challenge, kind, sidHash) : null;
  if (!challenge || !taken?.user_id) return null;
  try {
    const verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserPresence: true,
      requireUserVerification: true,
    });
    if (!verified.verified) return null;
    const { credential } = verified.registrationInfo;
    return {
      user_id: taken.user_id,
      credential_id: credential.id,
      public_key: isoBase64URL.fromBuffer(credential.publicKey),
      sign_count: credential.counter,
      transports: response.response.transports?.join(",") ?? null,
    };
  } catch {
    return null;
  }
}

/** Options for a discoverable sign-in, or for an assertion when the credentials to allow are named. */
export async function beginAuthentication(
  ports: MfaPorts, rp: RelyingParty, kind: "signin" | "assert", binding: ChallengeBinding, allow: CredentialRow[] = [],
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    challenge: newChallenge(ports.rng),
    userVerification: "required",
    allowCredentials: allow.map((c) => ({ id: c.credential_id, ...(transportsOf(c) ? { transports: transportsOf(c)! } : {}) })),
    timeout: CHALLENGE_TTL_MS,
  });
  await storeChallenge(ports, options.challenge, kind, binding);
  return options;
}

export interface VerifiedAuthentication {
  credential: CredentialRow;
  challenge: TakenChallenge;
}

/**
 * Checks a signed challenge against the stored public key of the credential it names. The counter
 * moves forward and the credential's last use is recorded only when the signature holds.
 */
export async function finishAuthentication(
  ports: MfaPorts, rp: RelyingParty, kind: "signin" | "assert", response: AuthenticationResponseJSON, sidHash?: string,
): Promise<VerifiedAuthentication | null> {
  const challenge = challengeOf(response);
  const taken = challenge ? await takeChallenge(ports, challenge, kind, sidHash) : null;
  if (!challenge || !taken) return null;
  const { rows } = await ports.d1.query(`select ${CREDENTIAL_COLUMNS} from credentials where credential_id = ?`, [response.id]);
  const credential = rows[0] as unknown as CredentialRow | undefined;
  if (!credential) return null;
  try {
    const verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
      credential: {
        id: credential.credential_id,
        publicKey: isoBase64URL.toBuffer(credential.public_key),
        counter: credential.sign_count,
        ...(transportsOf(credential) ? { transports: transportsOf(credential)! as never } : {}),
      },
    });
    if (!verified.verified) return null;
    await ports.d1.query("update credentials set sign_count = ?, last_used_at = ? where id = ?", [
      verified.authenticationInfo.newCounter, isoAt(ports.clock), credential.id,
    ]);
    return { credential, challenge: taken };
  } catch {
    return null;
  }
}

export async function saveCredential(
  ports: MfaPorts, registration: VerifiedRegistration, extra: { label: string | null; hold_until: string | null },
): Promise<CredentialRow> {
  const id = ports.rng.uuid();
  const at = isoAt(ports.clock);
  await ports.d1.query(
    `insert into credentials (id, user_id, credential_id, public_key, sign_count, label, created_at, last_used_at, hold_until, transports)
     values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)`,
    [id, registration.user_id, registration.credential_id, registration.public_key, registration.sign_count, extra.label, at, extra.hold_until, registration.transports],
  );
  return {
    id, user_id: registration.user_id, credential_id: registration.credential_id, public_key: registration.public_key,
    sign_count: registration.sign_count, label: extra.label, created_at: at, last_used_at: null, hold_until: extra.hold_until, transports: registration.transports,
  };
}
export type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
