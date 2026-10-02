/**
 * The one URL param every preset-aware surface reads, so a link from one carries to the next. It
 * lives outside components/preset-switcher.tsx because that file is "use client": a server page
 * importing a constant from it gets a client reference, not the string, and reads no preset at all.
 */
export const PRESET_PARAM = "preset";
