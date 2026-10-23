import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export type ResolveAddresses = (host: string) => Promise<Array<{ address: string; family: number }>>;
const resolveSystem: ResolveAddresses = (host) => lookup(host, { all: true, verbatim: true });

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const v6 = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  const [first, second = "0"] = v6.split(":");
  return (
    /^[23][0-9a-f]{0,3}:/.test(v6) &&
    first !== "2002" &&
    first !== "3fff" &&
    !(first === "2001" && (Number.parseInt(second || "0", 16) < 0x200 || second === "db8"))
  );
}

export async function resolvePublicUrl(raw: string, resolve: ResolveAddresses = resolveSystem, trustedOrigin?: string) {
  const url = new URL(raw);
  const trusted = trustedOrigin !== undefined && url.origin === new URL(trustedOrigin).origin;
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !trusted)) {
    throw new Error("Only public HTTP(S) URLs on standard ports are allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!trusted && !isIP(host) && (!host.includes(".") || /\.(?:localhost|local|internal|lan|home\.arpa)$/i.test(host))) {
    throw new Error("Private host is not allowed");
  }
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  const selected = addresses.find(({ family }) => family === 4) ?? addresses[0];
  if (!selected || (!trusted && addresses.some(({ address }) => !isPublicAddress(address))))
    throw new Error("Private or reserved address is not allowed");
  return { url, host, address: selected.address, family: selected.family };
}

export interface PublicText {
  text: string;
  url: string;
  status: number;
  contentType: string;
}
export interface ReadPublicOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  resolve?: ResolveAddresses;
  headers?: Record<string, string>;
  /** Only an operator-configured service endpoint (e.g. local SearXNG), never a discovered URL. */
  trustedOrigin?: string;
}

/** DNS is checked once per hop and that exact address is used for the socket, including TLS. */
export async function readPublicText(raw: string, options: ReadPublicOptions = {}): Promise<PublicText> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)])
    : AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const maxBytes = options.maxBytes ?? 4_000_000;
  let next = raw;
  for (let hop = 0; hop <= 4; hop++) {
    signal.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const target = await Promise.race([
      resolvePublicUrl(next, options.resolve, options.trustedOrigin),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]).finally(() => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    });
    signal.throwIfAborted();
    const forwardedHeaders = Object.fromEntries(
      Object.entries(options.headers ?? {}).filter(
        ([name]) => !/^(?:authorization|proxy-authorization|cookie|host|connection)$/i.test(name),
      ),
    );
    const result = await new Promise<PublicText | { redirect: string }>((resolve, reject) => {
      const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(
        {
          protocol: target.url.protocol,
          hostname: target.address,
          port: target.url.port || undefined,
          family: target.family,
          servername: isIP(target.host) ? undefined : target.host,
          path: `${target.url.pathname}${target.url.search}`,
          method: "GET",
          signal,
          headers: {
            "user-agent": "SignalRound/0.2 (+https://github.com/aasimahmed177-web/SignalRound)",
            accept: "text/html,application/xhtml+xml,application/xml,application/rss+xml,text/plain;q=0.9,*/*;q=0.1",
            ...forwardedHeaders,
            host: target.url.host,
            "accept-encoding": "identity",
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.destroy();
            resolve({ redirect: new URL(res.headers.location, target.url).toString() });
            return;
          }
          if (status < 200 || status >= 300) {
            res.destroy();
            reject(new Error(`HTTP ${status} reading ${target.url.hostname}`));
            return;
          }
          if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
            res.destroy();
            reject(new Error(`Response exceeds ${maxBytes} bytes`));
            return;
          }
          const encoding = res.headers["content-encoding"]?.toLowerCase();
          const decoder =
            encoding === "gzip"
              ? createGunzip()
              : encoding === "br"
                ? createBrotliDecompress()
                : encoding === "deflate"
                  ? createInflate()
                  : null;
          if (encoding && encoding !== "identity" && !decoder) {
            res.destroy();
            reject(new Error(`Unsupported content encoding: ${encoding}`));
            return;
          }
          const stream = decoder ? res.pipe(decoder) : res;
          let size = 0;
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              res.destroy();
              stream.destroy();
              reject(new Error(`Response exceeds ${maxBytes} bytes`));
            } else chunks.push(chunk);
          });
          res.on("error", reject);
          stream.on("error", reject);
          stream.on("end", () =>
            resolve({
              text: Buffer.concat(chunks).toString("utf8"),
              url: target.url.toString(),
              status,
              contentType: String(res.headers["content-type"] ?? ""),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
    if ("redirect" in result) next = result.redirect;
    else return result;
  }
  throw new Error("Too many redirects");
}
