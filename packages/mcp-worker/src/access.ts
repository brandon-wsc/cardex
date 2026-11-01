// Cloudflare Access JWT verification for the /admin surface (ADR 0002).
// When ACCESS_TEAM + ACCESS_AUD are configured, the signed
// Cf-Access-Jwt-Assertion assertion is the only identity source — the
// spoofable Cf-Access-Authenticated-User-Email header is ignored. Keys come
// only from the configured team domain, never the token's own iss claim,
// so an attacker cannot point verification at their own JWKS.

const JWKS_TTL_MS = 3_600_000;

export interface AccessJwks {
  keys: (JsonWebKey & { kid?: string })[];
}

interface AccessConfig {
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
}

let jwksCache: { jwks: AccessJwks; at: number } | null = null;

async function fetchJwks(
  team: string,
  fresh: boolean,
): Promise<AccessJwks | null> {
  if (!fresh && jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.jwks;
  }
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`).catch(
    () => null,
  );
  if (!res || !res.ok) return null;
  const jwks = (await res.json()) as AccessJwks;
  jwksCache = { jwks, at: Date.now() };
  return jwks;
}

const b64url = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function decodeJson<T>(s: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64url(s))) as T;
  } catch {
    return null;
  }
}

interface AccessPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  email?: string;
}

interface ParsedAssertion {
  header: { alg?: string; kid?: string };
  payload: AccessPayload;
  signed: string;
  sig: string;
}

function parseAssertion(assertion: string): ParsedAssertion | null {
  const [head, body, sig] = assertion.split(".");
  if (!head || !body || !sig) return null;
  const header = decodeJson<ParsedAssertion["header"]>(head);
  const payload = decodeJson<AccessPayload>(body);
  if (!header || !payload || header.alg !== "RS256" || !header.kid)
    return null;
  return { header, payload, signed: `${head}.${body}`, sig };
}

async function signatureValid(
  parsed: ParsedAssertion,
  jwks: AccessJwks,
): Promise<boolean> {
  const jwk = jwks.keys.find((k) => k.kid === parsed.header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle
    .verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64url(parsed.sig),
      new TextEncoder().encode(parsed.signed),
    )
    .catch(() => false);
}

function claimsEmail(
  payload: AccessPayload,
  opts: { aud: string; team: string },
): string | null {
  if (!payload.exp || payload.exp * 1000 <= Date.now()) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(opts.aud) || payload.iss !== `https://${opts.team}`)
    return null;
  return payload.email ?? null;
}

export async function verifyAccessJwt(
  assertion: string,
  jwks: AccessJwks,
  opts: { aud: string; team: string },
): Promise<string | null> {
  const parsed = parseAssertion(assertion);
  if (!parsed || !(await signatureValid(parsed, jwks))) return null;
  return claimsEmail(parsed.payload, opts);
}

// Returns the verified identity, or null when unconfigured or the assertion
// is absent/invalid. Retries once with a fresh JWKS — Access rotates keys.
export async function accessIdentity(
  request: Request,
  env: AccessConfig,
): Promise<string | null> {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) return null;
  for (const fresh of [false, true]) {
    const jwks = await fetchJwks(env.ACCESS_TEAM, fresh);
    if (!jwks) return null;
    const email = await verifyAccessJwt(assertion, jwks, {
      aud: env.ACCESS_AUD,
      team: env.ACCESS_TEAM,
    });
    if (email) return email;
  }
  return null;
}
