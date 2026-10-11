"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface FilterOption {
  value: string;
  label: string;
  /** A narrower choice under the one above it (a sector under its group). */
  inset?: boolean;
}

interface FilterSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** The first option is the "any" state; its value is the empty string. */
  options: FilterOption[];
  label: string;
  className?: string;
}

const ANY = "__any__";

/**
 * A pill-shaped select that sits beside the filter chips: same height, same fill, same type. It is
 * quiet when nothing is chosen and reads as a set filter (foreground text) when something is.
 */
export function FilterSelect({ value, onChange, options, label, className }: FilterSelectProps) {
  const set = value !== "";
  return (
    <Select value={value === "" ? ANY : value} onValueChange={(v) => onChange(v === ANY ? "" : v)}>
      <SelectTrigger
        aria-label={label}
        className={cn(
          "tap relative h-8 rounded-full border-0 bg-black-alpha-4 px-3 text-label-small shadow-none hover:bg-black-alpha-8 focus-visible:ring-2 dark:bg-white/6 dark:hover:bg-white/10",
          set ? "text-foreground" : "text-black-alpha-56 dark:text-muted-foreground",
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start" sideOffset={6}>
        {options.map((o) => (
          <SelectItem key={o.value || ANY} value={o.value === "" ? ANY : o.value} className={o.inset ? "pl-5" : undefined}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
