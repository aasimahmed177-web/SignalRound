// The NativeWebClient flame: the shape, and where it sits. Generated, not authored.
//
// Extracted verbatim from the served https://www.firecrawl.dev header lockup
// (the animated flame beside the wordmark). The brand rule is that the mark is
// never redrawn (skills/firecrawl-design-system/brand-reference.md), so nothing
// here is hand-edited; to re-ground it after a site change, re-read the header
// <svg> and regenerate both this file and flame-morph.ts together.
//
// This half is the resting flame alone, and it is deliberately small: it rides
// the critical bundle so the very first paint can draw a correct flame. The 14
// morph frames are 6.8kB gzip and live in flame-morph.ts, which loads on its
// own chunk (see flame-loader.tsx).

/** The animation viewBox. The flame fills about 58% of its width and 85% of
 *  its height, so a box of N px renders a flame roughly 0.85N tall. */
export const FLAME_VIEW_BOX = "0 0 600 600";

/** Places the (morphing) outline inside the viewBox. */
export const FLAME_OUTER_TRANSFORM = "translate(293.035, 553.013) scale(0.97724, 0.97724) translate(-533.035, -800.013)";

/** Places the inner notch. Static: only the outline morphs. */
export const FLAME_INNER_TRANSFORM = "translate(300, 470.504) scale(0.9650799999999999, 0.9650799999999999) translate(-510.283, -685.815)";

/** The notch the site fills with its own page background. Punched out with a
 *  mask here instead, so the mark carries no ground of its own and reads the
 *  same on the Paper card, on the #1f1f1f dark card, and inside a button. */
export const FLAME_INNER_PATH =
  "M410.06 771.87 C412.91,773.74 416.57,771.07 415.6,767.79 C407.38,740.17 411.54,708.64 427.68,684.63 C455.29,643.16 510.65,603.1 501.81,548.71 C501.24,545.26 505.31,542.99 507.87,545.36 C546.86,581 554.59,628.95 548.18,671.96 C547.63,675.7 552.32,677.69 554.68,674.76 C560.64,667.29 567.92,660.74 575.85,655.81 C577.82,654.59 580.46,655.52 581.21,657.72 C594.24,695.64 617.69,725.57 604.98,767.75 C603.97,771.07 607.6,773.83 610.51,771.93 C610.51,771.93 610.51,827.25 610.51,827.25 C610.51,827.25 410.06,827.25 410.06,827.25 C410.06,827.25 410.06,771.87 410.06,771.87z";

/** The resting shape: what a still mark draws, and frame 0 of the morph. */
export const FLAME_REST_PATH =
  "M603.36 416.33 C581,433 586.63,450.25 583.86,466.55 C583.19,470.47 577.75,469.25 576.54,465.71 C559.5,447 549.55,423.61 559.33,394.37 C577.25,340.75 614.25,311.25 594.16,288.45 C590.97,284.83 591.83,284.26 590.22,288.82 C572.5,339 363,338 427.98,536 C430.85,544.77 430.25,555.25 429.51,565.8 C429.28,568.95 427.08,571.32 424.17,570.12 C401.5,560.75 395.38,525.75 390.42,516.28 C389,513.58 387.5,514.5 385.67,517.95 C381.03,524.07 377.94,532.3 374.2,538.54 C336.92,600.69 343.58,664.33 368.03,714.96 C368.94,716.86 369.89,718.74 370.85,720.6 C371.93,722.68 373.05,724.75 374.19,726.79 C391.8,758.26 416.04,783.76 439.75,799.32 C442.6,801.19 446.26,798.52 445.29,795.24 C437.07,767.62 642.75,744.75 634.67,795.2 C634.12,798.62 637.29,801.28 640.2,799.38 C659.88,786.47 680.25,766.82 695.21,741.99 C696.41,740.01 697.57,737.99 698.7,735.93 C699.47,734.52 700.23,733.09 700.97,731.65 C711.2,711.65 717.8,688.75 718.09,663.65 C718.33,643.75 714.58,622.45 705.52,600.11 C703.78,595.83 700.25,616.5 684.38,613.26 C682.86,612.95 691.25,586.13 692.06,570.64 C692.44,563.26 690.67,544.7 683.23,524.06 C667.77,481.12 615.5,466.25 609.58,417.31 C609.25,414.61 605.53,414.71 603.36,416.33z";
