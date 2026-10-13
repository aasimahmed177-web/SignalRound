import { connection } from "next/server";
import { cachedCompanyView } from "@/lib/cached";
import { isHouseCompany } from "@/lib/house";
import { decodeParam } from "@/lib/links";
import { CardFrame, Figure, GenericCard, Heading, loadLogo, OG_SIZE, renderCard } from "@/lib/og";
import { raisedFigure, verifiedRaise } from "@/lib/seo";
import { amountLabel, capitalise, cardDate, clip, companyShare, nameList, roundLabel, verifiedAgainst } from "@/lib/share";
import { sourcesLabel } from "@/lib/source-count";

export const alt = "Fireround company card: the latest round, total raised, and the sources behind it";
export const size = OG_SIZE;
export const contentType = "image/png";

const GENERIC = (
  <GenericCard
    tag="COMPANY"
    headline="A company on the funding record."
    line="Every round on record, with the sources behind each and the investors on them."
  />
);

const HOUSE_LINE = "The company this feed is built on: every round here was found and read with its API.";

/**
 * The card a company link unfurls into: the logo (or a monogram), the name, what it does, the
 * latest round and who led it, the total raised, and how many sources the round was read back
 * against. Reachable wherever the page is: open in PUBLIC_DEMO, behind the proxy's password
 * otherwise, so a card never shows more than the page would.
 */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const page = await cachedCompanyView(decodeParam(id))
    .then((view) => view?.page ?? null)
    .catch(() => null);
  if (!page) return renderCard([() => GENERIC]);

  const { company, totals, sources } = page;
  const { latest } = companyShare(page);
  // The same verified total the page and its dated summary state (lib/seo.ts verifiedRaise).
  const raise = verifiedRaise(page.rounds);
  // The company this feed is built on draws the flame in the tile's place and says why it is here.
  const house = isHouseCompany(company);
  const logo = house ? null : await loadLogo({ domain: company.domain, logoUrl: company.logo_url });
  const mark = company.name.trim().charAt(0).toUpperCase() || "?";
  const line = house ? HOUSE_LINE : clip(capitalise(company.description) ?? company.domain ?? "", 130);
  const seen = latest && verifiedAgainst(latest) !== null ? sourcesLabel(latest) : null;

  const footer =
    seen !== null ? { text: seen, check: true } : { text: `${sources.length} ${sources.length === 1 ? "source" : "sources"} on record` };

  const card = (withLogo: boolean) => (
    <CardFrame tag="COMPANY" footer={footer}>
      <Heading logo={withLogo ? logo : null} mark={mark} name={company.name} line={line || null} flame={house} />
      <div style={{ display: "flex", gap: 40 }}>
        {latest ? (
          <Figure
            label="LATEST ROUND"
            value={[roundLabel(latest), amountLabel(latest)].filter(Boolean).join(" · ")}
            hint={cardDate(latest.announced_on, latest.date_precision) ?? "undated"}
            grow={1.3}
          />
        ) : (
          <Figure label="ROUNDS ON RECORD" value={String(totals.rounds)} hint="none published" />
        )}
        <Figure
          label="LED BY"
          value={latest?.lead_investors.length ? nameList(latest.lead_investors.slice(0, 1)) : "Not stated"}
          hint={latest && latest.lead_investors.length > 1 ? `+ ${nameList(latest.lead_investors.slice(1), 1)}` : null}
          grow={1.3}
        />
        <Figure
          label="RAISED ON RECORD"
          value={raise.cited.length === 0 ? "None verified" : raise.usdMillions > 0 ? raisedFigure(raise.usdMillions) : "Undisclosed"}
          hint={
            raise.cited.length === 0
              ? "still being checked"
              : raise.priced.length === 0
                ? "no amount stated"
                : `across ${raise.cited.length} verified ${raise.cited.length === 1 ? "round" : "rounds"}`
          }
        />
      </div>
    </CardFrame>
  );

  return renderCard([...(logo ? [() => card(true)] : []), () => card(false), () => GENERIC]);
}
