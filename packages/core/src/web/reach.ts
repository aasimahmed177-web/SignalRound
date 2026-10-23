import { load } from "cheerio";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { httpUrl } from "./page.ts";
import { type PublicText, type ReadPublicOptions, resolvePublicUrl } from "./transport.ts";
import type { Document } from "./types.ts";

type Reader = (url: string, options?: ReadPublicOptions) => Promise<PublicText>;

/** Agent Reach is a capability router; its web backend is the public Jina Reader. */
export async function reachReader(raw: string, read: Reader, timeoutMs: number): Promise<Document> {
  const { url } = await resolvePublicUrl(raw);
  url.hash = "";
  // Do not disclose signed URLs / query credentials to a third-party reader.
  if (url.search) throw new Error("Reader mode does not accept query strings. Use a public canonical URL without query parameters.");
  const response = await read(`https://r.jina.ai/${url}`, { timeoutMs, maxBytes: 2_000_000, headers: { accept: "text/plain" } });
  const text = response.text;
  if (/requiring captcha|title: just a moment|attention required!|\/cdn-cgi\/challenge-platform|warning:.*(?:403|429)/i.test(text))
    throw new Error("Agent Reach reader returned a block/challenge, not usable page content.");
  const marker = text.indexOf("Markdown Content:");
  if (marker < 0) throw new Error("Agent Reach reader returned an unrecognized response.");
  const markdown = text.slice(marker + "Markdown Content:".length).trim();
  if (!markdown) throw new Error("Agent Reach reader returned no readable content.");
  const links = [...new Set([...markdown.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].flatMap((match) => httpUrl(match[1] ?? "") ?? []))];
  return {
    markdown,
    links,
    metadata: {
      sourceURL: url.toString(),
      url: url.toString(),
      title: /^Title:\s*(.*)$/m.exec(text)?.[1],
      readerReportedURL: /^URL Source:\s*(.*)$/m.exec(text)?.[1],
      provider: "agent-reach:jina",
      fetchedAt: new Date().toISOString(),
      creditsUsed: 0,
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function list(value: unknown): unknown[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}
function plain(value: unknown): string {
  const text = typeof value === "string" ? value : String(object(value)["#text"] ?? "");
  return load(text).text().trim();
}

/** Bounded RSS/Atom normalization, preserving source links rather than treating XML as prose. */
export function feedDocument(response: PublicText): Document | null {
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(response.text)) return null;
  if (/<!DOCTYPE|<!ENTITY/i.test(response.text)) throw new Error("Feed declarations/entities are not supported.");
  if (XMLValidator.validate(response.text) !== true) throw new Error("Invalid RSS/Atom XML.");
  const xml = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(response.text);
  const root = object(xml);
  const rdf = object(root["rdf:RDF"]);
  const feed = object(root.feed ?? object(root.rss).channel ?? rdf.channel);
  // RSS 1.0 stores channel metadata and item records as siblings under rdf:RDF.
  const allEntries = list(feed.entry ?? feed.item ?? rdf.item);
  const entries = allEntries.slice(0, 100).map((value) => {
    const row = object(value);
    const link = list(row.link).find((v) => typeof v === "string" || !object(v)["@_rel"] || object(v)["@_rel"] === "alternate");
    const url = httpUrl(typeof link === "string" ? link : String(object(link)["@_href"] ?? ""), response.url);
    return {
      title: plain(row.title),
      url,
      published: plain(row.published ?? row.pubDate ?? row["dc:date"] ?? row.updated) || null,
      description: plain(row.summary ?? row.description ?? row.content ?? row["content:encoded"]).slice(0, 8000),
    };
  });
  const title = plain(feed.title) || "Feed";
  return {
    markdown: [`# ${title}`, ...entries.map((e) => `## ${e.title}\n${e.url ?? ""}\n${e.published ?? ""}\n${e.description}`)].join("\n\n"),
    links: entries.flatMap((e) => (e.url ? [e.url] : [])),
    json: { title, entries },
    metadata: {
      sourceURL: response.url,
      url: response.url,
      title,
      provider: "native:rss-atom",
      entryCount: entries.length,
      totalEntryCount: allEntries.length,
      truncated: allEntries.length > entries.length,
      fetchedAt: new Date().toISOString(),
      creditsUsed: 0,
    },
  };
}

/** Public API equivalent of Agent Reach's GitHub channel; never uses local login tokens. */
export async function githubDocument(raw: string, read: Reader, timeoutMs: number): Promise<Document | null> {
  const url = new URL(raw);
  if (url.hostname !== "github.com" || url.search || url.username || url.password || url.port) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts.some((p) => !/^[a-z\d_.-]+$/i.test(p) || p === "." || p === "..")) return null;
  const response = await read(`https://api.github.com/repos/${parts.join("/")}`, {
    timeoutMs,
    maxBytes: 1_000_000,
    headers: { accept: "application/vnd.github+json" },
  });
  const data = object(JSON.parse(response.text));
  if (typeof data.full_name !== "string" || typeof data.html_url !== "string") throw new Error("Invalid GitHub repository response.");
  const summary = {
    name: data.full_name,
    description: data.description,
    website: data.homepage,
    stars: data.stargazers_count,
    language: data.language,
    topics: data.topics,
    license: object(data.license).spdx_id,
    updatedAt: data.updated_at,
    archived: data.archived,
  };
  const sourceURL = `https://github.com/${parts.join("/")}`;
  const homepage = typeof data.homepage === "string" ? httpUrl(data.homepage) : null;
  return {
    markdown: `# ${summary.name}\n\n${summary.description ?? ""}\n\n${Object.entries(summary)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : (value ?? "unknown")}`)
      .join("\n")}`,
    json: summary,
    links: [sourceURL, ...(homepage ? [homepage] : [])],
    metadata: {
      sourceURL,
      url: sourceURL,
      title: data.full_name,
      provider: "native:github-api",
      fetchedAt: new Date().toISOString(),
      creditsUsed: 0,
    },
  };
}
