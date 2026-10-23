import { createHash } from "node:crypto";
import { load } from "cheerio";
import { analyzeFunnelUrl, inspectEventSnippets, redactSnippetText } from "../funnel/url-analysis.ts";
import { httpUrl, parseHtmlPage } from "./page.ts";
import { readPublicText } from "./transport.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const cap = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 500);
const patterns = [
  ["Meta", /fbq\s*\(|connect\.facebook\.net/i],
  ["Google", /gtag\s*\(|googletagmanager\.com|GTM-[A-Z0-9]+/i],
  ["TikTok", /ttq\.|analytics\.tiktok\.com/i],
  ["Clarity", /clarity\.ms/i],
  ["experiment", /varify|optimizely|abTest/i],
  ["routing", /location\.(?:href|replace|assign)|redirectUrl/i],
  ["scoring", /(?:lead|propensity|calculated)[_ -]?score|score\s*[+:=]/i],
  ["attribution", /fbclid|gclid|gbraid|wbraid|utm_source/i],
  ["browser storage", /localStorage|sessionStorage|document\.cookie/i],
] as const;

/** Source presence is not evidence that an event fired or a branch executed. */
export function sourceClues(text: string, sourceURL: string) {
  return patterns.flatMap(([kind, regex]) => {
    const match = regex.exec(text);
    return match
      ? [
          {
            kind,
            sourceURL,
            offset: match.index,
            evidence: redactSnippetText(text.slice(Math.max(0, match.index - 80), match.index + 220)),
            certainty: "source-reference-only",
          },
        ]
      : [];
  });
}

export function inspectFunnelHtml(html: string, url: string) {
  const $ = load(html);
  const doc = parseHtmlPage(html, url, false);
  const eventSnippets = inspectEventSnippets(html, url);
  const links = $("a[href]")
    .toArray()
    .slice(0, 300)
    .flatMap((el) => {
      const href = httpUrl($(el).attr("href") ?? "", url);
      return href ? [{ url: href, label: cap($(el).text()), relation: "link-observed-not-followed" }] : [];
    });
  return {
    url,
    urlAnalysis: analyzeFunnelUrl(url),
    title: doc.metadata?.title ?? "",
    markdown: doc.markdown?.slice(0, 100_000) ?? "",
    contentHash: hash(html),
    fetchedAt: new Date().toISOString(),
    headings: $("h1,h2,h3")
      .toArray()
      .slice(0, 100)
      .map((el) => cap($(el).text())),
    buttons: $("button,input[type=submit]")
      .toArray()
      .slice(0, 100)
      .map((el) => cap($(el).text() || $(el).attr("value") || "")),
    links,
    forms: $("form")
      .toArray()
      .slice(0, 30)
      .map((el) => ({
        action: httpUrl($(el).attr("action") ?? url, url),
        method: ($(el).attr("method") ?? "GET").toUpperCase(),
        fields: $(el)
          .find("input,select,textarea")
          .toArray()
          .slice(0, 100)
          .map((field) => ({
            name: $(field).attr("name") ?? "",
            id: $(field).attr("id") ?? "",
            type: $(field).attr("type") ?? field.tagName,
            label: (() => {
              const node = $(field);
              const ids = (node.attr("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
              const labelled = ids
                .map((id) =>
                  $("[id]")
                    .filter((_, el) => $(el).attr("id") === id)
                    .text(),
                )
                .join(" ");
              const id = node.attr("id");
              const explicit = id
                ? $("label[for]")
                    .filter((_, el) => $(el).attr("for") === id)
                    .text()
                : "";
              return cap(node.attr("aria-label") || labelled || explicit || node.closest("label").text() || node.attr("placeholder") || "");
            })(),
            required: $(field).attr("required") !== undefined,
            options: $(field)
              .find("option")
              .toArray()
              .slice(0, 100)
              .map((option) => cap($(option).text())),
            // Do not export prefilled names, email, phone, hidden session or CSRF values.
          })),
      })),
    embeds: $("iframe,video,source,track")
      .toArray()
      .slice(0, 100)
      .map((el) => ({
        kind: el.tagName,
        url: httpUrl($(el).attr("src") ?? $(el).attr("data-src") ?? "", url),
        title: cap($(el).attr("title") ?? ""),
        language: $(el).attr("srclang") ?? null,
      })),
    scripts: $("script[src]")
      .toArray()
      .slice(0, 100)
      .flatMap((el) => httpUrl($(el).attr("src") ?? "", url) ?? []),
    inlineScripts: $("script:not([src])")
      .toArray()
      .slice(0, 100)
      .map((el, index) => {
        const text = $(el).text();
        return { index, contentHash: hash(text), characters: text.length, clues: sourceClues(text, `${url}#inline-script-${index}`) };
      }),
    eventSnippets,
    declaredEvents: [...new Set(eventSnippets.map((event) => event.event))],
    userDataParameterNames: [...new Set(eventSnippets.flatMap((event) => event.parameterNames))],
    limitations: [
      "Static HTML only; JavaScript-rendered fields may be absent.",
      "Scripts are inspected as text, never executed. Event firing and backend behavior are unknown.",
    ],
  };
}

export async function auditFunnel(rawUrls: string[], limit = 5, read = readPublicText) {
  if (!Array.isArray(rawUrls) || !rawUrls.length || rawUrls.length > 10) throw new Error("Provide 1–10 public page URLs.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Choose a page limit from 1 to 25.");
  const urls = [
    ...new Set(
      rawUrls.map((raw) => {
        const url = typeof raw === "string" ? httpUrl(raw.trim()) : null;
        if (!url || url.length > 2000) throw new Error("Every audit input must be a public HTTP(S) URL under 2000 characters.");
        // Avoid exporting supplied contact/session parameters in a report.
        if (new URL(url).search) throw new Error("Use canonical audit URLs without query strings or personal information.");
        return url;
      }),
    ),
  ];
  const pages: Array<ReturnType<typeof inspectFunnelHtml> & { requestedURL: string }> = [];
  const assets: Array<{
    url: string;
    contentHash: string;
    characters: number;
    clues: ReturnType<typeof sourceClues>;
    eventSnippets: ReturnType<typeof inspectEventSnippets>;
  }> = [];
  const errors: Array<{ url: string; error: string }> = [];
  const seenAssets = new Set<string>();
  const signal = AbortSignal.timeout(60_000);
  for (const url of urls.slice(0, limit)) {
    try {
      const response = await read(url, { signal, timeoutMs: 12_000, maxBytes: 2_000_000 });
      if (!/html/i.test(response.contentType) && !/<html|<!doctype html/i.test(response.text)) throw new Error("Audit needs an HTML page.");
      const page = { ...inspectFunnelHtml(response.text, response.url), requestedURL: url };
      pages.push(page);
      // Only same-origin script files. Third-party references remain in the report.
      for (const src of page.scripts
        .filter((src) => new URL(src).origin === new URL(response.url).origin && /\.m?js$/i.test(new URL(src).pathname))
        .slice(0, 2)) {
        if (seenAssets.has(src) || seenAssets.size >= 10) continue;
        seenAssets.add(src);
        try {
          const script = await read(src, { signal, timeoutMs: 8000, maxBytes: 2_000_000 });
          assets.push({
            url: script.url,
            contentHash: hash(script.text),
            characters: script.text.length,
            clues: sourceClues(script.text, script.url),
            eventSnippets: inspectEventSnippets(script.text, script.url),
          });
        } catch (error) {
          errors.push({ url: src, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      errors.push({ url, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    status: !pages.length ? "failed" : errors.length || urls.length > limit ? "partial" : "completed",
    scope: "passive-source-audit",
    pages,
    assets,
    errors,
    omittedUrls: urls.slice(limit),
    creditsUsed: 0,
    journey: pages.flatMap((page) =>
      page.links.map((link) => ({ from: page.url, to: link.url, label: link.label, certainty: link.relation })),
    ),
    unknowns: [
      "Live redirects, runtime events and experiment assignments",
      "Form submissions and conditional questionnaire paths",
      "Video speech without published captions",
      "Private CRM, CAPI and scoring thresholds",
      "Login-gated social content",
    ],
  };
}
