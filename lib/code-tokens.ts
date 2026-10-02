// Snippet highlighting for the landing page, as data: a line in, coloured tokens out. Pure and
// dependency-free, so the server renders the colours and no highlighter ships to the browser.

export type TokenKind = "plain" | "key" | "string" | "number" | "literal" | "punct" | "command" | "flag" | "comment";
export interface Token {
  text: string;
  kind: TokenKind;
}

/**
 * JSON into colourable tokens: a string followed by a colon is a key, the rest are values or
 * punctuation. Whitespace stays as plain tokens, so joining every token's text gives back the source.
 */
export function tokenizeJson(src: string): Token[] {
  const out: Token[] = [];
  const re =
    /("(?:[^"\\]|\\.)*")(?=\s*:)|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\s+)|(.)/g;
  for (const m of src.matchAll(re)) {
    const kind: TokenKind = m[1] ? "key" : m[2] ? "string" : m[3] ? "number" : m[4] ? "literal" : m[5] ? "punct" : "plain";
    out.push({ text: m[0], kind });
  }
  return out;
}

/**
 * Shell lines into tokens: the first word of each command (at a line start or after `&&`) is the
 * command, a word opening with `-` a flag, a quoted string or a URL a string, and `#` to the end
 * of the line a comment. Lossless like tokenizeJson.
 */
export function tokenizeShell(src: string): Token[] {
  const out: Token[] = [];
  const re = /(#.*$)|("(?:[^"\\]|\\.)*"|'[^']*')|(&&|\|\|?|;)|(\n)|([ \t]+)|([^\s"';|&]+|&)/gm;
  let expectCommand = true;
  for (const m of src.matchAll(re)) {
    const [text, comment, quoted, operator, newline, space] = m;
    if (comment) out.push({ text, kind: "comment" });
    else if (quoted) {
      out.push({ text, kind: "string" });
      expectCommand = false;
    } else if (operator) {
      out.push({ text, kind: "punct" });
      expectCommand = true;
    } else if (newline) {
      out.push({ text, kind: "plain" });
      expectCommand = true;
    } else if (space) out.push({ text, kind: "plain" });
    else {
      const kind: TokenKind = expectCommand ? "command" : text.startsWith("-") ? "flag" : /^https?:\/\//.test(text) ? "string" : "plain";
      out.push({ text, kind });
      expectCommand = false;
    }
  }
  return out;
}

/**
 * JSON the way a person lays it out: an object or array that fits in `width` columns at its
 * indent stays on one line (`{ "status": "confirmed", "sources_seen": 3 }`), anything longer
 * breaks one member a line; an object of one scalar member (`{ "url": "..." }`) stays whole however
 * long, since breaking it adds two lines and no clarity. Parses back to the value it was given.
 */
export function compactJson(value: unknown, width = 72, indent = 0, lead = 0): string {
  const flat = inline(value);
  if (flat === undefined) return "null";
  // `lead` is what sits before the value on its first line (its key), so it counts only for the one-line form.
  if (indent + lead + flat.length <= width || value === null || typeof value !== "object" || singleScalar(value)) return flat;
  const pad = " ".repeat(indent + 2);
  const close = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => pad + compactJson(v, width, indent + 2)).join(",\n")}\n${close}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  return `{\n${entries
    .map(([k, v]) => {
      const key = `${JSON.stringify(k)}: `;
      return pad + key + compactJson(v, width, indent + 2, key.length);
    })
    .join(",\n")}\n${close}}`;
}

/** One-line JSON with a space after each colon and comma, inside braces, as a person would type it. */
function inline(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => inline(v) ?? "null").join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(", ")} }`;
}

/** An object with exactly one member whose value is not itself an object or array. */
function singleScalar(value: object): boolean {
  if (Array.isArray(value)) return false;
  const entries = Object.values(value).filter((v) => v !== undefined);
  return entries.length === 1 && (entries[0] === null || typeof entries[0] !== "object");
}
