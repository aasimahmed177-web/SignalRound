"use client";

import { Menu, Search } from "lucide-react";
import { useState } from "react";
import { FirecrawlLockup } from "@/components/brand/firecrawl-lockup";
import { openCommandPalette } from "@/components/search/command-palette";
import { Brand, SidebarFooter, SuspendedNavLinks, shellIconButton } from "@/components/shell/sidebar";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { navItemsFor } from "@/lib/nav";

/**
 * The phone and narrow-pane shell: a top bar with the brand, search, and the menu, and a drawer
 * holding the sidebar's nav. "Built on Firecrawl" lives in the drawer's foot so the bar carries
 * one brand, not two.
 */
export function MobileNav({ hrefs, signIn, home }: { hrefs?: string[]; signIn?: boolean; home?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between border-b border-border-faint bg-sidebar px-4 lg:hidden">
      <Brand href={home} />
      <div className="flex items-center gap-1">
        <button type="button" onClick={openCommandPalette} aria-label="Search" className={shellIconButton}>
          <Search className="size-4" strokeWidth={1.75} />
        </button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger aria-label="Open navigation" className={shellIconButton}>
            <Menu className="size-4" strokeWidth={1.75} />
          </SheetTrigger>
          <SheetContent side="left" className="w-72 gap-0 bg-sidebar p-0 text-foreground">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Sections of the funding feed.</SheetDescription>
            <div className="flex h-14 items-center border-b border-border-faint px-5">
              <Brand href={home} />
            </div>
            {/* Closing on click rather than on pathname change keeps the drawer out of the Suspense boundary. */}
            <SuspendedNavLinks items={navItemsFor(hrefs)} onNavigate={() => setOpen(false)} />
            <div className="flex items-center gap-2 border-t border-border-faint px-4 py-3">
              <span className="text-label-x-small text-black-alpha-40 dark:text-muted-foreground">Built on</span>
              <FirecrawlLockup caption={false} />
            </div>
            <SidebarFooter signIn={signIn} />
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
