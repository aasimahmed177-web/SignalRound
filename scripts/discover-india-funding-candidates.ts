import { writeFileSync } from "node:fs";
import * as cheerio from "cheerio";

const CUTOFF = "2025-10-16";
const OUTPUT = process.argv[2] ?? "data/india-funding-candidates.json";
const SEARCHES = ["Indian Startups Raised This Week", "Indian Startups Raised", "Startup Funding Of The Week"];
const STAGES = new Map([
  ["pre-seed", "pre_seed"],
  ["pre seed", "pre_seed"],
  ["seed", "seed"],
  ["series a", "series_a"],
  ["series b", "series_b"],
]);

const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const isoDate = (value: string) => {
  const parsed = new Date(`${value} UTC`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
};

async function getJson(url: string) {
  const response = await fetch(url, { headers: { "user-agent": "SignalRound/1.0" } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

const articles = new Map<string, string>();
for (const search of SEARCHES) {
  const results = await getJson(
    `https://inc42.com/wp-json/wp/v2/search?search=${encodeURIComponent(search)}&per_page=100`,
  );
  for (const result of results) {
    if (/Indian Startups Raised|Startup Funding Of The Week/i.test(result.title)) {
      articles.set(result.url, clean(result.title.replace(/&#\d+;|&\w+;/g, " ")));
    }
  }
}

const candidates: unknown[] = [];
const seen = new Set<string>();
const entries = [...articles.entries()];
for (let offset = 0; offset < entries.length; offset += 8) {
  const batch = entries.slice(offset, offset + 8);
  await Promise.all(
    batch.map(async ([sourceUrl, sourceTitle]) => {
      const response = await fetch(sourceUrl, { headers: { "user-agent": "SignalRound/1.0" } });
      if (!response.ok) return;
      const html = await response.text();
      const published = html.match(/"datePublished":"([^"]+)/)?.[1]?.slice(0, 10);
      if (!published || published < CUTOFF) return;

      const $ = cheerio.load(html);
      $("table").each((_tableIndex, table) => {
        $(table)
          .find("tr")
          .slice(1)
          .each((_rowIndex, row) => {
            const cells = $(row)
              .find("td")
              .map((_index, cell) => clean($(cell).text()))
              .get();
            if (cells.length < 7) return;
            const [dateText, name, sector, subsector, businessModel, amountAsWritten, stageAsWritten, investors = ""] = cells;
            const announcedOn = isoDate(dateText);
            const stage = STAGES.get(stageAsWritten.toLowerCase().replace(/[–—-]/g, "-").trim());
            if (!announcedOn || announcedOn < CUTOFF || !stage || !name) return;
            const key = `${name.toLowerCase()}:${stage}:${announcedOn}`;
            if (seen.has(key)) return;
            seen.add(key);
            candidates.push({
              name,
              announcedOn,
              stage,
              stageAsWritten,
              amountAsWritten,
              sector,
              subsector: subsector === "–" ? "" : subsector,
              businessModel,
              investors: investors.split(",").map(clean).filter(Boolean),
              sourceUrl,
              sourceTitle,
            });
          });
      });
    }),
  );
}

candidates.sort((a: any, b: any) => b.announcedOn.localeCompare(a.announcedOn) || a.name.localeCompare(b.name));
writeFileSync(OUTPUT, `${JSON.stringify(candidates, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, candidates: candidates.length, cutoff: CUTOFF }, null, 2));
