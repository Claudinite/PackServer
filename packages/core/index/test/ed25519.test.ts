import * as noble from "@noble/ed25519";
import { beforeAll, describe, expect, it } from "vitest";
import { type Ed25519, fromBase64Url, noblePure, selectEd25519, utf8 } from "../index";
import { seedA, seedB } from "./fixtures";

const message = utf8("a signed document");

describe("Ed25519 backends", () => {
  it("uses WebCrypto where the runtime has it and records which backend ran", async () => {
    expect((await selectEd25519()).backend).toBe("webcrypto");
    expect((await selectEd25519(undefined)).backend).toBe("webcrypto");
    expect(noblePure.backend).toBe("noble");
  });

  it("falls back to noble when the runtime refuses Ed25519, and says why", async () => {
    const refusing = { importKey: () => Promise.reject(new Error("unsupported")) } as unknown as typeof globalThis.crypto.subtle;
    const ed = await selectEd25519(refusing);
    expect(ed.backend).toBe("noble");
    expect(ed.selection).toMatch(/fallback.*probe/i);
    expect((await selectEd25519()).selection).toMatch(/webcrypto/i);
  });

  it("probes once per isolate when no backend is given, keeping the recorded reason", async () => {
    const first = await selectEd25519();
    const second = await selectEd25519();
    expect(second).toBe(first);
    expect(second.selection).toMatch(/probe passed/);
    const refusing = { importKey: () => Promise.reject(new Error("unsupported")) } as unknown as typeof globalThis.crypto.subtle;
    expect(await selectEd25519(refusing)).not.toBe(first);
  });

  it("falls back when WebCrypto imports keys but signs something other than the known answer", async () => {
    const real = globalThis.crypto.subtle;
    const lying = {
      importKey: real.importKey.bind(real),
      sign: async () => new ArrayBuffer(64),
      verify: real.verify.bind(real),
    } as unknown as typeof globalThis.crypto.subtle;
    const ed = await selectEd25519(lying);
    expect(ed.backend).toBe("noble");
    expect(ed.selection).toMatch(/probe/i);
  });

  it("does not depend on a runtime accepting the identity point to use WebCrypto", async () => {
    const real = globalThis.crypto.subtle;
    const picky = {
      importKey: (format: string, key: Uint8Array, ...rest: unknown[]) => {
        if (format === "raw" && key[0] === 1 && key.slice(1).every((b) => b === 0)) return Promise.reject(new Error("small order"));
        return (real.importKey as (...a: unknown[]) => Promise<unknown>)(format, key, ...rest);
      },
      sign: real.sign.bind(real),
      verify: real.verify.bind(real),
    } as unknown as typeof globalThis.crypto.subtle;
    expect((await selectEd25519(picky)).backend).toBe("webcrypto");
  });

  it("produces byte-identical deterministic signatures on both backends, each verifying the other", async () => {
    const web = await selectEd25519();
    const pub = await noblePure.publicKey(seedA);
    const a = await web.sign(seedA, message);
    const b = await noblePure.sign(seedA, message);
    expect(a).toEqual(b);
    expect(await web.verify(pub, b, message)).toBe(true);
    expect(await noblePure.verify(pub, a, message)).toBe(true);
  });

  for (const name of ["webcrypto", "noble"] as const) {
    describe(name, () => {
      let ed: Ed25519;
      beforeAll(async () => {
        ed = name === "noble" ? noblePure : await selectEd25519();
      });

      it("refuses a flipped message bit, a flipped signature bit, the wrong key and a truncated signature", async () => {
        const pub = await ed.publicKey(seedA);
        const sig = await ed.sign(seedA, message);
        expect(await ed.verify(pub, sig, message)).toBe(true);
        expect(await ed.verify(pub, sig, utf8("a signed documenu"))).toBe(false);
        const flipped = Uint8Array.from(sig);
        flipped[10] = (flipped[10] ?? 0) ^ 1;
        expect(await ed.verify(pub, flipped, message)).toBe(false);
        expect(await ed.verify(await ed.publicKey(seedB), sig, message)).toBe(false);
        expect(await ed.verify(pub, sig.slice(0, 63), message)).toBe(false);
      });

      it("refuses a signature whose S is not reduced (malleability)", async () => {
        const pub = await ed.publicKey(seedA);
        const sig = Uint8Array.from(await ed.sign(seedA, message));
        // S + L, the group order, is the same scalar spelled out of range.
        const L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;
        let s = 0n;
        for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i] ?? 0);
        s += L;
        for (let i = 32; i < 64; i++) {
          sig[i] = Number(s & 0xffn);
          s >>= 8n;
        }
        expect(await ed.verify(pub, sig, message)).toBe(false);
      });

      it("refuses the ZIP-215 forgery: a non-canonical small-order key with an all-zero S", async () => {
        const identityNonCanonical = new Uint8Array(32).fill(0xff);
        identityNonCanonical[0] = 0xee;
        identityNonCanonical[31] = 0x7f;
        const sig = new Uint8Array(64);
        sig[0] = 1;
        expect(await ed.verify(identityNonCanonical, sig, message)).toBe(false);
      });

      it("refuses a mixed-order public key (honest key plus an order-2 point) even with a signature crafted to satisfy the equation", async () => {
        const L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;
        const le = (bytes: Uint8Array) => bytes.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
        const orderTwo = noble.Point.fromBytes(Uint8Array.from([0xec, ...new Array(30).fill(0xff), 0x7f]), false);
        const extended = await noble.utils.getExtendedPublicKeyAsync(seedA);
        const mixed = extended.point.add(orderTwo).toBytes();
        // With k even the order-2 component vanishes, so S*B = R + k*A holds for the mixed key.
        let forged: Uint8Array | undefined;
        const m = utf8("forge me");
        for (let r = 1n; r < 64n && !forged; r++) {
          const R = noble.Point.BASE.multiply(r).toBytes();
          const input = new Uint8Array([...R, ...mixed, ...m]);
          const k = le(await noble.hashes.sha512Async(input)) % L;
          if (k % 2n !== 0n) continue;
          const S = (r + k * extended.scalar) % L;
          const sBytes = Uint8Array.from({ length: 32 }, (_, i) => Number((S >> BigInt(8 * i)) & 0xffn));
          forged = new Uint8Array([...R, ...sBytes]);
        }
        expect(forged).toBeDefined();
        expect(await ed.verify(mixed, forged!, m)).toBe(false);
      });

      it("refuses a signature whose R carries a torsion component", async () => {
        const L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;
        const le = (bytes: Uint8Array) => bytes.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
        const orderTwo = noble.Point.fromBytes(Uint8Array.from([0xec, ...new Array(30).fill(0xff), 0x7f]), false);
        const extended = await noble.utils.getExtendedPublicKeyAsync(seedA);
        const pub = extended.pointBytes;
        const m = utf8("torsion in R");
        const r = 5n;
        const R = noble.Point.BASE.multiply(r).add(orderTwo).toBytes();
        const k = le(await noble.hashes.sha512Async(new Uint8Array([...R, ...pub, ...m]))) % L;
        const S = (r + k * extended.scalar) % L;
        const sBytes = Uint8Array.from({ length: 32 }, (_, i) => Number((S >> BigInt(8 * i)) & 0xffn));
        expect(await ed.verify(pub, new Uint8Array([...R, ...sBytes]), m)).toBe(false);
      });

      it("refuses a signature whose R is not a canonical point encoding", async () => {
        const pub = await ed.publicKey(seedA);
        const sig = Uint8Array.from(await ed.sign(seedA, message));
        sig.set(new Uint8Array(32).fill(0xff), 0);
        expect(await ed.verify(pub, sig, message)).toBe(false);
      });

      it("refuses wrong-sized keys and seeds", async () => {
        await expect(ed.sign(new Uint8Array(31), message)).rejects.toThrow();
        await expect(ed.verify(new Uint8Array(31), new Uint8Array(64), message)).rejects.toThrow();
      });
    });
  }

  it("matches the RFC 8032 test vector 1", async () => {
    const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
    const seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    const expected = hex(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
    expect(await (await selectEd25519()).sign(seed, new Uint8Array(0))).toEqual(expected);
    expect(fromBase64Url("")).toEqual(new Uint8Array(0));
  });
});
