import { companyRequestStatus } from "@/lib/company-requests";
import { db } from "@/lib/db";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (process.env.COMPANY_REQUESTS !== "1") return new Response("Not Found", { status: 404 });
  const status = await companyRequestStatus(await db(), (await params).id);
  if (!status) return new Response("Not Found", { status: 404 });
  return Response.json(status, { headers: { "cache-control": "no-store" } });
}
