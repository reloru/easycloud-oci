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
 * Path segments are encoded individually; undefined/null query values are dropped.
 * Query parameter order is preserved as given.
 */
export function ociUrl(
  endpoint: string,
  pathSegments: readonly string[],
  query: Record<string, QueryValue> = {},
): string {
  const base = endpoint.replace(/\/+$/, "");
  const path = pathSegments.map(encodeRfc3986).join("/");
  const params = Object.entries(query)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] != null)
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(String(v))}`);
  return `${base}/${path}${params.length ? `?${params.join("&")}` : ""}`;
}

/** Regional endpoint for an OCI service, e.g. ociEndpoint("iaas", "us-ashburn-1"). */
export function ociEndpoint(service: "iaas" | "identity" | "limits" | "telemetry", region: string): string {
  return `https://${service}.${region}.oraclecloud.com`;
}
