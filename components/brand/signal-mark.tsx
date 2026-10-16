import { cn } from "@/lib/utils";

/** SignalRound's mark: a verified center point with two expanding discovery arcs. */
export function SignalMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className={cn("size-8 text-signal-blue", className)}>
      <path d="M9.2 22.8a9.6 9.6 0 0 1 0-13.6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity=".38" />
      <path d="M5.3 26.7a15.1 15.1 0 0 1 0-21.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity=".18" />
      <path d="M22.8 9.2a9.6 9.6 0 0 1 0 13.6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity=".72" />
      <path d="M26.7 5.3a15.1 15.1 0 0 1 0 21.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity=".36" />
      <circle cx="16" cy="16" r="5" fill="currentColor" />
      <path d="m13.7 16 1.45 1.45 3.2-3.35" stroke="white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
