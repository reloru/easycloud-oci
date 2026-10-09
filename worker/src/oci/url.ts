/**
 * Build OCI request URLs. Oracle requires path and query parameters to be
 * URL-encoded per RFC 3986, and the signed (request-target) must match the
 * URL actually sent byte-for-byte, so every OCI URL goes through here.
 * URLSearchParams is deliberately not used: it encodes spaces as "+".
 */

export type QueryValue = string | number | boolean | undefined | null;

/** RFC 3986 percent-encoding: encodeURIComponent plus !'()* */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * ociUrl("https://iaas.us-ashburn-1.oraclecloud.com", ["20160918", "instances"], { compartmentId })
 * Path segments are encoded individually and must not be empty, "." or "..";
 * undefined/null query values are dropped.
 * Query parameter order is preserved as given.
 */
export function ociUrl(
  endpoint: string,
  pathSegments: readonly string[],
  query: Record<string, QueryValue> = {},
): string {
  const base = endpoint.replace(/\/+$/, "");
  for (const segment of pathSegments) {
    // WHATWG URL parsing would collapse these (even percent-encoded), retargeting a signed request.
    if (segment === "" || segment === "." || segment === "..") throw new Error(`Invalid OCI path segment: "${segment}"`);
  }
  const path = pathSegments.map(encodeRfc3986).join("/");
  const params = Object.entries(query)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] != null)
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(String(v))}`);
  return `${base}/${path}${params.length ? `?${params.join("&")}` : ""}`;
}

/**
 * Regional endpoint per service, following the templates in Oracle's SDKs (realm oc1):
 * iaas/telemetry use "{service}.{region}.oraclecloud.com"; identity/limits use "{service}.{region}.oci.oraclecloud.com".
 */
const ENDPOINT_TEMPLATES = {
  iaas: (r: string) => `https://iaas.${r}.oraclecloud.com`,
  telemetry: (r: string) => `https://telemetry.${r}.oraclecloud.com`,
  identity: (r: string) => `https://identity.${r}.oci.oraclecloud.com`,
  limits: (r: string) => `https://limits.${r}.oci.oraclecloud.com`,
} as const;

export function ociEndpoint(service: keyof typeof ENDPOINT_TEMPLATES, region: string): string {
  return ENDPOINT_TEMPLATES[service](region);
}
