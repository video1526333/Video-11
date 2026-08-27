import http from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Keep the local API and static files on the same origin as the app.
// Override with PORT when running behind a platform such as Render.
const PORT = Number(process.env.PORT || 8899);
const PUBLIC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_HOSTS = new Set(["api.yzzy-api.com"]);
const configuredHlsHosts = (process.env.HLS_ALLOWED_HOSTS || "*").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
const HLS_ALLOW_ANY_HOST = configuredHlsHosts.includes("*") || configuredHlsHosts.includes("all");
const HLS_ALLOWED_HOSTS = new Set(configuredHlsHosts.filter((host) => host !== "*" && host !== "all"));
const HLS_PROXY_TIMEOUT_MS = Math.max(1000, Number(process.env.HLS_PROXY_TIMEOUT_MS || 20000));
const isHlsHostAllowed = (hostname) => HLS_ALLOW_ANY_HOST || HLS_ALLOWED_HOSTS.has(hostname.toLowerCase());

const sendHlsError = (res, status, code, message, retryable, extra = {}) => {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify({ ok: false, code, message, retryable, ...extra });
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
};

const parseAllowedUrl = (value) => {
  let targetUrl;
  try { targetUrl = new URL(value || ""); } catch { return { code: "INVALID_URL", status: 400, message: "HLS 地址无效", retryable: false }; }
  if (!["http:", "https:"].includes(targetUrl.protocol)) return { code: "INVALID_URL", status: 400, message: "HLS 地址无效", retryable: false };
  if (!isHlsHostAllowed(targetUrl.hostname)) return { code: "HLS_HOST_NOT_ALLOWED", status: 403, message: "HLS CDN 未加入允许列表", retryable: false };
  return { targetUrl };
};

const fetchAllowedHls = async (initialUrl, signal, requestHeaders = {}) => {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const upstream = await fetch(currentUrl, { headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*", ...requestHeaders }, signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(upstream.status)) return { upstream, finalUrl: currentUrl };
    const location = upstream.headers.get("location");
    if (!location) return { upstream, finalUrl: currentUrl };
    let nextUrl;
    try { nextUrl = new URL(location, currentUrl); } catch { const error = new Error("Invalid redirect URL"); error.code = "REDIRECT_HOST_NOT_ALLOWED"; throw error; }
    if (!isHlsHostAllowed(nextUrl.hostname)) { const error = new Error("Redirect host not allowed"); error.code = "REDIRECT_HOST_NOT_ALLOWED"; throw error; }
    currentUrl = nextUrl;
  }
  const error = new Error("Too many redirects");
  error.code = "UPSTREAM_UNAVAILABLE";
  throw error;
};

const proxyHls = async (req, res, target) => {
  const parsed = parseAllowedUrl(target);
  if (parsed.code) { sendHlsError(res, parsed.status, parsed.code, parsed.message, parsed.retryable); return; }
  const controller = new AbortController();
  let timedOut = false;
  let streaming = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, HLS_PROXY_TIMEOUT_MS);
  const abortWhenClientCloses = () => { if (!res.writableEnded) controller.abort(); };
  const cleanup = () => { clearTimeout(timeout); res.removeListener("close", abortWhenClientCloses); };
  res.once("close", abortWhenClientCloses);
  try {
    const result = await fetchAllowedHls(parsed.targetUrl, controller.signal, req.headers.range ? { Range: req.headers.range } : {});
    const upstream = result.upstream;
    const finalUrl = result.finalUrl;
    if (!isHlsHostAllowed(finalUrl.hostname)) { sendHlsError(res, 502, "REDIRECT_HOST_NOT_ALLOWED", "视频服务器重定向到未允许的域名", false); return; }
    if (!upstream.ok) {
      if (upstream.status === 408 || upstream.status === 504) { sendHlsError(res, 504, "UPSTREAM_TIMEOUT", "视频服务器响应超时，可以重试", true, { upstreamStatus: upstream.status }); return; }
      if (upstream.status >= 500) { sendHlsError(res, 502, "UPSTREAM_UNAVAILABLE", "视频服务器暂时不可用，可以重试", true, { upstreamStatus: upstream.status }); return; }
      sendHlsError(res, upstream.status === 404 ? 404 : 502, "UPSTREAM_HTTP_ERROR", upstream.status === 404 ? "视频资源已失效" : `视频服务器返回错误（${upstream.status}）`, upstream.status === 429, { upstreamStatus: upstream.status });
      return;
    }
    const headers = { "Content-Type": upstream.headers.get("content-type") || "application/octet-stream", "Cache-Control": "no-store" };
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers["Content-Range"] = contentRange;
    if (upstream.status === 206) headers["Accept-Ranges"] = "bytes";
    const length = upstream.headers.get("content-length");
    if (length) headers["Content-Length"] = length;
    res.writeHead(upstream.status === 206 ? 206 : 200, headers);
    if (!upstream.body) { res.end(); cleanup(); return; }
    const stream = Readable.fromWeb(upstream.body);
    streaming = true;
    stream.once("end", cleanup);
    stream.once("error", () => { cleanup(); if (!res.writableEnded) res.destroy(); });
    stream.pipe(res);
  } catch (error) {
    if (res.writableEnded || res.destroyed) return;
    if (error?.code === "REDIRECT_HOST_NOT_ALLOWED") { sendHlsError(res, 502, "REDIRECT_HOST_NOT_ALLOWED", "视频服务器重定向到未允许的域名", false); return; }
    if (error?.code === "UPSTREAM_UNAVAILABLE" && error.message === "Too many redirects") { sendHlsError(res, 502, "UPSTREAM_UNAVAILABLE", "视频服务器重定向次数过多，可以重试", true); return; }
    if (error?.name === "AbortError" && timedOut) { sendHlsError(res, 504, "UPSTREAM_TIMEOUT", "视频服务器响应超时，可以重试", true); return; }
    if (error?.name === "AbortError") return;
    sendHlsError(res, 502, "UPSTREAM_UNAVAILABLE", "无法访问视频服务器，可以重试", true);
  } finally {
    if (!streaming) cleanup();
  }
};

const staticTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const target = reqUrl.searchParams.get("url");
  if (reqUrl.pathname === "/hls-proxy") { await proxyHls(req, res, target); return; }
  if (reqUrl.pathname === "/download") { res.writeHead(410, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ ok: false, code: "MP4_UNSUPPORTED", message: "不再生成 MP4，请保存 HLS 供离线观看", retryable: false })); return; }
  if (req.method === "GET" && !target) {
    let requested;
    try { requested = decodeURIComponent(reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname); } catch { res.writeHead(400); res.end("Invalid path"); return; }
    const relative = path.normalize(requested).replace(/^[/\\]+/, "");
    if (relative.startsWith("..") || path.isAbsolute(relative)) { res.writeHead(403); res.end("Forbidden"); return; }
    const filePath = path.join(PUBLIC_DIR, relative);
    try { const body = await readFile(filePath); res.writeHead(200, { "Content-Type": staticTypes[path.extname(filePath)] || "application/octet-stream" }); res.end(body); } catch { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not found"); }
    return;
  }
  if (!target) { res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Missing url param"); return; }
  let targetUrl;
  try { targetUrl = new URL(target); } catch { res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Invalid url param"); return; }
  if (!ALLOWED_HOSTS.has(targetUrl.hostname.toLowerCase())) { res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Host not allowed"); return; }
  try { const upstream = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" } }); const body = await upstream.text(); res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" }); res.end(body); } catch (error) { res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }); res.end(`Upstream fetch failed: ${error.message}`); }
});

server.listen(PORT, "0.0.0.0", () => console.log(`CORS proxy listening on http://localhost:${PORT}`));
