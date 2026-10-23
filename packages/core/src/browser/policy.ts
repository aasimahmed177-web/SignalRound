import { isIP } from "node:net";
import { z } from "zod";
import { isPublicAddress } from "../web/transport.ts";

/** Static screening only. The transport must still resolve and pin public DNS on every hop. */
function publicUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
    if (isIP(host)) return isPublicAddress(host) ? url : null;
    if (!host.includes(".") || /(?:\.$|\.(?:localhost|local|internal|lan|home\.arpa)$)/i.test(host)) return null;
    return url;
  } catch {
    return null;
  }
}

const originSchema = z
  .string()
  .max(2048)
  .refine((raw) => publicUrl(raw)?.origin === raw, "Expected exact public origin");
const pathSchema = z
  .string()
  .max(2048)
  .refine((path) => {
    if (!path.startsWith("/") || /[%?#\\]/.test(path)) return false;
    return new URL(path, "https://example.com").pathname === path && !path.startsWith("//");
  }, "Expected canonical exact path without query or escapes");
const endpointSchema = z.object({ origin: originSchema, path: pathSchema }).strict();
const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
const payloadSchema = z.record(z.string().min(1).max(100), scalar);

export const auditModeSchema = z.enum(["passive-map", "interactive-dry-run", "authorized-synthetic-experiment"]);
export const authorizationManifestSchema = z
  .object({
    version: z.literal(1),
    mode: auditModeSchema,
    allowedOrigins: z.array(originSchema).min(1).max(50),
    allowedWrites: z
      .array(
        endpointSchema
          .extend({
            method: z.literal("POST"),
            purpose: z.enum(["synthetic-registration", "synthetic-questionnaire"]),
            /** Exact approved synthetic values, not just arbitrary field names. Do not export this manifest. */
            payload: payloadSchema.refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 100),
          })
          .strict(),
      )
      .max(20),
    forbiddenOrigins: z.array(originSchema).max(100),
    forbiddenEndpoints: z.array(endpointSchema).max(100),
    forbiddenActions: z.array(z.string().min(1).max(100)).max(100),
    syntheticIdentityProfile: z.string().min(1).max(100).optional(),
    maxSubmissions: z.number().int().min(0).max(100),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const invalid = manifest.allowedWrites.some((write) => !manifest.allowedOrigins.includes(write.origin));
    if (invalid) ctx.addIssue({ code: "custom", message: "Write origins must be explicitly allowed" });
    if (manifest.mode !== "authorized-synthetic-experiment" && (manifest.allowedWrites.length || manifest.maxSubmissions)) {
      ctx.addIssue({ code: "custom", message: "Observation modes cannot authorize writes" });
    }
    if (manifest.mode === "authorized-synthetic-experiment" && !manifest.syntheticIdentityProfile) {
      ctx.addIssue({ code: "custom", message: "Synthetic identity profile required" });
    }
  });
export type AuthorizationManifest = z.infer<typeof authorizationManifestSchema>;

const requestSchema = z
  .object({
    url: z.string().max(8192),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
    action: z.string().min(1).max(100),
    hasCredentials: z.boolean(),
    payload: payloadSchema.optional(),
  })
  .strict();
export type PolicyRequest = z.infer<typeof requestSchema>;
export type PolicyDecision = { allowed: boolean; reason: string };

const prohibitedActions = new Set([
  "purchase",
  "payment",
  "checkout",
  "message",
  "join_group",
  "book_appointment",
  "call",
  "download",
  "account_creation",
]);
const dangerousUrl =
  /(?:^|[^a-z])(?:checkout|payment|purchase|buy|send|message|join|booking|book|subscribe|unsubscribe|delete|logout|register|submit)(?:[^a-z]|$)/i;
const prohibitedHost = /(?:^|\.)(?:wa\.me|whatsapp\.com|t\.me|stripe\.com|paypal\.com|calendly\.com)$/i;

/**
 * Pure preflight decision, NOT a network sandbox or proof of human authorization.
 * Only a trusted runner may supply the approved manifest and clock/count. It must atomically
 * reserve submission budget before transmission, inspect actual payload/credentials, and check
 * every redirect/subrequest. GET heuristics cannot prove an endpoint is side-effect-free.
 * Nothing in this module executes requests or enables live browser writes.
 */
export function evaluateRequestPolicy(
  manifestInput: unknown,
  requestInput: unknown,
  state: { now: number; submissionsUsed: number },
): PolicyDecision {
  const deny = (reason: string): PolicyDecision => ({ allowed: false, reason });
  const manifestResult = authorizationManifestSchema.safeParse(manifestInput);
  if (!manifestResult.success) return deny("invalid-manifest");
  const requestResult = requestSchema.safeParse(requestInput);
  if (!requestResult.success) return deny("invalid-request");
  const manifest = manifestResult.data;
  const request = requestResult.data;
  if (!Number.isFinite(state.now) || !Number.isSafeInteger(state.submissionsUsed) || state.submissionsUsed < 0)
    return deny("invalid-state");
  if (state.now >= Date.parse(manifest.expiresAt)) return deny("manifest-expired");
  const url = publicUrl(request.url);
  if (!url) return deny("unsafe-url");
  if (request.hasCredentials) return deny("credentials-forbidden");
  if (prohibitedActions.has(request.action) || manifest.forbiddenActions.includes(request.action)) return deny("forbidden-action");
  if (prohibitedHost.test(url.hostname) || manifest.forbiddenOrigins.includes(url.origin)) return deny("forbidden-origin");
  // Reject ambiguous encodings rather than guessing how the remote server normalizes a path.
  if (/%|\\/.test(url.pathname)) return deny("ambiguous-path");
  if (manifest.forbiddenEndpoints.some((entry) => entry.origin === url.origin && entry.path === url.pathname))
    return deny("forbidden-endpoint");
  if (!manifest.allowedOrigins.includes(url.origin)) return deny("origin-not-allowed");
  if (dangerousUrl.test(url.pathname) && !["synthetic-registration", "synthetic-questionnaire"].includes(request.action))
    return deny("dangerous-url");
  if (request.method === "GET" || request.method === "HEAD") {
    const decodedQuery = [...url.searchParams].flat().join(" ");
    if (decodedQuery.includes("%")) return deny("ambiguous-query");
    if (dangerousUrl.test(`${url.pathname} ${decodedQuery}`)) return deny("dangerous-url");
    if (request.payload || !["read", "navigate"].includes(request.action)) return deny("read-action-required");
    return { allowed: true, reason: "public-read-preflight" };
  }
  if (manifest.mode !== "authorized-synthetic-experiment") return deny("writes-disabled");
  if (state.submissionsUsed >= manifest.maxSubmissions) return deny("submission-budget-exhausted");
  if (url.search || url.hash) return deny("write-url-must-be-exact");
  const write = manifest.allowedWrites.find(
    (entry) =>
      entry.origin === url.origin && entry.path === url.pathname && entry.method === request.method && entry.purpose === request.action,
  );
  if (!write) return deny("write-not-authorized");
  // Payment etc. cannot be disguised as an approved registration endpoint.
  if (/(?:checkout|payment|purchase|buy|send|message|join|book|subscribe|delete|logout|account)/i.test(url.pathname))
    return deny("dangerous-url");
  if (
    !request.payload ||
    Object.keys(request.payload).length !== Object.keys(write.payload).length ||
    Object.entries(write.payload).some(([key, value]) => request.payload?.[key] !== value)
  )
    return deny("payload-not-authorized");
  return { allowed: true, reason: "synthetic-write-preflight-only" };
}
