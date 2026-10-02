"use client";

import Link from "next/link";
import { type ComponentProps, useState } from "react";

export function IntentLink({ href, onMouseEnter, onFocus, ...props }: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const [prefetch, setPrefetch] = useState(false);
  return (
    <Link
      {...props}
      href={href}
      prefetch={prefetch}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        setPrefetch(true);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        setPrefetch(true);
      }}
    />
  );
}
