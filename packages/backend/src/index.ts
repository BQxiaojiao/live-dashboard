import { resolve, normalize, relative, sep } from "node:path";
import { realpathSync } from "node:fs";
import { realpath as realpathAsync } from "node:fs/promises";
import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";
import { handleReport } from "./routes/report";
import { handleCurrent } from "./routes/current";
import { handleTimeline } from "./routes/timeline";
import { handleHealth } from "./routes/health";
import { handleHealthData, handleHealthDataQuery } from "./routes/health-data";
import { handleHealthWebhook } from "./routes/health-webhook";
import { handleConsentGet, handleConsentPost } from "./routes/consent";
import { handleConfig } from "./routes/config";
import { handleProxy } from "./routes/proxy";
import { injectSiteConfig } from "./services/site-config";
import { cleanupUnconfiguredDeviceData } from "./db";
import { getConfiguredDeviceIds } from "./middleware/auth";

// Start scheduled cleanup tasks (import triggers setInterval registration)
import "./services/cleanup";

const configuredDeviceIds = getConfiguredDeviceIds();
if (configuredDeviceIds.length > 0) {
  const cleaned = cleanupUnconfiguredDeviceData(configuredDeviceIds);
  const totalCleaned =
    cleaned.deviceStatesDeleted + cleaned.activitiesDeleted + cleaned.healthRecordsDeleted;
  if (totalCleaned > 0) {
    console.log(
      `[cleanup] Removed stale records: device_states=${cleaned.deviceStatesDeleted}, activities=${cleaned.activitiesDeleted}, health_records=${cleaned.healthRecordsDeleted}`
    );
  }
}

const PORT = parseInt(process.env.PORT || "3000", 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[server] Invalid PORT: ${process.env.PORT}, using 3000`);
}
const LISTEN_PORT = isNaN(PORT) || PORT < 1 || PORT > 65535 ? 3000 : PORT;

const STATIC_ROOT = resolve(process.env.STATIC_DIR || "./public");

// Cache realpath of static root at startup (avoids per-request sync IO)
let REAL_STATIC_ROOT = "";
let staticEnabled = false;
try {
  REAL_STATIC_ROOT = realpathSync(STATIC_ROOT);
  staticEnabled = true;
} catch {
  console.warn(`[server] Static dir not found: ${STATIC_ROOT} — static files won't be served`);
}

// === Static asset compression & caching ===
// Next.js emits content-hashed filenames under /_next/static, so they never change
// and can be cached by browsers/CDNs for a year. Everything else gets a short TTL.
const IMMUTABLE_PREFIX = "/_next/static/";
const COMPRESSIBLE_EXT = /\.(?:js|mjs|cjs|css|html|htm|json|map|svg|txt|xml|webmanifest)$/i;
const COMPRESS_CACHE_LIMIT = 128;

type Encoding = "br" | "gzip";

interface CompressedEntry {
  lastModified: number;
  br?: Uint8Array;
  gzip?: Uint8Array;
}

// Compression is CPU-bound and the container is limited to 0.5 CPU, so results are
// memoized per file. Files are immutable, so entries stay valid until the next rebuild.
const compressedCache = new Map<string, CompressedEntry>();

function parseAcceptEncoding(header: string | null): Map<string, number> {
  const accepted = new Map<string, number>();
  if (!header) return accepted;
  for (const raw of header.split(",")) {
    const [rawName, ...rawParams] = raw.trim().split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const param of rawParams) {
      const [rawKey, rawValue] = param.trim().split("=");
      if (rawKey?.trim().toLowerCase() === "q") {
        const parsed = Number(rawValue);
        if (!Number.isNaN(parsed)) quality = parsed;
      }
    }
    accepted.set(name, quality);
  }
  return accepted;
}

function pickEncoding(header: string | null): Encoding | null {
  const accepted = parseAcceptEncoding(header);
  const wildcard = accepted.get("*");
  const br = accepted.get("br") ?? wildcard;
  const gzip = accepted.get("gzip") ?? accepted.get("x-gzip") ?? wildcard;
  // "deflate" is ignored on purpose: brotli/gzip cover every browser we target.
  if (br !== undefined && br > 0 && (gzip === undefined || br >= gzip)) return "br";
  if (gzip !== undefined && gzip > 0) return "gzip";
  return null;
}

function compressBody(data: Uint8Array, encoding: Encoding): Uint8Array {
  return encoding === "br"
    ? brotliCompressSync(data, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
      })
    : gzipSync(data, { level: 6 });
}

function cacheControlFor(urlPath: string, isHtml: boolean): string {
  // HTML is never immutable: it carries the runtime site config and doubles as the
  // SPA fallback, so a missing /_next/static/* chunk must not be cached for a year.
  if (isHtml) return "no-cache";
  if (urlPath.startsWith(IMMUTABLE_PREFIX)) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

async function serveStaticFile(
  realFile: string,
  urlPath: string,
  acceptEncoding: string | null,
): Promise<Response> {
  const isHtml = realFile.endsWith(".html");
  const cacheControl = cacheControlFor(urlPath, isHtml);
  const encoding = pickEncoding(acceptEncoding);

  // HTML is injected per request (site config), so it is never cached on disk here.
  if (isHtml) {
    const body = new TextEncoder().encode(injectSiteConfig(await Bun.file(realFile).text()));
    const headers: Record<string, string> = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": cacheControl,
      Vary: "Accept-Encoding",
    };
    if (encoding) {
      headers["Content-Encoding"] = encoding;
      return new Response(compressBody(body, encoding), { headers });
    }
    return new Response(body, { headers });
  }

  const file = Bun.file(realFile);
  const headers: Record<string, string> = {
    "Content-Type": file.type || "application/octet-stream",
    "Cache-Control": cacheControl,
  };

  // Images/fonts/ico are already compressed — re-encoding them would waste CPU.
  if (!COMPRESSIBLE_EXT.test(realFile) || !encoding) {
    if (COMPRESSIBLE_EXT.test(realFile)) headers["Vary"] = "Accept-Encoding";
    return new Response(file, { headers });
  }

  headers["Vary"] = "Accept-Encoding";

  const lastModified = file.lastModified;
  let entry = compressedCache.get(realFile);
  if (!entry || entry.lastModified !== lastModified) {
    entry = { lastModified };
    compressedCache.set(realFile, entry);
  }

  let body = entry[encoding];
  if (!body) {
    body = compressBody(new Uint8Array(await file.arrayBuffer()), encoding);
    entry[encoding] = body;
  }

  if (compressedCache.size > COMPRESS_CACHE_LIMIT) {
    // Paths are content-hashed, so a rebuild produces new keys — dropping everything
    // is cheaper and safer than tracking LRU order.
    compressedCache.clear();
    compressedCache.set(realFile, entry);
  }

  headers["Content-Encoding"] = encoding;
  return new Response(body, { headers });
}

const server = Bun.serve({
  port: LISTEN_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    const acceptEncoding = req.headers.get("accept-encoding");

    // CORS headers for development
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // API routes
    let response: Response;

    try {
      if (pathname === "/api/report" && req.method === "POST") {
        response = await handleReport(req);
      } else if (pathname === "/api/current" && req.method === "GET") {
        const clientIp =
          req.headers.get("x-real-ip") ||
          req.headers.get("cf-connecting-ip") ||
          server.requestIP(req)?.address ||
          "";
        response = handleCurrent(clientIp, req.headers.get("user-agent") || undefined);
      } else if (pathname === "/api/timeline" && req.method === "GET") {
        response = handleTimeline(url);
      } else if (pathname === "/api/health" && req.method === "GET") {
        response = handleHealth();
      } else if (pathname === "/api/health-data" && req.method === "POST") {
        response = await handleHealthData(req);
      } else if (pathname === "/api/health-data" && req.method === "GET") {
        response = handleHealthDataQuery(url);
      } else if (pathname === "/api/health-webhook" && req.method === "POST") {
        response = await handleHealthWebhook(req);
      } else if (pathname === "/api/consent" && req.method === "GET") {
        response = handleConsentGet(req);
      } else if (pathname === "/api/consent" && req.method === "POST") {
        response = await handleConsentPost(req);
      } else if (pathname === "/api/config" && req.method === "GET") {
        response = handleConfig();
      } else if (pathname === "/api/proxy" && req.method === "GET") {
        response = await handleProxy(url);
      } else if (!pathname.startsWith("/api/")) {
        // Static file serving disabled if directory doesn't exist
        if (!staticEnabled) {
          response = Response.json({ error: "Not found" }, { status: 404 });
        } else {
          // Path traversal + symlink protection
          let decoded: string;
          try {
            decoded = decodeURIComponent(pathname);
          } catch {
            return new Response("Bad request", { status: 400 });
          }
          const safePath = normalize(decoded).replace(/^(\.\.[\/\\])+/, "");
          const resolved = resolve(STATIC_ROOT, safePath.replace(/^[\/\\]+/, ""));

          // Quick check: relative path must not escape root
          const rel = relative(STATIC_ROOT, resolved);
          if (rel.startsWith("..")) {
            response = Response.json({ error: "Forbidden" }, { status: 403 });
          } else {
            // Resolve symlinks and verify the real path is under root, then serve
            try {
              const realFile = await realpathAsync(resolved);
              if (realFile !== REAL_STATIC_ROOT && !realFile.startsWith(REAL_STATIC_ROOT + sep)) {
                response = Response.json({ error: "Forbidden" }, { status: 403 });
              } else {
                // Serve from the resolved real path
                const file = Bun.file(realFile);
                if (await file.exists()) {
                  return serveStaticFile(realFile, pathname, acceptEncoding);
                }
                // SPA fallback: file not found (or is a directory), serve index.html
                const indexFile = Bun.file(`${REAL_STATIC_ROOT}/index.html`);
                if (await indexFile.exists()) {
                  return serveStaticFile(`${REAL_STATIC_ROOT}/index.html`, pathname, acceptEncoding);
                }
                response = Response.json({ error: "Not found" }, { status: 404 });
              }
            } catch {
              // realpath fails if file doesn't exist — try SPA fallback
              const indexFile = Bun.file(`${REAL_STATIC_ROOT}/index.html`);
              if (await indexFile.exists()) {
                return serveStaticFile(`${REAL_STATIC_ROOT}/index.html`, pathname, acceptEncoding);
              }
              response = Response.json({ error: "Not found" }, { status: 404 });
            }
          }
        }
      } else {
        response = Response.json({ error: "Not found" }, { status: 404 });
      }
    } catch (e) {
      console.error("[server] Unhandled error:", e);
      response = Response.json({ error: "Internal error" }, { status: 500 });
    }

    // Append CORS headers to API responses
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value);
    }

    return response;
  },
});

console.log(`[server] Live Dashboard backend running on http://localhost:${server.port}`);
