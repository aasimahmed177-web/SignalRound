import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as cheerio from "cheerio";

type Candidate = {
  name: string;
  announcedOn: string;
  stage: "pre_seed" | "seed" | "series_a" | "series_b";
  stageAsWritten: string;
  amountAsWritten: string;
  sector: string;
  subsector: string;
  businessModel: string;
  investors: string[];
  sourceUrl: string;
  sourceTitle: string;
};

const INPUT = process.argv[2] ?? "data/india-funding-candidates.json";
const OUTPUT = process.argv[3] ?? "data/india-funding-leads-resolved.json";
const LIMIT = Number(process.env.RESOLVE_LIMIT ?? 100);
const CONCURRENCY = Number(process.env.RESOLVE_CONCURRENCY ?? 6);
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141 Safari/537.36";
const PATHS = [
  "/",
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
  "/support",
  "/help",
  "/privacy",
  "/privacy-policy",
  "/privacypolicy",
  "/terms",
  "/termsofuse",
  "/terms-and-conditions",
  "/info/privacy-policy",
  "/info/terms-of-service",
];
const WEBSITE_OVERRIDES = existsSync("data/company-website-overrides.json")
  ? (JSON.parse(readFileSync("data/company-website-overrides.json", "utf8")) as Record<string, string>)
  : {};
const EMAIL_DOMAIN_ALIASES = existsSync("data/company-email-domain-aliases.json")
  ? (JSON.parse(readFileSync("data/company-email-domain-aliases.json", "utf8")) as Record<string, string[]>)
  : {};
const BLOCKED_HOSTS = [
  "bing.com",
  "google.com",
  "duckduckgo.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "x.com",
  "twitter.com",
  "crunchbase.com",
  "tracxn.com",
  "inc42.com",
  "yourstory.com",
  "entrackr.com",
  "economictimes.com",
  "moneycontrol.com",
  "business-standard.com",
  "vccircle.com",
  "pitchbook.com",
  "medium.com",
  "wikipedia.org",
  "play.google.com",
  "apps.apple.com",
  "zaubacorp.com",
  "tofler.in",
  "thecompanycheck.com",
];
const GENERIC_NAME_TOKENS = new Set([
  "ai",
  "app",
  "apps",
  "india",
  "labs",
  "technologies",
  "technology",
  "solutions",
  "private",
  "limited",
  "pvt",
  "company",
]);

const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const tokens = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !GENERIC_NAME_TOKENS.has(token));
const normalized = (value: string) => tokens(value).join("");
const host = (value: string) => {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const rootDomain = (hostname: string) => {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  const secondLevel = new Set(["co.in", "com.au", "co.uk", "co.nz", "com.sg", "co.za", "com.br"]);
  return secondLevel.has(parts.slice(-2).join(".")) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
};
const blocked = (hostname: string) => BLOCKED_HOSTS.some((item) => hostname === item || hostname.endsWith(`.${item}`));

async function fetchText(url: string, timeout = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/html") && !type.includes("text/plain")) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (html.length < 3_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    if (html.length >= 3_000_000) await reader.cancel();
    else html += decoder.decode();
    return { html, url: response.url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function unwrapBing(href: string) {
  try {
    const url = new URL(href);
    const encoded = url.searchParams.get("u");
    if (url.hostname.endsWith("bing.com") && encoded?.startsWith("a1")) return Buffer.from(encoded.slice(2), "base64url").toString("utf8");
    return href;
  } catch {
    return href;
  }
}

function unwrapDuckDuckGo(href: string) {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    return url.searchParams.get("uddg") ?? url.toString();
  } catch {
    return href;
  }
}

function scoreResult(candidate: Candidate, url: string, title: string, snippet: string) {
  const hostname = host(url);
  if (!hostname || blocked(hostname)) return -100;
  const companyTokens = tokens(candidate.name);
  const domainToken = hostname.split(".")[0].replace(/[^a-z0-9]/g, "");
  const nameKey = normalized(candidate.name);
  const text = `${title} ${snippet}`.toLowerCase();
  let score = 0;
  if (nameKey.length >= 4 && domainToken.includes(nameKey)) score += 12;
  if (nameKey.length >= 4 && nameKey.includes(domainToken) && domainToken.length >= 4) score += 7;
  for (const token of companyTokens) {
    if (domainToken.includes(token)) score += 4;
    if (text.includes(token)) score += 2;
  }
  if (/official|home|about/.test(text)) score += 1;
  if (/startup|india|indian/.test(text)) score += 1;
  return score;
}

async function findWebsite(candidate: Candidate) {
  const override = WEBSITE_OVERRIDES[candidate.name];
  if (override) {
    const page = await fetchText(override, 7_000);
    if (page) return { url: new URL(page.url).origin + "/", seedHtml: page.html };
  }
  const guessedStem = normalized(candidate.name);
  const statedTldHost = candidate.name.toLowerCase().match(/\.([a-z]{2,4})$/)
    ? candidate.name.toLowerCase().replace(/[^a-z0-9.]/g, "")
    : "";
  const guessedHosts = [
    ...new Set([
      statedTldHost,
      `${guessedStem}.in`,
      `${guessedStem}.ai`,
      `${guessedStem}.com`,
      `${guessedStem}.co`,
      `${guessedStem}.app`,
      `${guessedStem}.io`,
    ]),
  ].filter(Boolean);
  const guessedPages = await Promise.all(guessedHosts.map((guessedHost) => fetchText(`https://${guessedHost}/`, 4_000)));
  for (const page of guessedPages) {
    if (!page) continue;
    const body = cheerio.load(page.html)("body").text().slice(0, 30_000).toLowerCase();
    const meaningful = tokens(candidate.name).filter((token) => token.length >= 4);
    if (meaningful.some((token) => body.includes(token))) return { url: new URL(page.url).origin + "/", seedHtml: page.html };
  }
  if (process.env.RESOLVE_DIRECT_ONLY === "1") return null;
  const queries = [`"${candidate.name}" startup India official`, `"${candidate.name}" ${candidate.sector} contact`];
  const results: { url: string; title: string; snippet: string; score: number }[] = [];
  const searchPages = await Promise.all(
    queries.flatMap((query) => [
      fetchText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`, 7_000).then((page) => ({ engine: "bing", page })),
      fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 7_000).then((page) => ({ engine: "duck", page })),
    ]),
  );
  for (const search of searchPages) {
    const page = search.page;
    if (!page) continue;
    const $ = cheerio.load(page.html);
    if (search.engine === "bing") {
      $("li.b_algo").each((_index, element) => {
        const anchor = $(element).find("h2 a").first();
        const url = unwrapBing(anchor.attr("href") ?? "");
        const title = clean(anchor.text());
        const snippet = clean($(element).find(".b_caption p").text());
        results.push({ url, title, snippet, score: scoreResult(candidate, url, title, snippet) });
      });
    } else {
      $(".result").each((_index, element) => {
        const anchor = $(element).find("a.result__a").first();
        const url = unwrapDuckDuckGo(anchor.attr("href") ?? "");
        const title = clean(anchor.text());
        const snippet = clean($(element).find(".result__snippet").text());
        results.push({ url, title, snippet, score: scoreResult(candidate, url, title, snippet) });
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  for (const result of results.filter((item) => item.score >= 6).slice(0, 3)) {
    const page = await fetchText(result.url, 5_000);
    if (!page) continue;
    const body = cheerio.load(page.html)("body").text().slice(0, 20_000).toLowerCase();
    const matchesName = tokens(candidate.name).some((token) => token.length >= 4 && body.includes(token));
    if (matchesName) return { url: new URL(page.url).origin + "/", seedHtml: page.html };
  }
  return null;
}

const EMAIL_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}/gi;
function validEmail(email: string, websiteHost: string) {
  const value = email
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[),.;:]+$/, "");
  if (/example\.|test@|noreply|no-reply|sentry|wixpress|cloudflare|wordpress|godaddy/.test(value)) return false;
  const emailHost = value.split("@")[1];
  const websiteRoot = rootDomain(websiteHost);
  return (
    rootDomain(emailHost) === websiteRoot ||
    (EMAIL_DOMAIN_ALIASES[websiteRoot] ?? []).includes(rootDomain(emailHost)) ||
    /@(gmail|outlook|hotmail|yahoo)\.(com|in)$/.test(value)
  );
}

function contactType(email: string) {
  const local = email.split("@")[0];
  if (/^(hello|hi|hey)$/.test(local)) return "hello";
  if (/sales|growth/.test(local)) return "sales";
  if (/business|partnership|partner/.test(local)) return "business";
  if (/^(info|office)$/.test(local)) return "info";
  if (/contact|support|help|care/.test(local)) return "contact";
  if (/press|media|pr|news/.test(local)) return "media";
  return "other_role";
}

async function inspectWebsite(website: string, seedHtml: string) {
  const websiteHost = host(website);
  const pages: { url: string; html: string }[] = [{ url: website, html: seedHtml }];
  const root = new URL(website).origin;
  const $ = cheerio.load(seedHtml);
  const discovered = $("a[href]")
    .map((_i, element) => $(element).attr("href") ?? "")
    .get()
    .filter((href) => /contact|about|privacy|terms/i.test(href));
  const urls = [
    ...new Set([
      ...PATHS.slice(1).map((path) => `${root}${path}`),
      ...discovered.map((href) => {
        try {
          return new URL(href, root).toString();
        } catch {
          return "";
        }
      }),
    ]),
  ]
    .filter((url) => url && host(url) === websiteHost)
    .slice(0, 8);
  const fetched = await Promise.all(urls.map((url) => fetchText(url, 5_000)));
  for (const page of fetched) if (page) pages.push(page);
  const contacts = new Map<string, string>();
  for (const page of pages) {
    const decoded = page.html.replace(/&#64;|&#x40;|\[at\]|\(at\)/gi, "@").replace(/&#46;|&#x2e;|\[dot\]|\(dot\)/gi, ".");
    for (const match of decoded.match(EMAIL_RE) ?? []) {
      const email = match
        .toLowerCase()
        .replace(/^[^a-z0-9]+/, "")
        .replace(/[),.;:]+$/, "");
      if (validEmail(email, websiteHost)) contacts.set(email, page.url);
    }
  }
  const home = cheerio.load(seedHtml);
  const description = clean(
    home('meta[name="description"]').attr("content") ??
      home('meta[property="og:description"]').attr("content") ??
      home("h1").first().text(),
  ).slice(0, 360);
  const title = clean(home("title").text()).slice(0, 160);
  return { contacts, description, title, sourceUrls: [...new Set(pages.map((page) => page.url))] };
}

function amount(candidate: Candidate) {
  const text = candidate.amountAsWritten.replace(/\*/g, "").trim();
  const match = text.match(/\$\s*([0-9.]+)\s*(K|Mn|M|million)?/i);
  if (!match) return { currency: "UNDISCLOSED" };
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  return { amountUsd: unit === "k" ? value / 1000 : value, currency: "USD" };
}

function lead(candidate: Candidate, website: string, inspection: Awaited<ReturnType<typeof inspectWebsite>>) {
  const rawAmountText = candidate.amountAsWritten.replace(/\*/g, "").trim();
  const amountText = rawAmountText === "–" || rawAmountText === "-" ? "Undisclosed" : rawAmountText;
  const investorText = candidate.investors.length ? ` Investors listed include ${candidate.investors.slice(0, 3).join(", ")}.` : "";
  const siteDetail =
    inspection.description ||
    inspection.title ||
    `${candidate.name} operates in ${candidate.sector}${candidate.subsector ? ` / ${candidate.subsector}` : ""}.`;
  return {
    company: {
      name: candidate.name,
      website,
      category: [candidate.sector, candidate.subsector].filter(Boolean).join(" / "),
      description: siteDetail,
      operatingStatus: "active",
      personalizationHooks: [
        `${candidate.name} announced a ${amountText || "new"} ${candidate.stageAsWritten} on ${candidate.announcedOn}.`,
        candidate.investors.length
          ? `The round included ${candidate.investors.slice(0, 3).join(", ")}.`
          : `The ${candidate.stageAsWritten} was reported by Inc42.`,
        siteDetail,
      ],
      relevanceNotes: `Freshly funded Indian ${candidate.sector.toLowerCase()} company; outreach can reference its ${candidate.stageAsWritten} and current ${candidate.subsector || candidate.businessModel} focus.`,
      sourceUrls: [...new Set([candidate.sourceUrl, website, ...inspection.sourceUrls])],
      researchedAt: new Date().toISOString(),
    },
    round: {
      stage: candidate.stage,
      stageAsWritten: candidate.stageAsWritten,
      ...amount(candidate),
      amountAsWritten: amountText,
      announcedOn: candidate.announcedOn,
      investors: candidate.investors,
      sourceUrl: candidate.sourceUrl,
      sourceTitle: candidate.sourceTitle,
      evidence: `${candidate.sourceTitle} lists ${candidate.name}'s ${amountText ? `${amountText} ` : ""}${candidate.stageAsWritten} on ${candidate.announcedOn}.${investorText}`,
      verificationStatus: "reported",
    },
    contacts: [...inspection.contacts.entries()].map(([email, sourceUrl]) => ({ email, contactType: contactType(email), sourceUrl })),
  };
}

const candidates = JSON.parse(readFileSync(INPUT, "utf8")) as Candidate[];
const priorFiles = [
  "data/india-funding-leads.json",
  "data/india-funding-leads-batch-2.json",
  "data/india-funding-leads-batch-3.json",
  OUTPUT,
];
const prior = priorFiles.flatMap((file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []));
const seenNames = new Set(prior.map((item: any) => item.company.name.toLowerCase()));
if (existsSync("data/india-funding-rejections.json")) {
  for (const name of JSON.parse(readFileSync("data/india-funding-rejections.json", "utf8"))) seenNames.add(String(name).toLowerCase());
}
const output: unknown[] = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, "utf8")) : [];
let cursor = 0;
let completed = 0;

async function worker() {
  while (output.length < LIMIT) {
    const index = cursor++;
    if (index >= candidates.length) return;
    const candidate = candidates[index];
    if (seenNames.has(candidate.name.toLowerCase())) continue;
    const found = await findWebsite(candidate);
    if (!found) {
      console.log(`[skip website] ${candidate.name}`);
      continue;
    }
    const inspection = await inspectWebsite(found.url, found.seedHtml);
    if (!inspection.contacts.size) {
      console.log(`[skip email] ${candidate.name} -> ${found.url}`);
      continue;
    }
    if (seenNames.has(candidate.name.toLowerCase()) || output.length >= LIMIT) continue;
    seenNames.add(candidate.name.toLowerCase());
    output.push(lead(candidate, found.url, inspection));
    writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
    completed += 1;
    console.log(
      `[${output.length}/${LIMIT}] ${candidate.name} -> ${found.url} (${inspection.contacts.size} email${inspection.contacts.size === 1 ? "" : "s"})`,
    );
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.log(JSON.stringify({ input: candidates.length, addedThisRun: completed, resolved: output.length, output: OUTPUT }, null, 2));
