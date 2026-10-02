import { ShowMore } from "@/components/company/show-more";
import { type Plan, pricingView } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/** A name or price this short never breaks inside itself ("On-demand", "$1.63 to $8.85/hr"). */
const KEEP_TOGETHER = 28;

/**
 * A company's plans, one per row: the name on the left, the price on the right, a family's variants
 * under its name. Past `limit` rows the rest fold behind a toggle rather than a count, so a long
 * catalog stays readable without losing a plan. A lineup with no price at all reads as a count, its
 * plans in the tooltip. Every row carries the plan and price exactly as the page wrote them.
 */
export function PricingPlans({ plans, limit = 4, className }: { plans: Plan[]; limit?: number; className?: string }) {
  const view = pricingView(plans);
  if (view.rows.length === 0) return null;

  if (view.onRequest) {
    const n = view.rows.length;
    return (
      <div className={cn("text-muted-foreground", className)} title={view.rows.map((r) => r.title).join("\n")}>
        {n} {n === 1 ? "plan" : "plans"}, priced on request
      </div>
    );
  }

  // One line per plan: the name, then its price. A narrow panel (the feed drawer, the profile card) has
  // no room for columns, and nothing truncates: a short name or price keeps together and moves to the
  // next line whole, a long one wraps, and a wrapped line hangs indented under its start. The price's
  // tooltip is the plan and price as the page wrote them.
  const items = view.rows.map((r, i) => {
    // A family's name heads its first variant; the fold keeps a prefix, so that is its first shown one too.
    const header = r.group !== null && (i === 0 || view.rows[i - 1].group !== r.group);
    // A plan called "Free" priced "Free" says it once, not "Free Free".
    const price = r.price !== null && r.price.trim().toLowerCase() === r.name.trim().toLowerCase() ? null : r.price;
    return (
      <li key={`${r.group ?? ""}-${r.name}`}>
        {header && <div className="text-black-alpha-72 dark:text-muted-foreground">{r.group}</div>}
        <div className={cn("-indent-3", r.group !== null ? "pl-6" : "pl-3")}>
          <span
            className={cn("mr-1 text-black-alpha-72 dark:text-muted-foreground", r.name.length <= KEEP_TOGETHER && "whitespace-nowrap")}
          >
            {r.name}
          </span>
          {/* JSX drops the newline between the spans; this space is where a line may break. */}{" "}
          {price !== null && (
            <span
              title={r.title}
              className={cn(
                "tabular-nums",
                r.kind === "text" ? "text-muted-foreground" : "text-foreground",
                price.length <= KEEP_TOGETHER && "whitespace-nowrap",
              )}
            >
              {price}
            </span>
          )}
        </div>
      </li>
    );
  });

  return (
    <div className={className}>
      <ShowMore items={items} initial={limit} more={`Show all ${items.length} plans`} less="Show fewer plans" className="space-y-1" />
    </div>
  );
}
