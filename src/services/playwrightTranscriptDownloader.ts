/**
 * Playwright-based Teams transcript downloader
 *
 * Strategy:
 *   1. Extract Firefox cookies from its SQLite DB (works even while Firefox is open)
 *   2. Launch a headless system browser (Edge/Chrome) via playwright-core
 *   3. Inject cookies so the browser is authenticated against SharePoint
 *   4. Call SharePoint REST API to LIST the Recordings folder → find the VTT
 *   5. Download it via authenticated fetch inside the browser context
 *
 * Why Playwright instead of plain HTTPS?
 *   SharePoint sometimes requires browser-like request context (handles CSRF challenges,
 *   302 redirects with cookie updates, etc.). Running inside a real browser avoids all that.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import { parseRecordingUrl } from "./graphAuth";

// ── Firefox cookie extraction ────────────────────────────────────────────────

interface MozCookie {
  name: string;
  value: string;
  host: string;
  path: string;
  isSecure: number;
  isHttpOnly: number;
  expiry: number;
}

function findFirefoxProfilePath(): string | null {
  const profilesDir = path.join(
    os.homedir(),
    "AppData",
    "Roaming",
    "Mozilla",
    "Firefox",
    "Profiles"
  );
  if (!fs.existsSync(profilesDir)) return null;

  const profiles = fs.readdirSync(profilesDir);
  const chosen =
    profiles.find((p) => p.endsWith(".default-release")) ||
    profiles.find((p) => p.endsWith(".default")) ||
    profiles[0];

  return chosen ? path.join(profilesDir, chosen) : null;
}

function extractFirefoxCookies(hostname: string): MozCookie[] {
  const profilePath = findFirefoxProfilePath();
  if (!profilePath) {
    console.error("[playwright] No Firefox profile found");
    return [];
  }

  const cookiesDb = path.join(profilePath, "cookies.sqlite");
  if (!fs.existsSync(cookiesDb)) {
    console.error("[playwright] Firefox cookies.sqlite not found at", cookiesDb);
    return [];
  }

  // Make copies of the SQLite DB + WAL/SHM files (Firefox keeps it open with WAL mode)
  const tmpDb = path.join(os.tmpdir(), `mcp-ff-cookies-${Date.now()}.sqlite`);
  const tmpWal = tmpDb + "-wal";
  const tmpShm = tmpDb + "-shm";
  try {
    fs.copyFileSync(cookiesDb, tmpDb);
    if (fs.existsSync(cookiesDb + "-wal")) fs.copyFileSync(cookiesDb + "-wal", tmpWal);
    if (fs.existsSync(cookiesDb + "-shm")) fs.copyFileSync(cookiesDb + "-shm", tmpShm);

    const db = new Database(tmpDb, { readonly: true, fileMustExist: true });
    // Match both exact hostname and leading-dot variant (.sharepoint.com)
    const rows = db
      .prepare(
        `SELECT name, value, host, path, isSecure, isHttpOnly, expiry
         FROM moz_cookies
         WHERE host = ? OR host = ? OR host LIKE ?`
      )
      .all(hostname, `.${hostname}`, `%.${hostname}`) as MozCookie[];
    db.close();

    console.error(`[playwright] Extracted ${rows.length} Firefox cookies for ${hostname}`);
    return rows;
  } catch (err) {
    console.error("[playwright] Error reading Firefox cookies:", err);
    return [];
  } finally {
    try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpWal); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpShm); } catch { /* ignore */ }
  }
}

// ── System browser detection (playwright-core needs an executablePath) ───────

function findSystemBrowserPath(): string | null {
  const candidates = [
    // Edge (always present on Win10+)
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    // Chrome
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    // Chromium (choco install chromium)
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Main download function ────────────────────────────────────────────────────

interface SharePointFile {
  Name: string;
  ServerRelativeUrl: string;
}

/**
 * Try to download the VTT transcript for a Teams recording using Playwright +
 * Firefox cookie injection.  Returns the local path if successful, null otherwise.
 */
export async function downloadTranscriptViaPlaywright(
  recordingUrl: string,
  destDir: string
): Promise<string | null> {
  const info = parseRecordingUrl(recordingUrl);
  if (!info.hostname || !info.filePath) {
    console.error("[playwright] Could not parse recording URL");
    return null;
  }

  // Step 1: Extract Firefox cookies for this SharePoint hostname
  const mozCookies = extractFirefoxCookies(info.hostname);
  if (mozCookies.length === 0) {
    console.error("[playwright] No cookies found — cannot authenticate via browser cookies");
    return null;
  }

  // Step 2: Find a system Chromium-based browser
  const executablePath = findSystemBrowserPath();
  if (!executablePath) {
    console.error("[playwright] No system Chromium/Edge/Chrome found");
    return null;
  }
  console.error(`[playwright] Using browser: ${executablePath}`);

  // Lazy-require playwright-core to avoid startup cost when not needed
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core") as typeof import("playwright-core"));
  } catch (err) {
    console.error("[playwright] playwright-core not available:", err);
    return null;
  }

  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext();

    // Step 3: Inject Firefox cookies into the Playwright browser context
    const playwrightCookies = mozCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.host.startsWith(".") ? c.host.slice(1) : c.host,
      path: c.path || "/",
      secure: c.isSecure === 1,
      httpOnly: c.isHttpOnly === 1,
      expires: c.expiry || -1,
      sameSite: "None" as const,
    }));
    await context.addCookies(playwrightCookies);

    const page = await context.newPage();

    // Step 4: List the SharePoint folder via REST API (called from inside the browser)
    const folderPath = info.filePath.substring(0, info.filePath.lastIndexOf("/"));
    const restUrl =
      `https://${info.hostname}/_api/web/` +
      `GetFolderByServerRelativeUrl('${encodeURIComponent(folderPath)}')/Files` +
      `?$select=Name,ServerRelativeUrl&$orderby=Name`;

    console.error(`[playwright] Listing folder: ${folderPath}`);

    // Navigate to a SharePoint page first to establish the session context
    await page.goto(`https://${info.hostname}/_layouts/15/nativehr.aspx`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    }).catch(() => { /* ignore — just warming up cookies */ });

    const listResult = await page.evaluate(async (url: string) => {
      try {
        const resp = await fetch(url, {
          headers: { Accept: "application/json;odata=verbose" },
          credentials: "include",
        });
        if (!resp.ok) return { ok: false, status: resp.status, files: [] };
        const data = await resp.json() as Record<string, unknown>;
        const d = data?.d as Record<string, unknown> | undefined;
        const results = (d?.results ?? []) as { Name: string; ServerRelativeUrl: string }[];
        return { ok: true, status: resp.status, files: results };
      } catch (e) {
        return { ok: false, status: 0, files: [], error: String(e) };
      }
    }, restUrl);

    console.error(
      `[playwright] Folder list result: HTTP ${listResult.status}, ${listResult.files.length} files`
    );

    if (!listResult.ok) {
      console.error(`[playwright] Folder listing failed (HTTP ${listResult.status})`);
      // Still log what files came back if any
      return null;
    }

    const allFiles: SharePointFile[] = listResult.files;
    console.error(`[playwright] Files in folder: ${allFiles.map((f) => f.Name).join(", ")}`);

    // Step 5: Find the matching VTT file
    const baseName = path.basename(info.filePath, path.extname(info.filePath));
    const vttFiles = allFiles.filter((f) => f.Name.toLowerCase().endsWith(".vtt"));

    if (vttFiles.length === 0) {
      console.error("[playwright] No .vtt files found in folder");
      return null;
    }

    // Prefer exact name match; fall back to partial match; then any VTT
    const exactMatch = vttFiles.find(
      (f) => f.Name.replace(/\.vtt$/i, "") === baseName
    );
    const partialMatch = vttFiles.find(
      (f) => f.Name.includes(baseName) || baseName.includes(f.Name.replace(/\.vtt$/i, ""))
    );
    const targetFile = exactMatch ?? partialMatch ?? vttFiles[0];

    console.error(`[playwright] Using VTT file: ${targetFile.Name}`);

    // Step 6: Download the VTT content via authenticated fetch in browser context
    const vttUrl = `https://${info.hostname}${targetFile.ServerRelativeUrl}`;
    const vttContent = await page.evaluate(async (url: string) => {
      try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) return { ok: false, status: resp.status, text: "" };
        const text = await resp.text();
        return { ok: true, status: resp.status, text };
      } catch (e) {
        return { ok: false, status: 0, text: "", error: String(e) };
      }
    }, vttUrl);

    if (!vttContent.ok || !vttContent.text.includes("WEBVTT")) {
      console.error(
        `[playwright] VTT download failed (HTTP ${vttContent.status}) or content is not VTT`
      );
      return null;
    }

    const destPath = path.join(destDir, targetFile.Name);
    fs.writeFileSync(destPath, vttContent.text, "utf-8");
    console.error(`[playwright] ✅ Transcript downloaded: ${targetFile.Name}`);
    return destPath;

  } finally {
    await browser.close();
  }
}
