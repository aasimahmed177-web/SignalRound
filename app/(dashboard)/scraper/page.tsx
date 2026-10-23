import { WebPlayground } from "@/components/scraper/web-playground";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";

export default function ScraperPage() {
  return (
    <>
      <PageHeader section={10} title="Web tools" description="Read a page, discover links, crawl a website, or search the web." />
      <PageBody>
        <WebPlayground />
      </PageBody>
    </>
  );
}
