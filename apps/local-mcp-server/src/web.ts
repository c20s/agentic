import { z } from "zod";
import type { ToolDefinition } from "./tools";
import { extractMarkdownOutline, formatMarkdownOutline, extractMarkdownSection } from "./outline";
import { renderPage, looksLikeUnrenderedSpa } from "./browser";
import { assertSafeUrl } from "./net-guard";

/**
 * Network tools: web_fetch / web_search.
 *
 * Unlike the filesystem tools, these don't operate on the sandbox root —
 * they reach out to the network instead. The `sandbox` parameter in
 * ToolDefinition is still accepted (for a uniform handler signature) but
 * unused here. To keep the write/access surface predictable:
 *   - both tools are read-only (no way to POST/PUT/DELETE, no cookies/auth)
 *   - requests to loopback/private/link-local addresses are blocked, so a
 *     prompt-injected URL can't be used to pivot into internal services
 *   - responses are capped in size and the HTML is reduced to readable text
 *     to avoid flooding the model's context with markup/scripts/styles
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_FETCH_BYTES = 1_000_000;
const MAX_RETURNED_CHARS = 50_000;
const USER_AGENT = "local-mcp-server/0.1 (+https://github.com)";

/** Strips tags/scripts/styles and collapses whitespace, producing plain readable text from HTML. */
function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block-ish elements become line breaks so paragraphs/headings stay separated.
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "");

  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-zA-Z0-9#]+;/g, " ");

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]!).trim() || null : null;
}

interface RawHtmlHeading {
  level: number;
  text: string;
  start: number; // char index in the raw html where this <hN> tag starts
}

/**
 * Scans raw HTML for <h1>-<h6> tags (in document order) and returns their nesting level,
 * visible text, and byte offset. Used to slice out a "section" of raw HTML without ever
 * converting the page to markdown, mirroring extractMarkdownSection's heading-based approach.
 */
function extractRawHtmlHeadings(html: string): RawHtmlHeading[] {
  const headings: RawHtmlHeading[] = [];
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const text = htmlToText(match[2]!).replace(/\s+/g, " ").trim();
    if (!text) continue;
    headings.push({ level: Number(match[1]), text, start: match.index });
  }
  return headings;
}

/**
 * Finds a heading whose text matches headingQuery (substring, case-insensitive) and returns the raw HTML
 * slice from that heading's opening tag through (but not including) the next heading of equal-or-higher
 * level, or the end of the document. Returns null if no heading matches.
 */
function extractRawHtmlSection(html: string, headingQuery: string): string | null {
  const headings = extractRawHtmlHeadings(html);
  const needle = headingQuery.toLowerCase();
  const idx = headings.findIndex((h) => h.text.toLowerCase().includes(needle));
  if (idx === -1) return null;

  const target = headings[idx]!;
  const next = headings.slice(idx + 1).find((h) => h.level <= target.level);
  const end = next ? next.start : html.length;

  return html.slice(target.start, end).trim();
}

/**
 * Converts HTML into a lightweight markdown-ish representation: headings
 * become "#".."######" lines, links become "[text](href)", and everything
 * else falls back to the same plain-text flattening as htmlToText. This lets
 * us reuse outline.ts's markdown heading extraction/section logic unchanged,
 * so web_fetch gets the exact same "outline first, drill down with a
 * section" UX as read_file does for local markdown files.
 */
function htmlToMarkdown(html: string, baseUrl: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // Headings -> "# text" / "## text" / etc, each on its own line.
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const clean = htmlToText(inner).replace(/\s+/g, " ").trim();
    return clean ? `\n\n${"#".repeat(Number(level))} ${clean}\n\n` : "\n";
  });

  // Links -> "[text](absolute-href)", resolved against the page URL.
  text = text.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const label = htmlToText(inner).replace(/\s+/g, " ").trim();
    if (!label) return "";
    let resolved = href;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      // leave href as-is if it's not resolvable (e.g. "javascript:...", "#anchor")
    }
    return `[${label}](${resolved})`;
  });

  // Block-ish elements become line breaks so paragraphs/list items stay separated.
  text = text
    .replace(/<\/(p|div|section|article|header|footer|nav|main|li|tr|blockquote)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/?[a-z][^>]*>/gi, "");

  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-zA-Z0-9#]+;/g, " ");

  // Collapse excess blank lines/whitespace while keeping headings/paragraphs separated.
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a response body up to a byte cap, without buffering unbounded data into memory. */
async function readBounded(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    const truncated = text.length > maxBytes;
    return { text: truncated ? text.slice(0, maxBytes) : text, truncated };
  }

  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      const allowed = value.byteLength - (received - maxBytes);
      out += decoder.decode(value.slice(0, Math.max(0, allowed)), { stream: true });
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return { text: out, truncated };
}

function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

// A page below this size just isn't worth outlining — return it in full directly,
// same spirit as read_file's FULL_READ_FREE_THRESHOLD_BYTES.
const FETCH_OUTLINE_THRESHOLD_CHARS = 4_000;

const renderModeSchema = z
  .enum(["auto", "always", "never"])
  .default("auto")
  .describe(
    "Controls headless-browser (JavaScript) rendering for single-page apps: " +
      "'auto' (default) fetches statically first and only falls back to rendering with a headless " +
      "browser if the page looks like an unrendered SPA shell (e.g. an empty #root/#app div); " +
      "'always' forces a browser render even if the static fetch looked fine (slower, but authoritative " +
      "for pages with optimistic heuristics); 'never' disables rendering entirely, even for obvious SPA shells."
  );

const webFetchSchema = z.object({
  url: z.string().describe("The absolute http(s) URL to fetch, e.g. 'https://example.com/page'."),
  full: z
    .boolean()
    .default(false)
    .describe(
      "If true, skip outline mode and return the full converted page content (still capped by the overall size limit). " +
        "Ignored when 'raw' is true (raw mode never does markdown conversion, so there's no outline to skip). Default false."
    ),
  section: z
    .string()
    .optional()
    .describe(
      "Fetch just one section of the page instead of the whole thing: matched against a heading's text " +
        "(substring, case-insensitive), returning that heading through the next heading of equal-or-higher level. " +
        "Use this after seeing the outline (call web_fetch({url}) first), similar to read_file's 'symbol' parameter. " +
        "Works whether or not 'raw' is also set: without 'raw' you get that section in markdown (the normal, " +
        "cheaper choice); with 'raw: true' you get that section's exact unconverted HTML instead of the whole " +
        "raw page."
    ),
  raw: z
    .boolean()
    .default(false)
    .describe(
      "Last resort, not a starting point: fetch the outline and/or a 'section' in markdown first, and only set " +
        "'raw: true' if that's not enough (e.g. you need a table's real structure, tab/accordion boundaries, an " +
        "element's exact attributes, a JSON/plain-text API body, or the markdown conversion looks wrong). " +
        "When true, returns the response body as-is instead of converting HTML to markdown, and takes precedence " +
        "over 'full' and 'render' (no markdown conversion, no SPA rendering happen in raw mode). " +
        "Combine with 'section' to scope raw mode to one part of an HTML page instead of dumping the whole raw " +
        "document: it matches an <h1>-<h6> tag by its visible text (substring, case-insensitive) and returns the " +
        "raw HTML from that heading through the next heading of equal-or-higher level. Default false."
    ),
  render: renderModeSchema,
});

/** Builds the `[url — HTTP status, content-type, ...]` header line prefixed to every web_fetch response. */
function formatHeader(url: string, status: number, contentType: string, rendered: boolean): string {
  const renderedTag = rendered ? ", rendered: js" : "";
  return `[${url} — HTTP ${status}, content-type: ${contentType || "unknown"}${renderedTag}]`;
}

/** Applies the raw/outline/section/full decision to an already-fetched-or-rendered HTML page. */
function presentHtml(
  header: string,
  html: string,
  finalUrl: string,
  opts: { full: boolean; section?: string }
): string {
  const title = extractTitle(html);
  const markdown = htmlToMarkdown(html, finalUrl);
  const titled = title ? `# ${title}\n\n${markdown}` : markdown;

  if (opts.section) {
    const found = extractMarkdownSection(titled, opts.section);
    if (found === null) {
      const headings = extractMarkdownOutline(titled);
      throw new Error(
        headings.length > 0
          ? `No heading matching "${opts.section}" was found on the page. Use web_fetch without 'section' to see the outline (all headings).`
          : `No heading matching "${opts.section}" was found, and the page has no headings at all. Use web_fetch with 'full: true' instead.`
      );
    }
    const { text: finalText, truncated } = truncateChars(found, MAX_RETURNED_CHARS);
    return truncated ? `${header}\n\n${finalText}\n\n... (truncated)` : `${header}\n\n${finalText}`;
  }

  if (!opts.full && titled.length > FETCH_OUTLINE_THRESHOLD_CHARS) {
    const headings = extractMarkdownOutline(titled);
    if (headings.length > 0) {
      const outline = formatMarkdownOutline(headings);
      return (
        `${header}\n\n[Outline — use web_fetch with section:"<heading text>" for one section, ` +
        `or full:true for the entire page]\n\n${outline}`
      );
    }
    // No headings found at all: nothing meaningful to outline, fall through to returning full content.
  }

  const { text: finalText, truncated } = truncateChars(titled, MAX_RETURNED_CHARS);
  return truncated ? `${header}\n\n${finalText}\n\n... (truncated)` : `${header}\n\n${finalText}`;
}

export const webFetchTool: ToolDefinition<typeof webFetchSchema> = {
  name: "web_fetch",
  description:
    "Fetch a single URL over http(s). Read-only, GET only (no cookies/auth/state). " +
    "HTML pages are converted to markdown-ish readable text (headings, links as [text](url)), and by default " +
    "only an OUTLINE is returned (page title + all headings with their nesting, like read_file does for local " +
    ".md files) instead of the full page — this avoids flooding context with a huge page. See 'Efficient usage' " +
    "below for how 'section', 'full', and 'raw' fit together. " +
    "Single-page apps (React/Vue/Angular etc.) that render content with client-side JavaScript are handled " +
    "automatically: by default ('render: \"auto\"') a plain static fetch is tried first, and if the result " +
    "looks like an empty, unrendered SPA shell, a headless Chromium browser (via playwright-core) renders the " +
    "page and the real, post-JavaScript content is returned instead. Use 'render: \"always\"' to force a browser " +
    "render, or 'render: \"never\"' to disable it. Rendering is slower (headless browser) so 'auto' only pays " +
    "that cost when it looks necessary. " +
    "Requests to localhost/private/link-local addresses are blocked. Responses are capped in size " +
    `(~${MAX_FETCH_BYTES} bytes fetched, ~${MAX_RETURNED_CHARS} chars returned) and time out after ${DEFAULT_TIMEOUT_MS}ms. ` +
    "Efficient usage, in order: " +
    "(1) web_fetch({url}) first, to see the outline (headings only) without spending context on the full page; " +
    "(2) web_fetch({url, section: \"...\"}) to read the one or two sections that look relevant, in markdown; " +
    "(3) only if you specifically need exact, unconverted markup (e.g. a table's real structure, tab/accordion " +
    "boundaries, an element's attributes, or markdown conversion looks like it dropped/garbled something) add " +
    "'raw: true' — optionally still combined with 'section' to keep it scoped to one part instead of the whole " +
    "raw page. Avoid reaching for 'raw: true' or 'full: true' by default: they cost more context and, for 'raw', " +
    "lose the readable formatting most tasks don't need.",
  inputSchema: webFetchSchema,
  handler: async ({ url, full, section, raw, render }) => {
    const safeUrl = assertSafeUrl(url);

    const res = await fetchWithTimeout(
      safeUrl.toString(),
      {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8" },
      },
      DEFAULT_TIMEOUT_MS
    );

    // Re-validate the final URL after redirects, in case a redirect chain tried to pivot to a blocked host.
    const finalUrl = res.url || safeUrl.toString();
    assertSafeUrl(finalUrl);

    if (!res.ok) {
      throw new Error(`Request failed: HTTP ${res.status} ${res.statusText} for ${safeUrl}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const { text: body, truncated: bodyTruncated } = await readBounded(res, MAX_FETCH_BYTES);
    const isHtml = contentType.includes("html");

    if (raw || !isHtml) {
      const header = formatHeader(safeUrl.toString(), res.status, contentType, false);

      if (raw && isHtml && section) {
        const found = extractRawHtmlSection(body, section);
        if (found === null) {
          const headings = extractRawHtmlHeadings(body);
          throw new Error(
            headings.length > 0
              ? `No heading matching "${section}" was found in the raw HTML. Use web_fetch without 'raw' to see the outline (all headings), or check the heading text and try again.`
              : `No heading matching "${section}" was found, and the page has no <h1>-<h6> tags at all. Use web_fetch with 'raw: true' (no 'section') instead.`
          );
        }
        const { text: finalText, truncated } = truncateChars(found, MAX_RETURNED_CHARS);
        return truncated ? `${header}\n\n${finalText}\n\n... (truncated)` : `${header}\n\n${finalText}`;
      }

      const { text: finalText, truncated: charsTruncated } = truncateChars(body, MAX_RETURNED_CHARS);
      const truncated = bodyTruncated || charsTruncated;
      return truncated ? `${header}\n\n${finalText}\n\n... (truncated)` : `${header}\n\n${finalText}`;
    }

    if (render === "never") {
      const header = formatHeader(safeUrl.toString(), res.status, contentType, false);
      return presentHtml(header, body, finalUrl, { full, section });
    }

    const visibleText = htmlToText(body);
    const needsRender = render === "always" || (render === "auto" && looksLikeUnrenderedSpa(body, visibleText));

    if (!needsRender) {
      const header = formatHeader(safeUrl.toString(), res.status, contentType, false);
      return presentHtml(header, body, finalUrl, { full, section });
    }

    try {
      const rendered = await renderPage(safeUrl.toString());
      assertSafeUrl(rendered.finalUrl); // guard against a client-side redirect pivoting to a blocked host
      const header = formatHeader(rendered.finalUrl, res.status, "text/html", true);
      return presentHtml(header, rendered.html, rendered.finalUrl, { full, section });
    } catch (err) {
      if (render === "always") throw err; // explicitly requested: surface the failure
      // 'auto' fallback failed (e.g. playwright-core not installed, browser launch failed): fall back to
      // the static HTML we already have rather than failing the whole call.
      const message = err instanceof Error ? err.message : String(err);
      const header = formatHeader(safeUrl.toString(), res.status, contentType, false);
      const presented = presentHtml(header, body, finalUrl, { full, section });
      return `${presented}\n\n[Note: this page looked like it may need JavaScript rendering, but rendering failed (${message}); showing the static HTML instead.]`;
    }
  },
};

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

const webSearchSchema = z.object({
  query: z.string().describe("The search query."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe("Maximum number of results to return (1-20, default 8)."),
});

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Parses DuckDuckGo's no-JS HTML results page (html.duckduckgo.com/html/).
 * This endpoint requires no API key, which keeps the tool usable out of the
 * box; it's screen-scraped best-effort and may need adjusting if DDG changes
 * its markup.
 */
function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRe = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bresult\b[^"]*"|$)/gi;
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i;

  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) !== null) {
    const block = match[1]!;
    const linkMatch = block.match(linkRe);
    if (!linkMatch) continue;

    let href = linkMatch[1]!;
    // DDG wraps result URLs in a redirect like /l/?uddg=<encoded>&...
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]!);
      } catch {
        // keep original href if decoding fails
      }
    }
    if (href.startsWith("//")) href = `https:${href}`;

    const title = htmlToText(linkMatch[2]!).trim();
    const snippetMatch = block.match(snippetRe);
    const snippet = snippetMatch ? htmlToText(snippetMatch[1]!).trim() : "";

    if (title && href) {
      results.push({ title, url: href, snippet });
    }
  }
  return results;
}

export const webSearchTool: ToolDefinition<typeof webSearchSchema> = {
  name: "web_search",
  description:
    "Search the web for a query and return a list of results (title, URL, snippet). Read-only. " +
    "Backed by DuckDuckGo's HTML results page, so no API key is required. " +
    "Use web_fetch afterwards to read the full content of a specific result URL.",
  inputSchema: webSearchSchema,
  handler: async ({ query, maxResults }) => {
    const searchUrl = new URL("https://html.duckduckgo.com/html/");
    searchUrl.searchParams.set("q", query);

    const res = await fetchWithTimeout(
      searchUrl.toString(),
      {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html",
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
      DEFAULT_TIMEOUT_MS
    );

    if (!res.ok) {
      throw new Error(`Search request failed: HTTP ${res.status} ${res.statusText}`);
    }

    const { text: html } = await readBounded(res, MAX_FETCH_BYTES);
    const results = parseDuckDuckGoHtml(html).slice(0, maxResults);

    if (results.length === 0) {
      return `No results for "${query}".`;
    }

    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
      .join("\n\n");
  },
};

export const webTools = [webFetchTool, webSearchTool];
