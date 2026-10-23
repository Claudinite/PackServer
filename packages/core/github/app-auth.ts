const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text.replace(/\s+/g, ""), "base64"));

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return [0x80 | bytes.length, ...bytes];
}

/** WebCrypto imports PKCS#8 only, and GitHub issues PKCS#1 ("BEGIN RSA PRIVATE KEY"). */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octets = [0x04, ...derLength(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...algorithm, ...octets];
  const out = [0x30, ...derLength(inner.length + pkcs1.length), ...inner];
  const result = new Uint8Array(out.length + pkcs1.length);
  result.set(out);
  result.set(pkcs1, out.length);
  return result;
}

/** A PEM (PKCS#1 or PKCS#8) or the bare base64 of a PKCS#8 key. */
export function importAppKey(secret: string): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
  const pem = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(secret);
  const der = fromBase64(pem ? pem[2]! : secret);
  const pkcs8 = pem?.[1] === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** The App's identity token: GitHub accepts at most ten minutes and tolerates clock drift on `iat`. */
export async function appJwt(options: { appId: string; privateKey: string; nowMs: number }): Promise<string> {
  const iat = Math.floor(options.nowMs / 1000) - 60;
  const part = (value: object) => base64url(encoder.encode(JSON.stringify(value)));
  const signingInput = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat, exp: iat + 9 * 60, iss: options.appId })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importAppKey(options.privateKey), encoder.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
