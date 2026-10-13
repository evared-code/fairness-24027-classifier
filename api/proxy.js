// Vercel Function: the API proxy at /api/proxy, using exactly the same code as proxy/handler.js.
//
// With vercel.json's rewrite, these addresses work:
//   GET  /api/proxy/health    GET  /api/proxy/key    POST /api/proxy/forward
// The tool, served from the same Vercel project, uses  /api/proxy  as its proxy address.
//
// Settings are Vercel environment variables (Project → Settings → Environment Variables):
//   PRIVATE_KEY_JWK (mark as Sensitive), ALLOWED_HOSTS, MAX_BODY_BYTES, RATE_LIMIT_PER_MIN,
//   ALLOWED_ORIGINS (default here: this deployment's own address only; add a custom domain if you use one)

import { handle } from "../proxy/handler.js";

export const config = { maxDuration: 60 };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    // The rewrite passes the sub-path as ?path=...; a direct call to /api/proxy/<sub> also works.
    const sub = url.searchParams.get("path");
    const path = sub != null ? `/${sub.replace(/^\/+/, "")}` : url.pathname.replace(/^\/api\/proxy/, "") || "/";
    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" || method === "OPTIONS" ? undefined : await request.text();
    const inner = new Request(new URL(path, url.origin), { method, headers: request.headers, body });
    const ip = request.headers.get("x-real-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    // Without ALLOWED_ORIGINS, only pages of this same deployment may use the proxy (not "*").
    const env = { ...process.env, ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || url.origin };
    return handle(inner, env, { clientIp: ip });
  },
};
