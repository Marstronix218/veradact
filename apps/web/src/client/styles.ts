// The client pages' only stylesheet, served same-origin from /c/static/client.css (CSP
// `style-src 'self'`, no inline styles). Mobile first, single column, large type and tap targets,
// no web fonts; long hashes wrap so nothing scrolls sideways at 320px.
export const CLIENT_CSS = `
:root {
  color-scheme: light;
  --fg: #18181b;
  --muted: #52525b;
  --line: #d4d4d8;
  --bg: #fafafa;
  --card: #ffffff;
  --accent: #18181b;
  --ok: #166534;
  --ok-bg: #f0fdf4;
  --ok-line: #bbf7d0;
  --bad: #991b1b;
  --bad-bg: #fef2f2;
  --bad-line: #fecaca;
  --warn-bg: #fffbeb;
  --warn-line: #fde68a;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 18px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  overflow-wrap: break-word;
}
main { max-width: 40rem; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 12px; }
h2 { font-size: 1.25rem; line-height: 1.3; margin: 32px 0 12px; }
p { margin: 0 0 16px; }
a { color: var(--accent); }
.eyebrow { margin: 0 0 4px; font-size: 0.95rem; color: var(--muted); }
.muted { color: var(--muted); font-size: 1rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 0 0 16px; }
.card.updated { background: #f4f4f5; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; margin: 0 0 6px; }
.kind { font-size: 0.8rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.code, .hash { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85rem; }
.hash { overflow-wrap: anywhere; word-break: break-all; }
.statement { font-size: 1.15rem; font-weight: 600; margin: 0 0 12px; }
blockquote { margin: 0 0 12px; padding: 8px 12px; border-left: 4px solid var(--line); background: #f4f4f5; border-radius: 0 8px 8px 0; }
blockquote p { margin: 0 0 4px; }
.source { font-size: 0.9rem; color: var(--muted); margin: 0; }
.diff { margin: 0 0 12px; padding: 8px 12px; background: #f4f4f5; border-radius: 8px; font-size: 1rem; }
.diff p { margin: 0 0 4px; }
ins { background: #dcfce7; color: #14532d; text-decoration: underline; }
del { background: #fee2e2; color: #7f1d1d; text-decoration: line-through; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
legend { padding: 0; margin: 0 0 8px; font-weight: 600; font-size: 1rem; }
.choice { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 10px 12px; margin: 0 0 8px; border: 1px solid var(--line); border-radius: 10px; background: #fff; cursor: pointer; }
.choice input { flex: none; width: 22px; height: 22px; margin: 0; accent-color: var(--accent); }
.choice:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.comment-label { display: block; margin: 4px 0 6px; font-size: 1rem; }
textarea { display: block; width: 100%; min-height: 96px; padding: 10px 12px; font: inherit; font-size: 1rem; border: 1px solid var(--line); border-radius: 10px; }
textarea:focus, .choice:focus-within, .button:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }
.field-error { margin: 6px 0 0; color: var(--bad); font-weight: 600; font-size: 1rem; }
.card.has-error { border-color: var(--bad); }
.button { display: block; width: 100%; min-height: 52px; margin: 0 0 12px; padding: 12px 16px; font: inherit; font-weight: 600; text-align: center; text-decoration: none; color: #fff; background: var(--accent); border: 2px solid var(--accent); border-radius: 10px; cursor: pointer; }
.button.secondary { color: var(--accent); background: #fff; }
.actions { margin: 24px 0 0; }
.notice { margin: 0 0 16px; padding: 12px 16px; border-radius: 10px; background: var(--warn-bg); border: 1px solid var(--warn-line); }
.notice.error { background: var(--bad-bg); border-color: var(--bad-line); color: var(--bad); }
.notice.ok { background: var(--ok-bg); border-color: var(--ok-line); color: var(--ok); }
.notice p:last-child { margin: 0; }
.authorization { white-space: pre-wrap; margin: 0 0 20px; padding: 16px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; font-size: 1rem; }
.decision { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.9rem; font-weight: 700; }
.decision.confirmed { background: var(--ok-bg); color: var(--ok); }
.decision.disputed { background: var(--bad-bg); color: var(--bad); }
.list { margin: 0 0 16px; padding-left: 20px; }
.list li { margin: 0 0 8px; }
dl.facts { margin: 0 0 16px; }
dl.facts dt { font-size: 0.9rem; color: var(--muted); margin: 8px 0 0; }
dl.facts dd { margin: 0; }
footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 0.9rem; color: var(--muted); }
@media (min-width: 640px) {
  main { padding-top: 48px; }
  h1 { font-size: 1.9rem; }
}
`;
