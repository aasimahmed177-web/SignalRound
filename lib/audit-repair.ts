import {
  amountInEvidence,
  brandNamesOtherEntity,
  classifyStage,
  cleanHeadlineName,
  evidenceSaysExtension,
  hostOf,
  isGenericCompanyName,
  issuerTypeFromEvidence,
  mixedFinancingScope,
  namesCompany,
  nonStartupIssuerReason,
  pageSentences,
  parseAmount,
  parseStatedDate,
  registrableDomain,
  type Stage,
  valuationSupport,
  visibleArticleDate,
} from "@fireround/core";

export interface AuditRow {
  id: string;
  company: string;
  description: string | null;
  website: string | null;
  stage: Stage;
  stageAsWritten: string;
  isExtension: boolean;
  amountAsWritten: string | null;
  valuationAsWritten: string | null;
  financingTotalAsWritten: string | null;
  amountScope: string | null;
  announcedOn: string | null;
  datePrecision: string;
  dateBasis: string | null;
  firstSeenAt: Date;
  pinned: { stage?: string; announced_on?: string; valuation?: string | null } | null;
  disposition: string;
  evidenceQuotes: string[];
  sources: Array<{ url: string; title: string | null; published: string | null }>;
  brand: string | null;
  profileVerified: boolean;
}

export interface AuditPage {
  url: string;
  markdown: string;
  published?: string | null;
}

export interface AuditChange {
  id: string;
  company: string;
  kind: "reject" | "name" | "domain" | "money" | "valuation" | "stage" | "extension" | "date";
  from: string | null;
  to: string | null;
  reason: string;
  quote: string;
  sourceUrl: string | null;
  scope?: string;
}

/** An audit plan only acts on a page's words or a stored verbatim quote. No row ID is special. */
export function planAuditRepair(row: AuditRow, page?: AuditPage, verifiedWebsite?: { url: string; quote: string } | null): AuditChange[] {
  const changes: AuditChange[] = [];
  const pageSentencesList = page ? pageSentences(page.markdown) : [];
  const quoted = (text: string, kind: AuditChange["kind"], from: string | null, to: string | null, reason: string, scope?: string) => {
    changes.push({
      id: row.id,
      company: row.company,
      kind,
      from,
      to,
      reason,
      quote: text,
      sourceUrl:
        verifiedWebsite?.quote === text
          ? verifiedWebsite.url
          : row.brand === text && row.website
            ? row.website
            : page && page.markdown.replace(/\s+/g, " ").includes(text.replace(/\s+/g, " "))
              ? page.url
              : null,
      ...(scope ? { scope } : {}),
    });
  };
  const evidence = [...row.evidenceQuotes, ...pageSentencesList];
  const issuerQuote = evidence.find(
    (q) =>
      q.toLowerCase().includes(row.company.split(" ")[0].toLowerCase()) &&
      nonStartupIssuerReason(issuerTypeFromEvidence(row.company, null, q)),
  );
  const issuerReason = issuerQuote && nonStartupIssuerReason(issuerTypeFromEvidence(row.company, null, issuerQuote));
  if (issuerReason && row.disposition !== "rejected") quoted(issuerQuote, "reject", row.disposition, "rejected", issuerReason);
  if (isGenericCompanyName(row.company) && row.disposition !== "rejected")
    quoted(row.evidenceQuotes[0] ?? row.company, "reject", row.disposition, "rejected", "the headline names no company");

  const name = cleanHeadlineName(row.company);
  if (name !== row.company && !isGenericCompanyName(name))
    quoted(evidence.find((q) => q.includes(name)) ?? row.company, "name", row.company, name, "remove headline descriptor");

  if (verifiedWebsite?.url && registrableDomain(row.website) !== registrableDomain(verifiedWebsite.url))
    quoted(verifiedWebsite.quote, "domain", row.website, verifiedWebsite.url, "company homepage and product verified from its own site");
  else if (
    row.website &&
    !verifiedWebsite &&
    row.brand &&
    !row.brand.toLowerCase().includes(row.company.toLowerCase()) &&
    brandNamesOtherEntity(row.brand, row.company)
  )
    quoted(row.brand, "domain", row.website, null, "homepage branding names another entity");

  const amount = row.amountAsWritten;
  const amountValue = parseAmount(amount).value;
  const financingParagraph = (line: string) => {
    if (!amount) return false;
    const sentences = pageSentences(line);
    const index = sentences.findIndex((sentence) => amountInEvidence(amount, sentence));
    return index >= 0 && !!mixedFinancingScope(sentences.slice(index, index + 4).join(" "));
  };
  const financingEvidence = [
    ...evidence,
    ...(page?.markdown
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 60 && line.length < 1500 && namesCompany(line, row.company) && financingParagraph(line)) ?? []),
  ];
  const cumulativeFigure = (quote: string, figure: string): boolean => {
    const n = /\d[\d,.]*/.exec(figure)?.[0]?.replace(/,/g, "");
    if (!n) return false;
    const normalized = quote.replace(/,/g, "");
    const match = new RegExp(`(?<!\\d)${n.replace(".", "\\.")}(?!\\d)`).exec(normalized);
    if (!match) return false;
    const before = normalized.slice(0, match.index).slice(-55);
    const after = normalized.slice(match.index + match[0].length).slice(0, 30);
    return (
      /\b(?:total funding|cumulative funding|total raised|raised to date|in total)\s*(?:in (?:the )?company\s*)?(?:of|to)?\s*(?:[$€£₹]|USD|EUR|INR)?\s*$/i.test(
        before,
      ) || /^\s*(?:m|million|billion|crore)?\s+(?:in total|total funding|raised to date)\b/i.test(after)
    );
  };
  const moneySentence =
    amount && amountValue !== null
      ? financingEvidence.find((q) => {
          if (!amountInEvidence(amount, q) || (!mixedFinancingScope(q) && !cumulativeFigure(q, amount))) return false;
          const dated = /\b(?:in|on|during|back in)\s+(?:[a-z]+\s+)?(20\d{2})\b/i.exec(q)?.[1];
          return !dated || dated === row.announcedOn?.slice(0, 4);
        })
      : null;
  const mixed = moneySentence;
  const scope = mixed ? (mixedFinancingScope(mixed) ?? (amount && cumulativeFigure(mixed, amount) ? "cumulative" : null)) : null;
  if (amount && mixed && scope && (row.amountScope !== scope || row.financingTotalAsWritten !== amount))
    quoted(mixed, "money", amount, amount, "reported financing total does not isolate new primary money", scope);

  const valuation = row.valuationAsWritten;
  const valuationQuote =
    valuation &&
    evidence.find(
      (q) =>
        amountInEvidence(valuation, q) &&
        cumulativeFigure(q, valuation) &&
        valuationSupport(valuation, q, {
          company: row.company,
          stage: row.stage,
          amount: amountValue,
          announced: row.announcedOn,
          named: true,
        }) !== null,
    );
  if (valuationQuote && row.pinned?.valuation === undefined) {
    quoted(valuationQuote, "valuation", valuation, null, "cumulative funding is not a valuation");
    if (!row.financingTotalAsWritten)
      quoted(valuationQuote, "money", null, valuation, "cumulative funding total, not new round money", "cumulative");
  }

  const filing = page && hostOf(page.url).endsWith("sec.gov") ? row.sources.find((s) => s.url === page.url) : null;
  const aboutRow = (q: string) => namesCompany(q, row.company, { share: 0.5 });
  const security = evidence.find(
    (q) =>
      /\b(?:simple agreement for future equity|SAFE)\b/.test(q) &&
      ((!!filing && /simple agreement for future equity/i.test(q)) ||
        (/\b(?:offering|securit(?:y|ies)|funding|financing|round|form d|sale)\b/i.test(q) && aboutRow(q))),
  );
  const preA = evidence.find((q) => q.split(/[;。]/).some((part) => /\bpre[- ]a(?:\+)?\b/i.test(part) && aboutRow(part)));
  const debt = evidence.find((q) => /\b(?:private credit|provides? debt financing)\b/i.test(q) && /\bcredit partners?\b/i.test(q));
  const nextStage = security
    ? "convertible"
    : preA
      ? "pre_a"
      : debt && /\bcredit partners?\b/i.test(`${row.stageAsWritten} ${evidence.join(" ")}`)
        ? "debt"
        : classifyStage(row.stageAsWritten).stage;
  if (!row.pinned?.stage && ["convertible", "pre_a", "debt", "series_a", "series_b"].includes(nextStage) && nextStage !== row.stage)
    quoted(security ?? preA ?? debt ?? row.stageAsWritten, "stage", row.stage, nextStage, "stage stated by the financing evidence");
  const extension = evidence.find((q) => {
    if (!evidenceSaysExtension(q)) return false;
    if (!/\b(?:round|financing|funding|capital|investment|raise|series [a-z]|seed)\b/i.test(q)) return false;
    if (!aboutRow(q) && !row.sources.some((s) => s.url === page?.url && namesCompany(s.title, row.company, { share: 0.5 }))) return false;
    const quotedStage = /\b(?:pre-?seed|seed|series\s+([a-z]))\b/i.exec(q);
    if (quotedStage && !q.toLowerCase().includes(row.stageAsWritten.toLowerCase()) && !aboutRow(q)) return false;
    return true;
  });
  if (extension && !row.isExtension) quoted(extension, "extension", "false", "true", "additional money extends an earlier round");

  if (
    filing?.published &&
    security &&
    !row.pinned?.announced_on &&
    row.announcedOn !== filing.published &&
    page?.markdown.includes(filing.published)
  )
    quoted(filing.published, "date", row.announcedOn, filing.published, "filing publication date, not first sale of the security");

  if (page && !filing && !row.pinned?.announced_on) {
    const date =
      visibleArticleDate(page.markdown) ??
      page.published ??
      page.markdown
        .split("\n")
        .slice(0, 10)
        .filter((line) => !/\b(?:last updated|updated on)\b/i.test(line))
        .map((line) => parseStatedDate(line)?.toISOString().slice(0, 10) ?? null)
        .find(Boolean) ??
      null;
    const companyHost = hostOf(page.url).replace(/^www\./, "");
    const ownPost =
      companyHost.startsWith(row.company.toLowerCase().replace(/[^a-z0-9]/g, "")) ||
      (row.website && hostOf(row.website).replace(/^www\./, "") === companyHost && row.profileVerified);
    const gap = date && row.announcedOn ? (Date.parse(date) - Date.parse(row.announcedOn)) / 86_400_000 : null;
    const fixesWeekMarker = row.datePrecision !== "day" && gap !== null && gap >= 0 && gap <= 6;
    const earlierCompanyDay = row.dateBasis !== "stated" && gap !== null && gap <= 0 && gap >= -21;
    const announcementQuote = pageSentencesList.find(
      (line) => aboutRow(line) && (!row.amountAsWritten || amountInEvidence(row.amountAsWritten, line)),
    );
    if (ownPost && date && announcementQuote && row.announcedOn !== date && (fixesWeekMarker || earlierCompanyDay))
      quoted(
        page.markdown.split("\n").find((line) => line.includes(date) || /^(?:published on:|september|october|august)/i.test(line.trim())) ??
          announcementQuote,
        "date",
        row.announcedOn,
        date,
        `company post published ${date} resolves its week-of marker`,
      );
  }
  return changes;
}
