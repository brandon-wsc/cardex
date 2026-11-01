import { beforeAll, describe, expect, it } from "vitest";
import { verifyAccessJwt } from "./access";

// Specs for the admin Access JWT check (ADR 0002): the signed assertion is
// verified against pinned team keys — aud, iss, exp and signature all gate.

const enc = new TextEncoder();
const TEAM = "cardex.cloudflareaccess.com";
const AUD = "aud-tag-0123";

const b64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

let privateKey: CryptoKey;
let jwks: { keys: (JsonWebKey & { kid?: string })[] };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwks = { keys: [{ ...jwk, kid: "k1" }] };
});

async function makeJwt(
  payload: Record<string, unknown>,
  key: CryptoKey = privateKey,
  kid = "k1",
): Promise<string> {
  const head = b64(
    enc.encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })),
  );
  const body = b64(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    enc.encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64(sig)}`;
}

const goodPayload = () => ({
  aud: AUD,
  iss: `https://${TEAM}`,
  exp: Math.floor(Date.now() / 1000) + 600,
  email: "owner@example.com",
});

describe("verifyAccessJwt", () => {
  it("returns the email claim from a valid assertion", async () => {
    const jwt = await makeJwt(goodPayload());
    const email = await verifyAccessJwt(jwt, jwks, { aud: AUD, team: TEAM });
    expect(email).toBe("owner@example.com");
  });

  it("accepts aud when the claim is an array", async () => {
    const jwt = await makeJwt({ ...goodPayload(), aud: ["other", AUD] });
    const email = await verifyAccessJwt(jwt, jwks, { aud: AUD, team: TEAM });
    expect(email).toBe("owner@example.com");
  });

  it("rejects a wrong aud, iss, kid or an expired token", async () => {
    const opts = { aud: AUD, team: TEAM };
    for (const payload of [
      { ...goodPayload(), aud: "not-our-app" },
      { ...goodPayload(), iss: "https://evil.cloudflareaccess.com" },
      { ...goodPayload(), exp: Math.floor(Date.now() / 1000) - 10 },
    ]) {
      const jwt = await makeJwt(payload);
      expect(await verifyAccessJwt(jwt, jwks, opts)).toBeNull();
    }
    const wrongKid = await makeJwt(goodPayload(), privateKey, "k2");
    expect(await verifyAccessJwt(wrongKid, jwks, opts)).toBeNull();
  });

  it("rejects a token signed by a different key", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const jwt = await makeJwt(goodPayload(), pair.privateKey);
    expect(
      await verifyAccessJwt(jwt, jwks, { aud: AUD, team: TEAM }),
    ).toBeNull();
  });

  it("rejects malformed assertions", async () => {
    for (const bad of ["a.b.c", "not-a-jwt", "a.b.c.d", ".."]) {
      expect(
        await verifyAccessJwt(bad, jwks, { aud: AUD, team: TEAM }),
      ).toBeNull();
    }
  });
});
