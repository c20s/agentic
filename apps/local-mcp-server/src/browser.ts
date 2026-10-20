/**
 * Headless-browser rendering for web_fetch, so single-page apps (React/Vue/
 * Angular/etc. that render client-side) come back as real content instead of
 * an empty HTML shell like `<div id="root"></div>` + script tags.
 *
 * `playwright-core` is an OPTIONAL dependency on purpose: it (plus the
 * Chromium binary it drives) is heavy, and most fetched pages are plain
 * server-rendered HTML that doesn't need a browser at all. We only import it
 * lazily, the first time a render is actually attempted, and fail with a
 * clear, actionable error if it (or a browser binary) isn't available —
 * the rest of web_fetch keeps working via plain fetch() regardless.
 */

const RENDER_TIMEOUT_MS = 20_000;
const RENDER_WAIT_AFTER_LOAD_MS = 500;

let browserPromise: Promise<import("playwright-core").Browser> | null = null;

/** Lazily launches (once) and reuses a single headless Chromium instance for the life of the server process. */
async function getBrowser(): Promise<import("playwright-core").Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      let playwright: typeof import("playwright-core");
      try {
        playwright = await import("playwright-core");
      } catch {
        throw new Error(
          "Rendering requires the optional 'playwright-core' dependency, which isn't installed. " +
            "Run `bun install` in apps/local-mcp-server (it's an optionalDependency, so install failures there " +
            "don't break the rest of the server)."
        );
      }
      try {
        return await playwright.chromium.launch({ headless: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to launch headless Chromium for rendering: ${message}. ` +
            "If no browser binary is installed, run: `bunx playwright install chromium` " +
            "(or `bunx playwright install-deps chromium` for missing OS dependencies)."
        );
      }
    })();
    // If launching failed, allow a later call to retry instead of permanently caching the rejection.
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

/** Closes the shared browser, if one was ever launched. Call on server shutdown. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    // already closed / never successfully launched — nothing to do
  } finally {
    browserPromise = null;
  }
}

export interface RenderResult {
  html: string;
  finalUrl: string;
}

/**
 * Loads a URL in headless Chromium, waits for it to settle, and returns the
 * fully rendered DOM's outerHTML (i.e. post-JavaScript content).
 */
export async function renderPage(url: string, timeoutMs: number = RENDER_TIMEOUT_MS): Promise<RenderResult> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/120.0.0.0 Safari/537.36 local-mcp-server/0.1",
  });
  try {
    const page = await context.newPage();
    // Block heavy, content-irrelevant resources so rendering is faster and lighter.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") {
        return route.abort();
      }
      return route.continue();
    });

    const response = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    // Give any late client-side rendering (e.g. a final React effect) a brief moment to settle.
    await page.waitForTimeout(RENDER_WAIT_AFTER_LOAD_MS);

    const html = await page.content();
    const finalUrl = response?.url() || page.url() || url;
    return { html, finalUrl };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Heuristic: does this static HTML look like an unrendered SPA shell rather
 * than real content? Used to decide whether to fall back to a headless-
 * browser render automatically in "auto" mode.
 *
 * Signals (any one is enough):
 *   - Very little visible text relative to the page's markup/scripts
 *   - A near-empty known SPA mount point (#root, #app, #__next, etc.)
 *   - A `<noscript>` block that explicitly says JS is required
 */
export function looksLikeUnrenderedSpa(html: string, visibleText: string): boolean {
  const trimmedText = visibleText.trim();

  if (/<noscript>[\s\S]*?(enable|requires?)[\s\S]*?javascript[\s\S]*?<\/noscript>/i.test(html)) {
    return true;
  }

  const mountPointRe =
    /<div[^>]*\bid=["'](root|app|__next|___gatsby|svelte|ember-app)["'][^>]*>([\s\S]*?)<\/div>/i;
  const mountMatch = html.match(mountPointRe);
  if (mountMatch) {
    const innerText = mountMatch[2]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (innerText.length < 40) return true;
  }

  // Generic fallback: a page that's mostly <script> tags with barely any
  // visible text is very likely client-rendered and came back empty.
  const scriptBytes = (html.match(/<script[\s\S]*?<\/script>/gi) ?? []).reduce((sum, s) => sum + s.length, 0);
  if (html.length > 2000 && scriptBytes > html.length * 0.5 && trimmedText.length < 200) {
    return true;
  }

  return false;
}
