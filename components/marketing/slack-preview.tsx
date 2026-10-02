import type { ReactNode } from "react";
import { FlameMark } from "@/components/brand/flame-mark";
import type { SlackBlock, SlackButton, SlackMessage, SlackText } from "@/lib/delivery";
import { cn } from "@/lib/utils";

// A Slack message drawn from the payload delivery.ts posts, block by block, so the landing page
// can only show what a channel receives. Slack's own light and dark palettes, not the house tokens:
// this is Slack's surface, framed on ours. Server-rendered, no network, no dependencies.

const ink = "text-[#1d1c1d] dark:text-[#d1d2d3]";
const secondary = "text-[#616061] dark:text-[#ababad]";
/** Slack's link blue, underlined so a link reads as one without leaning on colour alone (WCAG link-in-text-block). */
const linkInk =
  "text-[#1264a3] underline decoration-[#1264a3]/40 underline-offset-2 hover:decoration-current dark:text-[#1d9bd1] dark:decoration-[#1d9bd1]/40";

function decode(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Bold spans and line breaks inside a run of mrkdwn that holds no links. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*([^*\n]+)\*|\n/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    out.push(decode(text.slice(last, at)));
    out.push(
      m[1] === undefined ? (
        <br key={`${key}-${at}`} />
      ) : (
        <strong key={`${key}-${at}`} className="font-bold">
          {decode(m[1])}
        </strong>
      ),
    );
    last = at + m[0].length;
  }
  out.push(decode(text.slice(last)));
  return out;
}

/**
 * The slice of Slack mrkdwn the builder writes: `<url|label>` links, `*bold*`, newlines, and the
 * three escaped entities. Anything else prints as written, which is what Slack would do with it too.
 */
function Mrkdwn({ text, inert }: { text: SlackText; inert?: boolean }) {
  if (text.type === "plain_text") return <>{text.text}</>;
  const out: ReactNode[] = [];
  // A link may sit inside bold (`*<url|label>*`), as the compact round lines write it.
  const re = /(\*?)<([^|>]+)(?:\|([^>]+))?>(\*?)/g;
  let last = 0;
  for (const m of text.text.matchAll(re)) {
    const at = m.index ?? 0;
    const bold = m[1] === "*" && m[4] === "*";
    out.push(...inline(text.text.slice(last, at) + (bold ? "" : m[1]), `t${at}`));
    const label = decode(m[3] ?? m[2]);
    const node = inert ? (
      <span key={`a${at}`} className={cn(linkInk, bold && "font-bold")}>
        {label}
      </span>
    ) : (
      <a key={`a${at}`} href={m[2]} target="_blank" rel="noreferrer" className={cn(linkInk, bold && "font-bold")}>
        {label}
      </a>
    );
    out.push(node);
    if (!bold && m[4]) out.push(m[4]);
    last = at + m[0].length;
  }
  out.push(...inline(text.text.slice(last), "end"));
  return <>{out}</>;
}

function Button({ b, inert }: { b: SlackButton; inert?: boolean }) {
  const Tag = inert ? "span" : "a";
  return (
    <Tag
      {...(inert ? {} : { href: b.url, target: "_blank", rel: "noreferrer" })}
      className={cn(
        "inline-flex h-7 items-center rounded-4 px-3 text-[13px] font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#1264a3]/50",
        b.style === "primary"
          ? "bg-[#007a5a] text-white hover:bg-[#148567]"
          : "border border-[#1d1c1d]/30 bg-white text-[#1d1c1d] hover:bg-[#f8f8f8] dark:border-[#d1d2d3]/30 dark:bg-transparent dark:text-[#d1d2d3] dark:hover:bg-white/5",
      )}
    >
      {b.text.text}
    </Tag>
  );
}

function Block({ block, inert }: { block: SlackBlock; inert?: boolean }) {
  switch (block.type) {
    case "divider":
      return <hr className="border-[#1d1c1d]/13 dark:border-white/10" />;
    case "header":
      return <p className={cn("text-[18px] leading-6 font-bold", ink)}>{block.text.text}</p>;
    case "section":
      return (
        <div className={cn("flex items-start gap-3 text-[15px] leading-[22px]", ink)}>
          <div className="min-w-0 flex-1">
            {block.text && (
              <p>
                <Mrkdwn text={block.text} inert={inert} />
              </p>
            )}
            {block.fields && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                {block.fields.map((f) => (
                  <p key={f.text} className="min-w-0 break-words">
                    <Mrkdwn text={f} inert={inert} />
                  </p>
                ))}
              </div>
            )}
          </div>
          {/* Slack draws a section's image accessory as a small rounded square at the right. */}
          {block.accessory && (
            // biome-ignore lint/performance/noImgElement: a remote logo inside a message mock, drawn as Slack draws it
            <img
              src={block.accessory.image_url}
              alt={block.accessory.alt_text}
              width={44}
              height={44}
              loading="lazy"
              className="size-11 shrink-0 rounded-md bg-white object-contain"
            />
          )}
        </div>
      );
    case "context":
      return (
        <div className={cn("flex flex-wrap items-start gap-x-2 text-[12px] leading-[18px]", secondary)}>
          {block.elements.map((e) =>
            e.type === "image" ? (
              // Slack draws a context image inline at about the text's height, with its corners softened.
              // biome-ignore lint/performance/noImgElement: a remote logo inside a message mock, drawn as Slack draws it
              <img
                key={e.image_url}
                src={e.image_url}
                alt={e.alt_text}
                width={18}
                height={18}
                loading="lazy"
                className="mt-px size-[18px] shrink-0 rounded-[4px] bg-white object-contain"
              />
            ) : (
              <p key={e.text} className="min-w-0">
                <Mrkdwn text={e} inert={inert} />
              </p>
            ),
          )}
        </div>
      );
    case "actions":
      return (
        <div className="flex flex-wrap gap-2 pt-1">
          {block.elements.map((b) => (
            <Button key={b.action_id} b={b} inert={inert} />
          ))}
        </div>
      );
  }
}

/** "9:41 AM", Slack's message time, read in UTC so the server and every reader agree. */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
}

/**
 * One round in a channel, as Slack lays it out: the app's avatar, name, APP badge and time, then
 * the blocks. The avatar is the flame on the message's own ground, unboxed (docs/design.md).
 * `inert` draws links and buttons as text: a sample whose manage link belongs to no channel.
 */
export function SlackPreview({
  message,
  sentAt,
  channel = "deals",
  inert,
}: {
  message: SlackMessage;
  sentAt: string;
  channel?: string;
  inert?: boolean;
}) {
  return (
    <figure
      aria-label={`A Slack message from Fireround: ${message.text}`}
      data-slack-preview
      className="overflow-hidden rounded-12 border border-[#1d1c1d]/13 bg-white text-left shadow-[0_24px_48px_-28px_rgba(0,0,0,0.18)] dark:border-white/10 dark:bg-[#1a1d21] dark:shadow-none"
    >
      <div className="flex h-11 items-center gap-1.5 border-b border-[#1d1c1d]/13 px-4 dark:border-white/10">
        <span aria-hidden className={cn("text-[17px] leading-none", secondary)}>
          #
        </span>
        <span className={cn("text-[15px] font-bold", ink)}>{channel}</span>
      </div>
      <div className="flex gap-2 px-4 py-4 sm:px-5 sm:py-5">
        <span className="grid size-9 shrink-0 place-items-center">
          <FlameMark size="inherit" className="size-8" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="-mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
            <span className={cn("text-[15px] font-black", ink)}>Fireround</span>
            <span
              className={cn(
                "rounded-[3px] bg-[#1d1c1d]/13 px-[3px] py-px text-[10px] leading-[14px] font-bold dark:bg-white/13",
                secondary,
              )}
            >
              APP
            </span>
            <time dateTime={sentAt} className={cn("text-[12px]", secondary)}>
              {clock(sentAt)}
            </time>
          </p>
          {message.blocks.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks carry no id and never reorder
            <Block key={i} block={b} inert={inert} />
          ))}
        </div>
      </div>
    </figure>
  );
}

/** The frame at its loaded height while the round streams in. */
export function SlackPreviewSkeleton() {
  return <div aria-hidden className="h-[400px] rounded-12 border border-border-faint bg-card" />;
}
