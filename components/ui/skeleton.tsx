import { cn } from "@/lib/utils";

/**
 * One placeholder bone. The ink step reads on Paper and on a card in both themes (bg-muted
 * vanished on the card in light), and the pulse stops for a reader who asked for less motion.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-black-alpha-8 motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Skeleton };
