import { FunnelReplayWorkbench } from "@/components/scraper/funnel-replay-workbench";
import { WebPlayground } from "@/components/scraper/web-playground";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";

export default function ScraperPage() {
  return (
    <>
      <PageHeader section={10} title="Web tools" description="Read a page, discover links, crawl a website, or search the web." />
      <PageBody>
        <div className="space-y-6">
          <FunnelReplayWorkbench />
          <WebPlayground />
        </div>
      </PageBody>
    </>
  );
}
