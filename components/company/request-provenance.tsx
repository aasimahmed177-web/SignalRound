export function RequestProvenance({ addedOnRequest }: { addedOnRequest: boolean }) {
  return addedOnRequest ? <p className="text-body-small text-muted-foreground">Added on request</p> : null;
}
