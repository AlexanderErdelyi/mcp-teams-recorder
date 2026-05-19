/**
 * Teams transcript downloader using Firefox cookie extraction
 *
 * Strategy:
 *   1. Extract Firefox cookies from its SQLite DB (works even while Firefox is open)
 *   2. Use Node.js HTTPS (same as yt-dlp) to call SharePoint REST API
 *   3. LIST the Recordings folder to find the actual VTT filename
 *   4. Download the VTT with authenticated request
 *
 * Playwright is used as a fallback if HTTPS requests fail (e.g. for CSRF-protected
 * endpoints) — the headless Edge/Chrome browser with injected cookies is then used.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import * as http from "http";
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
    // Extract parent domain: cosmo365-my.sharepoint.com → sharepoint.com
    const parts = hostname.split(".");
    const parentDomain = parts.slice(-2).join(".");

    // Match specific host, its dot-prefixed variant, and the parent domain (e.g. .sharepoint.com)
    const rows = db
      .prepare(
        `SELECT name, value, host, path, isSecure, isHttpOnly, expiry
         FROM moz_cookies
         WHERE host = ? OR host = ?
            OR host = ? OR host = ?
            OR host LIKE ?`
      )
      .all(
        hostname, `.${hostname}`,
        parentDomain, `.${parentDomain}`,
        `%.${parentDomain}`
      ) as MozCookie[];
    db.close();

    console.error(`[cookies] Extracted ${rows.length} Firefox cookies for ${hostname}`);
    return rows;
  } catch (err) {
    console.error("[cookies] Error reading Firefox cookies:", err);
    return [];
  } finally {
    try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpWal); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpShm); } catch { /* ignore */ }
  }
}

// ── Node.js HTTPS helper (same approach as yt-dlp — just send cookies in header) ──

function httpsGet(
  url: string,
  headers: Record<string, string>,
  maxRedirects = 5
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const follow = (location: string, remaining: number) => {
      if (remaining <= 0) { reject(new Error("Too many redirects")); return; }
      const parsed = new URL(location);
      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.get(
        {
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: parsed.pathname + parsed.search,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            ...headers,
          },
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            // Follow redirect, but keep cookies
            follow(
              res.headers.location.startsWith("http")
                ? res.headers.location
                : `${parsed.protocol}//${parsed.host}${res.headers.location}`,
              remaining - 1
            );
            return;
          }
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on("error", reject);
    };
    follow(url, maxRedirects);
  });
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
    console.error("[cookies] Could not parse recording URL");
    return null;
  }

  // Step 1: Extract Firefox cookies
  const mozCookies = extractFirefoxCookies(info.hostname);
  if (mozCookies.length === 0) {
    console.error("[cookies] No Firefox cookies found for SharePoint — is Firefox logged in?");
    return null;
  }

  // Build a flat Cookie header (same as yt-dlp)
  const cookieHeader = mozCookies.map((c) => `${c.name}=${c.value}`).join("; ");

  // Step 2: Build SharePoint REST URL
  // _api/web must be scoped to the personal OneDrive site, not the tenant root
  const folderPath = info.filePath.substring(0, info.filePath.lastIndexOf("/"));
  const personalSiteMatch = info.filePath.match(/^(\/personal\/[^/]+)/);
  const sitePath = personalSiteMatch ? personalSiteMatch[1] : "";

  const restUrl =
    `https://${info.hostname}${sitePath}/_api/web/` +
    `GetFolderByServerRelativeUrl('${folderPath}')/Files` +
    `?$select=Name,ServerRelativeUrl&$orderby=Name`;

  console.error(`[cookies] Calling SharePoint REST: ${restUrl}`);

  // Step 3: Try plain HTTPS first (same approach as yt-dlp — cookies in header)
  const listResult = await httpsGet(restUrl, {
    Cookie: cookieHeader,
    Accept: "application/json;odata=verbose",
    "X-Requested-With": "XMLHttpRequest",
  }).catch((err) => {
    console.error(`[cookies] HTTPS request failed: ${err.message}`);
    return null;
  });

  let allFiles: SharePointFile[] = [];

  if (listResult && listResult.status === 200) {
    try {
      const data = JSON.parse(listResult.body) as Record<string, unknown>;
      const d = data?.d as Record<string, unknown> | undefined;
      allFiles = (d?.results ?? []) as SharePointFile[];
      console.error(`[cookies] HTTPS success — files: ${allFiles.map((f) => f.Name).join(", ")}`);
    } catch {
      console.error("[cookies] Could not parse REST response as JSON");
    }
  } else {
    console.error(`[cookies] HTTPS returned HTTP ${listResult?.status} — trying Playwright fallback…`);
    // Step 3b: Playwright fallback — headless Edge/Chrome with injected cookies
    allFiles = await listFolderViaPlaywright(info.hostname, restUrl, mozCookies) ?? [];
  }

  if (allFiles.length === 0) {
    console.error("[cookies] Could not list Recordings folder via any method");
    return null;
  }

  // Step 4: Find the matching VTT file
  const baseName = path.basename(info.filePath, path.extname(info.filePath));
  const vttFiles = allFiles.filter((f) => f.Name.toLowerCase().endsWith(".vtt"));

  if (vttFiles.length === 0) {
    console.error("[cookies] No .vtt files in folder. All files:", allFiles.map((f) => f.Name).join(", "));
    return null;
  }

  const exactMatch = vttFiles.find((f) => f.Name.replace(/\.vtt$/i, "") === baseName);
  const partialMatch = vttFiles.find(
    (f) => f.Name.includes(baseName) || baseName.includes(f.Name.replace(/\.vtt$/i, ""))
  );
  const targetFile = exactMatch ?? partialMatch ?? vttFiles[0];
  console.error(`[cookies] Using VTT file: ${targetFile.Name}`);

  // Step 5: Download the VTT
  const vttUrl = `https://${info.hostname}${targetFile.ServerRelativeUrl}`;
  const vttResult = await httpsGet(vttUrl, { Cookie: cookieHeader }).catch(() => null);

  if (!vttResult || vttResult.status !== 200 || !vttResult.body.includes("WEBVTT")) {
    console.error("[cookies] VTT download failed or content is not WEBVTT");
    return null;
  }

  const destPath = path.join(destDir, targetFile.Name);
  fs.writeFileSync(destPath, vttResult.body, "utf-8");
  console.error(`[cookies] ✅ Transcript downloaded: ${targetFile.Name}`);
  return destPath;
}

// ── Playwright fallback — used only when HTTPS requests fail ─────────────────

async function listFolderViaPlaywright(
  hostname: string,
  restUrl: string,
  mozCookies: MozCookie[]
): Promise<SharePointFile[] | null> {
  const executablePath = findSystemBrowserPath();
  if (!executablePath) {
    console.error("[playwright] No system Edge/Chrome found");
    return null;
  }
  console.error(`[playwright] Using browser: ${executablePath}`);

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

    const playwrightCookies = mozCookies
      .filter((c) => c.name && c.value)
      .map((c) => {
        const expiresRaw = Number(c.expiry);
        // Firefox stores expiry in milliseconds; Playwright needs seconds
        const expiresSeconds = (Number.isFinite(expiresRaw) && expiresRaw > 0)
          ? Math.floor(expiresRaw / 1000)
          : -1;
        return {
          name: c.name,
          value: c.value,
          domain: c.host.startsWith(".") ? c.host.slice(1) : c.host,
          path: c.path || "/",
          secure: c.isSecure === 1,
          httpOnly: c.isHttpOnly === 1,
          expires: expiresSeconds,
          sameSite: (c.isSecure === 1 ? "None" : "Lax") as "None" | "Lax",
        };
      });
    await context.addCookies(playwrightCookies);

    const apiResp = await context.request.get(restUrl, {
      headers: {
        Accept: "application/json;odata=verbose",
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    console.error(`[playwright] REST response: HTTP ${apiResp.status()}`);
    if (!apiResp.ok()) {
      const body = await apiResp.text().catch(() => "");
      console.error(`[playwright] REST error: ${body.substring(0, 200)}`);
      return null;
    }

    const data = await apiResp.json() as Record<string, unknown>;
    const d = data?.d as Record<string, unknown> | undefined;
    return (d?.results ?? []) as SharePointFile[];
  } finally {
    await browser.close();
  }
}
