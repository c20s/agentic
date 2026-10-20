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
 *
 * SECURITY MODEL
 * ---------------
 * This renders arbitrary, untrusted, possibly-adversarial URLs (including
 * ones that may have been suggested by web_search results or injected via
 * content the model read elsewhere). Treat every page as hostile:
 *   - the browser is launched with its sandbox ENABLED (no --no-sandbox),
 *     script/extension-loading disabled, and no persistent profile;
 *   - every navigation, redirect, and sub-resource request made BY THE PAGE
 *     ITSELF is re-validated against the same SSRF blocklist used for the
 *     initial fetch — not just the final URL after the top-level
 *     navigation. Without this, a page could `fetch()`/redirect/iframe to
 *     loopback or cloud-metadata addresses from inside the renderer;
 *   - popups/new tabs/new windows are blocked (`window.open` etc.) so a page
 *     can't spawn additional, unmanaged browser contexts;
 *   - downloads, JS dialogs (alert/confirm/prompt/beforeunload), and
 *     permission prompts (geolocation, notifications, clipboard, camera...)
 *     are all auto-dismissed/denied rather than left to hang or default-allow;
 *   - each render gets a brand-new, throwaway BrowserContext (no cookies,
 *     storage, or cache shared across calls or with any other site);
 *   - rendered HTML is size-capped while reading it out, so an adversarial
 *     infinite/huge DOM can't exhaust memory;
 *   - a hard wall-clock budget bounds the whole render (nav + settle time),
 *     independent of Playwright's own per-call timeouts.
 */

import { isBlockedUrl } from "./net-guard";

const RENDER_TIMEOUT_MS = 20_000;
const RENDER_WAIT_AFTER_LOAD_MS = 500;
// Hard ceiling on how much rendered HTML we'll ever pull out of the page,
// independent of web_fetch's own downstream truncation — this bounds memory
// use even before the text reaches web.ts's MAX_RETURNED_CHARS trim.
const MAX_RENDERED_HTML_BYTES = 5_000_000;
// Upper bound on concurrent renders, so repeated web_fetch({render:"always"})
// calls can't spin up unbounded Chromium pages / exhaust CPU & memory.
const MAX_CONCURRENT_RENDERS = 2;

let browserPromise: Promise<import("playwright-core").Browser> | null = null;
let activeRenders = 0;

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
        return await playwright.chromium.launch({
          headless: true,
          // Explicit, minimal, locked-down launch flags. Notably we do NOT pass
          // --no-sandbox: keep Chromium's own OS-level sandbox enabled. If you
          // must run as root in a container where Chromium refuses to start
          // without --no-sandbox, prefer fixing the container's user/namespace
          // setup over disabling the sandbox.
          args: [
            "--disable-extensions",
            "--disable-component-extensions-with-background-pages",
            "--disable-background-networking",
            "--disable-default-apps",
            "--disable-gpu",
            "--disable-notifications",
            "--no-first-run",
            "--mute-audio",
            // V8 flag: disables the WebAssembly global/API surface entirely for pages rendered
            // here. We don't need WASM for text extraction, and it's a common vector for both
            // sandbox-escape exploits (WASM JIT bugs) and browser/device fingerprinting, so the
            // safest default is to remove the API rather than trust every page not to use it.
            // See https://v8.dev/docs/flags (a V8 flag, not Chromium-specific).
            "--js-flags=--noexpose_wasm",
          ],
          // Never persist a profile/cache to disk across launches.
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
        });
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
 *
 * Every request the page itself makes (navigation, redirect, fetch/XHR,
 * iframe, etc.) is re-validated against the SSRF blocklist, not just the
 * top-level URL passed in here — see the module doc comment above.
 */
export async function renderPage(url: string, timeoutMs: number = RENDER_TIMEOUT_MS): Promise<RenderResult> {
  if (isBlockedUrl(url)) {
    throw new Error(`Refusing to render "${url}": loopback/private/link-local addresses are blocked.`);
  }

  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    throw new Error(
      `Too many concurrent renders in flight (limit ${MAX_CONCURRENT_RENDERS}). Try again shortly.`
    );
  }
  activeRenders++;

  const browser = await getBrowser();
  // A fresh, throwaway, fully-isolated context per render: no cookies, no
  // localStorage/IndexedDB, no cache, and no permissions carried over
  // between calls or shared with any other site.
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/120.0.0.0 Safari/537.36 local-mcp-server/0.1",
    javaScriptEnabled: true, // required for SPA rendering, but everything else below is locked down
    acceptDownloads: false,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
    serviceWorkers: "block",
    permissions: [], // deny all permission prompts (geolocation, notifications, camera, clipboard, etc.)
  });

  // Hard wall-clock budget for the whole render, independent of any single
  // Playwright call's own timeout (belt-and-suspenders against slow-loris-
  // style pages that trickle just enough activity to keep resetting
  // per-call timeouts).
  let timedOut = false;
  const hardDeadline = setTimeout(() => {
    timedOut = true;
    context.close().catch(() => {});
  }, timeoutMs + RENDER_WAIT_AFTER_LOAD_MS + 5_000);

  try {
    // Any extra page spawned in this context (popups, window.open, target="_blank",
    // etc.) is closed immediately — a hostile page shouldn't be able to spawn
    // additional, unmanaged pages that keep running after renderPage() returns.
    context.on("page", (extraPage) => {
      extraPage.close().catch(() => {});
    });

    const page = await context.newPage();

    // Auto-dismiss any JS dialog (alert/confirm/prompt/beforeunload) instead of
    // letting it block navigation until the timeout fires.
    page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));

    // Deny downloads outright.
    page.on("download", (download) => download.cancel().catch(() => {}));

    // Re-validate EVERY request the page makes (main frame nav, redirects,
    // fetch/XHR, iframes, websockets, etc.) against the SSRF blocklist, and
    // block heavy/irrelevant resource types to keep rendering fast and light.
    await page.route("**/*", (route) => {
      const request = route.request();
      const resourceType = request.resourceType();

      if (resourceType === "image" || resourceType === "font" || resourceType === "media") {
        return route.abort();
      }

      if (isBlockedUrl(request.url())) {
        return route.abort("blockedbyclient");
      }

      return route.continue();
    });

    const response = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });

    // Re-validate the final top-level URL after any redirects the page/server issued.
    const navigatedUrl = response?.url() || page.url();
    if (isBlockedUrl(navigatedUrl)) {
      throw new Error(`Refusing to render "${navigatedUrl}": navigation redirected to a blocked address.`);
    }

    // Give any late client-side rendering (e.g. a final React effect) a brief moment to settle.
    await page.waitForTimeout(RENDER_WAIT_AFTER_LOAD_MS);

    if (timedOut) {
      throw new Error(`Render of "${url}" exceeded the hard timeout budget and was aborted.`);
    }

    const html = await page.content();
    const bounded = html.length > MAX_RENDERED_HTML_BYTES ? html.slice(0, MAX_RENDERED_HTML_BYTES) : html;
    const finalUrl = navigatedUrl || url;
    return { html: bounded, finalUrl };
  } finally {
    clearTimeout(hardDeadline);
    await context.close().catch(() => {});
    activeRenders--;
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
