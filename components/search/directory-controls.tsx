"use client";

import { X } from "lucide-react";
import { parseAsString, useQueryStates } from "nuqs";
import type { ReactNode } from "react";
import { SearchBox, useUrlSearch } from "@/components/search/search-box";
import { Button } from "@/components/ui/button";
import { type FilterOption, FilterSelect } from "@/components/ui/filter-select";

const params = {
  q: parseAsString.withDefault(""),
  sort: parseAsString.withDefault(""),
  page: parseAsString.withDefault(""),
};

interface DirectoryControlsProps {
  placeholder: string;
  /** What the search box is called to a screen reader: "Search companies". */
  label: string;
  /** The first option is the default sort; its value is the empty string so a clean URL means it. */
  sorts: FilterOption[];
  trailing?: ReactNode;
}

/**
 * The directories' one row of controls: a search box and a sort menu, both in the URL so a result
 * is linkable and the server page reads them. Either change starts the list over at page one.
 * The box is the feed's, so a Link to the bare directory clears it rather than being undone by it.
 */
export function DirectoryControls({ placeholder, label, sorts, trailing }: DirectoryControlsProps) {
  const [f, setF] = useQueryStates(params, { shallow: false });
  const search = useUrlSearch(f.q, (q) => setF({ q: q || null, page: null }));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchBox
        value={search.draft}
        onChange={search.setDraft}
        onClear={() => {
          search.reset();
          setF({ q: null, page: null });
        }}
        placeholder={placeholder}
        label={label}
        className="min-w-0 flex-1 sm:w-72 sm:flex-none"
      />
      <FilterSelect label="Sort" value={f.sort} onChange={(v) => setF({ sort: v || null, page: null })} options={sorts} />
      {(f.q || f.sort) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            search.reset();
            setF({ q: null, sort: null, page: null });
          }}
        >
          <X className="size-3.5" /> Clear
        </Button>
      )}
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}
