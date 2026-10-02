import { revalidateTag } from "next/cache";
import { tokenEquals } from "@/lib/tokens";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || !tokenEquals(request.headers.get("authorization"), `Bearer ${secret}`)) return new Response(null, { status: 401 });
  const body = (await request.json().catch(() => null)) as { tags?: unknown } | null;
  if (
    !Array.isArray(body?.tags) ||
    body.tags.length > 5000 ||
    body.tags.some(
      (tag: unknown) => typeof tag !== "string" || !/^(?:company:[a-f0-9]{64}|investor:[a-f0-9]{64}|entity-details)$/.test(tag),
    )
  ) {
    return new Response(null, { status: 400 });
  }
  for (const tag of new Set(body.tags as string[])) revalidateTag(tag, { expire: 0 });
  return new Response(null, { status: 204 });
}
