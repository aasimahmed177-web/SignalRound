// Server-side fetches of URLs the web wrote. A stored logo URL came off a third-party page through an
// extractor, so a crafted page could name http://169.254.169.254/, http://localhost:9001/, or a host
// that resolves to a private address, and the logo route (open to anyone) would fetch it from inside
// the deployment. These helpers refuse anything but http(s) on the default ports to a public address,
// and follow redirects by hand so each hop is checked again. A host that re-resolves between the check
// and the connection (DNS rebinding) is out of reach here; the fetch still gets only an image back,
// and only an image's bytes are ever returned to a reader.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Every address a resolver returns for a host. */
export type Resolve = (host: string) => Promise<string[]>;

const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Loopback, private, link-local, carrier-grade NAT, benchmark, multicast, and reserved space, v4 or v6. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return ipv4Private(ip);
  if (version !== 6) return true;
  const v6 = ip.toLowerCase();
  // A v4 address written inside a v6 one (::ffff:127.0.0.1, ::127.0.0.1, 64:ff9b::a.b.c.d) is judged as v4.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (dotted) return ipv4Private(dotted[1]);
  // Only global unicast (2000::/3) is public, less the prefixes that tunnel to a v4 address (6to4,
  // Teredo) and the documentation range; the URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1, so
  // the mapped and compatible forms land here in hex and are refused with the rest of ::/8.
  return !/^[23][0-9a-f]{0,3}:/.test(v6) || /^(2002:|2001:0:|2001:db8:)/.test(v6);
}

/**
 * The URL when it is safe to fetch from the server: http or https, no credentials, the default port,
 * and a host that is neither a private address nor resolves to one. Null otherwise, never a throw.
 */
export async function publicUrl(raw: string, resolve: Resolve = systemResolve): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) return isPrivateAddress(host) ? null : url;
  if (!host.includes(".") || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return null;
  try {
    const addresses = await resolve(host);
    return addresses.length > 0 && !addresses.some(isPrivateAddress) ? url : null;
  } catch {
    return null;
  }
}

const MAX_REDIRECTS = 3;

/**
 * fetch for a URL the web wrote: every hop, the first and each redirect's target, must pass publicUrl.
 * Resolves to null when one does not, or when the redirects run past three.
 */
export async function safeFetch(raw: string, init: RequestInit = {}, resolve: Resolve = systemResolve): Promise<Response | null> {
  let next = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await publicUrl(next, resolve);
    if (!url) return null;
    const res = await fetch(url, { ...init, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    await res.body?.cancel();
    next = new URL(location, url).toString();
  }
  return null;
}
