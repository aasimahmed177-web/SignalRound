// The browser-safe slice of the core: constants and pure helpers with no Zod, no date parser, and
// no public-suffix list behind them. Client components import from "@fireround/core/client"; the
// root barrel re-exports every record module, and one client import of it ships Zod to every page.

export { normalizeCompanyKey, normalizeInvestorKey } from "./records/keys.ts";
export { SECTORS, sectorLabel } from "./records/sectors.ts";
export { STAGES, type Stage } from "./records/stages.ts";
