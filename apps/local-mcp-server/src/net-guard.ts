/**
 * Shared SSRF guard: hostnames/IP ranges that must never be reachable from
 * this server, whether via plain fetch() (web.ts) or from inside the
 * headless-browser renderer (browser.ts) — including requests the rendered
 * PAGE ITSELF makes (redirects, fetch/XHR, iframes, websockets, etc.), not
 * just the top-level URL the caller asked for.
 *
 * Kept as one module so both call sites can't drift out of sync.
 */

/** True if `hostname` resolves to loopback/private/link-local/CGNAT space and must be blocked. */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;

  // IPv4 literal checks: loopback, private ranges, link-local, metadata endpoint.
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local / cloud metadata (169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  // Bare IPv6 loopback/link-local/unique-local checks (best-effort, no full parser).
  if (h.includes(":")) {
    const stripped = h.replace(/^\[|\]$/g, "");
    if (stripped === "::1") return true;
    if (stripped.startsWith("fe80:")) return true; // link-local
    if (stripped.startsWith("fc") || stripped.startsWith("fd")) return true; // unique local
  }

  return false;
}

/**
 * Validates a URL is http(s) and not pointed at a blocked host, returning
 * the parsed URL. Throws a descriptive error otherwise. Use this for URLs
 * the caller directly controls (e.g. the top-level web_fetch URL param).
 */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${url.protocol}". Only http:// and https:// are allowed.`);
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error(`Refusing to fetch "${url.hostname}": loopback/private/link-local addresses are blocked.`);
  }
  return url;
}

/**
 * Non-throwing variant for call sites that just need a boolean (e.g. a
 * Playwright route handler deciding per-request whether to abort), such as
 * sub-resource requests a rendered page makes on its own. Also rejects
 * non-http(s) schemes except a small allowlist of schemes Chromium itself
 * uses internally (about:blank, data: for inline resources already fetched)
 * — anything else (file:, chrome:, view-source:, etc.) is blocked too.
 */
export function isBlockedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true; // unparsable -> block rather than risk an unvalidated request
  }

  if (url.protocol === "about:" || url.protocol === "data:" || url.protocol === "blob:") {
    return false; // inert/inline, not network requests
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return true; // block file:, chrome:, chrome-extension:, view-source:, ftp:, etc.
  }
  return isBlockedHostname(url.hostname);
}
