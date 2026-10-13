import { trackClick } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/** Slack's four-colour mark, as it appears on Slack's own "Add to Slack" button. */
export function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 122.8 122.8" className={className} aria-hidden>
      <path
        d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
        fill="#e01e5a"
      />
      <path
        d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
        fill="#36c5f0"
      />
      <path
        d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
        fill="#2eb67d"
      />
      <path
        d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
        fill="#ecb22e"
      />
    </svg>
  );
}

/**
 * Slack's own "Add to Slack" button, drawn to Slack's spec (white with a hairline in light,
 * aubergine in dark), since the official image is served from Slack's CDN. A plain anchor, not a
 * Link: the route answers with a redirect to slack.com, so it must be a full navigation and never
 * prefetched.
 */
export function AddToSlackLink({ href, preset, className }: { href: string; preset?: string; className?: string }) {
  return (
    <a
      href={href}
      data-add-to-slack
      {...(preset ? trackClick("fireround_subscribe_clicked", { channel: "slack", preset }) : {})}
      className={cn(
        "inline-flex h-10 shrink-0 items-center justify-center gap-2.5 rounded-8 border border-[#dddddd] bg-white px-4 text-[15px] font-semibold whitespace-nowrap text-[#1d1c1d] shadow-xs transition-colors hover:bg-[#f8f8f8] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:border-transparent dark:bg-[#4a154b] dark:text-white dark:hover:bg-[#611f64]",
        className,
      )}
    >
      <SlackMark className="size-[18px]" />
      Add to Slack
    </a>
  );
}
