/**
 * OCI API request signing (draft-cavage HTTP Signatures, rsa-sha256).
 * https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm
 *
 * Header selection, ordering and the Authorization layout mirror Oracle's
 * Python SDK (oci.signer), which the tests use as the byte-exact reference for
 * canonical (ociUrl-built) URLs. The URL is normalised (fragment and a bare "?"
 * dropped) and returned as SignedRequest.url: always send that exact URL.
 */

export interface OciCredentials {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  /** RSASSA-PKCS1-v1_5 / SHA-256 private key with the "sign" usage. */
  privateKey: CryptoKey;
}

export interface OciRequest {
  method: string;
  /** Fully encoded URL; build it with ociUrl() so the signed target matches what is sent. */
  url: string;
  headers?: HeadersInit;
  body?: string | Uint8Array;
}

export interface SignedRequest {
  /** Canonical URL that was signed; send exactly this. */
  url: string;
  /** Headers to send, including date, authorization and (for body methods) the content headers. */
  headers: Headers;
  /** Encoded body to send (body methods only); content-length and x-content-sha256 describe these bytes. */
  body?: Uint8Array;
  signingString: string;
}

const GENERIC_HEADERS = ["date", "(request-target)", "host"] as const;
const BODY_HEADERS = ["content-length", "content-type", "x-content-sha256"] as const;
const SIGNABLE_METHODS = new Set(["GET", "HEAD", "DELETE", "PUT", "POST", "PATCH"]);
const BODY_METHODS = new Set(["PUT", "POST", "PATCH"]);

const encoder = new TextEncoder();

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function keyId(creds: Pick<OciCredentials, "tenancyOcid" | "userOcid" | "fingerprint">): string {
  return `${creds.tenancyOcid}/${creds.userOcid}/${creds.fingerprint}`;
}

/** Import a PKCS#8 PEM ("BEGIN PRIVATE KEY") RSA private key for OCI signing. */
export async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  if (/BEGIN (RSA |ENCRYPTED )PRIVATE KEY/.test(pem)) {
    throw new Error("Unsupported key format: expected an unencrypted PKCS#8 PEM (BEGIN PRIVATE KEY)");
  }
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem);
  if (!match?.[1]) throw new Error("No PKCS#8 private key found in PEM input");
  const der = fromBase64(match[1].replace(/\s+/g, ""));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** RFC 7231 IMF-fixdate, e.g. "Thu, 05 Jan 2014 21:31:40 GMT". */
export function httpDate(date: Date): string {
  return date.toUTCString();
}

export async function signRequest(
  request: OciRequest,
  creds: OciCredentials,
  now: Date = new Date(),
): Promise<SignedRequest> {
  const method = request.method.toUpperCase();
  if (!SIGNABLE_METHODS.has(method)) throw new Error(`Cannot sign HTTP method ${method}`);

  const url = new URL(request.url);
  url.hash = "";
  if (url.search === "") url.search = ""; // drops a bare "?" that fetch would otherwise send
  const headers = new Headers(request.headers);
  if (!headers.has("date")) headers.set("date", httpDate(now));

  const values: Record<string, string> = {
    date: headers.get("date")!,
    "(request-target)": `${method.toLowerCase()} ${url.pathname}${url.search}`,
    host: url.host,
  };
  const signed: string[] = [...GENERIC_HEADERS];

  let body: Uint8Array | undefined;
  if (BODY_METHODS.has(method)) {
    body = typeof request.body === "string" ? encoder.encode(request.body) : (request.body ?? new Uint8Array());
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (!headers.has("x-content-sha256")) {
      headers.set("x-content-sha256", toBase64(await crypto.subtle.digest("SHA-256", body)));
    }
    headers.set("content-length", String(body.byteLength));
    for (const name of BODY_HEADERS) values[name] = headers.get(name)!;
    signed.push(...BODY_HEADERS);
  } else if (request.body !== undefined) {
    throw new Error(`${method} requests must not have a body`);
  }

  const signingString = signed.map((name) => `${name}: ${values[name]}`).join("\n");
  const signature = toBase64(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", creds.privateKey, encoder.encode(signingString)),
  );
  headers.set(
    "authorization",
    `Signature algorithm="rsa-sha256",headers="${signed.join(" ")}",keyId="${keyId(creds)}",signature="${signature}",version="1"`,
  );
  return { url: url.href, headers, body, signingString };
}
