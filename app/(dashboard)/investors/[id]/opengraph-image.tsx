import { connection } from "next/server";
import { investorInitials } from "@/components/investor-logo";
import { cachedInvestor } from "@/lib/cached";
import { sectorLabel, stageLabel, usd } from "@/lib/format";
import { investorIdFromParam } from "@/lib/links";
import { CardFrame, Figure, GenericCard, Heading, loadLogo, OG_SIZE, renderCard } from "@/lib/og";
import { amountLabel, cardDate, roundLabel } from "@/lib/share";

export const alt = "Fireround investor card: rounds led and joined, the latest round, and where it invests";
export const size = OG_SIZE;
export const contentType = "image/png";

const GENERIC = (
  <GenericCard
    tag="INVESTOR"
    headline="An investor on the funding record."
    line="The rounds it led and joined, who it invests beside, and where it shows up."
  />
);

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The card an investor link unfurls into: the firm's logo (the favicon by its resolved domain, else
 * the branding logo read off its homepage, as the company card picks; or the two-initial monogram the dashboard draws), the name, where it invests, the seats it took, and
 * its latest round. Reachable wherever the page is, like the company card.
 */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const page = await cachedInvestor(investorIdFromParam(id)).catch(() => null);
  if (!page) return renderCard([() => GENERIC]);

  const { investor, rounds, totals, reach, stages, sectors } = page;
  const latest = rounds[0] ?? null;
  const logo = await loadLogo({ domain: investor.domain, logoUrl: investor.logo_url });
  // "Other" is the classifier shrugging; it says nothing about where the firm invests.
  const named = sectors.filter((s) => s.sector !== "other");
  const focus = [
    stages.length
      ? `Mostly ${stages
          .slice(0, 2)
          .map((s) => stageLabel(s.stage))
          .join(" and ")}`
      : null,
    named.length
      ? named
          .slice(0, 3)
          .map((s) => sectorLabel(s.sector))
          .join(", ")
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const line = focus || investor.domain || null;
  const footer = {
    text: `${count(rounds.length, "round")} on record${reach.co_investors ? `, beside ${count(reach.co_investors, "co-investor")}` : ""}`,
  };

  const card = (withLogo: boolean) => (
    <CardFrame tag="INVESTOR" footer={footer}>
      <Heading logo={withLogo ? logo : null} mark={investorInitials(investor.name)} name={investor.name} line={line} />
      <div style={{ display: "flex", gap: 40 }}>
        <Figure
          label="ROUNDS LED"
          value={String(totals.led)}
          hint={
            totals.led === 0
              ? "no lead seat"
              : totals.lead_share_usd_millions > 0
                ? `${usd(totals.lead_share_usd_millions)} lead share`
                : "no amount stated"
          }
          grow={0.8}
        />
        <Figure
          label="PARTICIPATED"
          value={String(totals.participated)}
          hint={reach.usd_millions > 0 ? `${usd(reach.usd_millions)} combined round size` : null}
          grow={0.8}
        />
        {latest ? (
          <Figure
            label={latest.role === "lead" ? "LATEST ROUND · LED" : "LATEST ROUND"}
            value={latest.company.name}
            hint={[roundLabel(latest), amountLabel(latest), cardDate(latest.announced_on, latest.date_precision)]
              .filter(Boolean)
              .join(" · ")}
            grow={1.6}
          />
        ) : (
          <Figure label="LATEST ROUND" value="None on record" grow={1.6} />
        )}
      </div>
    </CardFrame>
  );

  return renderCard([...(logo ? [() => card(true)] : []), () => card(false), () => GENERIC]);
}
