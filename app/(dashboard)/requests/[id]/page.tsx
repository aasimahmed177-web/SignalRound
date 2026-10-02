import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { notFound, permanentRedirect } from "next/navigation";
import { connection } from "next/server";
import { requestCompanyPath } from "@/lib/company-request-status";
import { db } from "@/lib/db";

export const metadata = { title: "Company request", robots: { index: false, follow: false } };
export const instant = false;

/** Old request links: the proxy answers them first; this covers a request that reaches the page. */
export default async function RequestPage({ params }: PageProps<"/requests/[id]">) {
  if (process.env.COMPANY_REQUESTS !== "1") notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  await connection();
  const [row] = await (await db())
    .select({ domain: schema.companyRequests.domain, status: schema.companyRequests.status, companyId: schema.companyRequests.companyId })
    .from(schema.companyRequests)
    .where(eq(schema.companyRequests.id, id))
    .limit(1);
  if (!row) notFound();
  permanentRedirect(requestCompanyPath(row));
}
