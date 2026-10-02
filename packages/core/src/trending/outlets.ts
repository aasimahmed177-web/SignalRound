// The X announcements lane's outlet list: accounts that post other people's rounds (news desks,
// deal newsletters, wires, aggregators), so their posts are never a company's or an investor's own
// announcement. Maintained by hand: when a lead turns out to be an outlet's post, add its handle here.
//
// The lane used to read a handle as an outlet when it merely contained a word like "tech",
// "venture", "capital", "startup", or "funding", which rejected venture firms (@khoslaventures,
// @IndexVentures) and companies (@acmetech) whose posts are exactly what the lane looks for. The
// Trending lane keeps its own broader rule (`isOutletAccount` in signals.ts), where a firm's post
// about someone else's round is buzz rather than conversation.

/** Known outlet handles, lowercased. */
export const OUTLET_HANDLES: ReadonlySet<string> = new Set([
  // Global tech and business desks
  "techcrunch",
  "techmeme",
  "crunchbasenews",
  "crunchbase",
  "siliconangle",
  "geekwire",
  "venturebeat",
  "axios",
  "axiosprorata",
  "wsj",
  "wsjtech",
  "reuters",
  "reuterstech",
  "business",
  "technology",
  "bloomberg",
  "forbes",
  "cnbc",
  "businessinsider",
  "fortune",
  "fortunemagazine",
  "theinformation",
  "thenextweb",
  "hackernoon",
  "tldrnewsletter",
  "betterhn",
  "pitchbook",
  "cbinsights",
  "dealroomco",
  "techstartups",
  "alleywatch",
  "citybizlist",
  "menlotimes",
  "thesaasnews",
  "pulse2news",
  "finsmes",
  "techfundingnews",
  "tfnbreakingnews",
  "analyticsinme",
  "tbuzzdaily",
  // Europe
  "siftedeu",
  "sifted",
  "eu_startups",
  "tech_eu",
  "maddyness",
  "thecaptable",
  "uktechnews",
  "startupticker",
  // India
  "entrackr",
  "inc42",
  "yourstory",
  "yourstoryco",
  "moneycontrolcom",
  "vccircle",
  "etstartup",
  "sinewsupdates",
  "indianvca",
  "ceovine",
  "theceo_magazine",
  "scoopearth1",
  // Middle East and Africa
  "wamdame",
  "wamda",
  "magnitt",
  "forbes_mena_",
  "entmagazineme",
  "techcabal",
  "techpointafrica",
  "thecondia",
  "weetracker",
  "disruptafrica",
  "techloy",
  // Asia, Pacific, the Americas
  "latamlist",
  "e27co",
  "dealstreetasia",
  "krasia",
  "techinasia",
  "calcalistech",
  "startupdaily",
  "smartcompany",
  "betakit",
  // Wires and crypto desks
  "newsfrombw",
  "businesswire",
  "globenewswire",
  "prnewswire",
  "einpresswire",
  "accessnewswire",
  "coinpapercom",
  "theblock__",
  "coindesk",
  "cointelegraph",
]);

/**
 * Words that make a handle a publisher's wherever they sit: none of them names a venture firm or a
 * company raising a round ("tech", "venture", "capital", "startup", "funding", "finance" are not here).
 */
const OUTLET_HANDLE_WORDS = /news|newswire|newsletter|press|journal|insider|digest|headlines|magazine|breaking/i;

/** Display names that read as a publisher. A person's or a firm's name never carries these words. */
const OUTLET_NAME_WORDS =
  /\b(news|daily|times|wire|report|insider|journal|magazine|media|digest|breaking|headlines|reuters|bloomberg|newsletter)\b/i;

/** Whether an X account is an outlet for the announcements lane: a listed handle, an outlet word in the handle, or a publisher's display name. */
export function isAnnouncementOutlet(handle: string | null, name: string | null): boolean {
  if (handle && (OUTLET_HANDLES.has(handle.toLowerCase()) || OUTLET_HANDLE_WORDS.test(handle))) return true;
  return !!name && OUTLET_NAME_WORDS.test(name);
}
