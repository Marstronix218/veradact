// /c/static/client.css — the client pages' stylesheet, same origin so the CSP can stay
// `style-src 'self'` with no inline styles.
import { CLIENT_CSS } from "@/client/styles";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(CLIENT_CSS, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
