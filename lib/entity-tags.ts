import { createHash } from "node:crypto";

export const companyTag = (id: string) => `company:${createHash("sha256").update(id).digest("hex")}`;
export const investorTag = (id: string) => `investor:${createHash("sha256").update(id).digest("hex")}`;
export const TAG_ENTITY_DETAILS = "entity-details";
