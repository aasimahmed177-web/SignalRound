"use client";

// Replaces the root layout when it throws, so it carries its own html and body and none of
// the app's styles reach it. The few rules below are inline for that reason: Paper and Graphite,
// the house ink for the message, and the OS theme since next-themes is not mounted either.
const CSS = `
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f9f9f9; color: #262626;
    font: 15px/22px system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 32rem; padding: 2rem; }
  .code { font: 11px/16px ui-monospace, "SF Mono", monospace; letter-spacing: 0.04em; color: rgba(38, 38, 38, 0.72); }
  h1 { margin: 12px 0 0; font-size: 24px; line-height: 32px; font-weight: 500; letter-spacing: -0.24px; }
  p { margin: 8px 0 0; color: rgba(38, 38, 38, 0.78); }
  .ref { margin-top: 24px; font: 11px/16px ui-monospace, "SF Mono", monospace; color: rgba(38, 38, 38, 0.72); }
  .actions { margin-top: 24px; display: flex; gap: 8px; }
  button, a { font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 8px; cursor: pointer; text-decoration: none; }
  button { border: 0; background: #d23f00; color: #fff; }
  a { border: 1px solid #e8e8e8; color: inherit; }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0a; color: #f5f5f5; }
    .code { color: rgba(245, 245, 245, 0.6); }
    p, .ref { color: rgba(245, 245, 245, 0.7); }
    a { border-color: #333; }
  }
`;

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <style>{CSS}</style>
        <main>
          <div className="code">[ ERROR ]</div>
          <h1>Fireround didn't load.</h1>
          {/* Never the error's own text: in production it is Next's boilerplate. The digest matches the server log. */}
          <p>Something went wrong on our side. It is usually brief, so try again in a moment.</p>
          <div className="actions">
            <button type="button" onClick={() => retry()}>
              Try again
            </button>
            <a href="/feed">Open the feed</a>
          </div>
          {error.digest && <div className="ref">Reference {error.digest}</div>}
        </main>
      </body>
    </html>
  );
}
