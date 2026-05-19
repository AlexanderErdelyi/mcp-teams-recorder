import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { PublicClientApplication, type AuthenticationResult } from "@azure/msal-node";

const TOKEN_CACHE_PATH = path.join(os.homedir(), ".mcp-teams-recorder-token.json");

const SCOPES = [
  "Files.Read.All",
  "Sites.Read.All",
  "User.Read",
];

// Public client IDs for delegated Graph/SharePoint access (interactive consent)
// Note: Azure CLI ID (04b07795) cannot request Files.Read.All due to AADSTS65002
const AZ_CLI_CLIENT_ID = "1950a258-227b-4e31-a9cf-717495945fc2"; // Azure PowerShell — pre-authorized for Files/Sites
const AZ_CLI_CLIENT_ID_FALLBACK = "d3590ed6-52b3-4102-aeff-aad2292ab01c"; // Microsoft Office (fallback)

// ── Strategy 1: Azure CLI (az login) ─────────────────────────────────────────
function tryAzureCliToken(resource = "https://graph.microsoft.com"): string | null {
  const attempts = [
    `az account get-access-token --scope "${resource}/Files.Read.All ${resource}/Sites.Read.All ${resource}/User.Read" --query accessToken -o tsv`,
    `az account get-access-token --resource ${resource} --query accessToken -o tsv`,
  ];
  for (const cmd of attempts) {
    try {
      const output = execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
      if (output && output.length > 20) {
        console.error("✅ Using Azure CLI token (az login session)");
        return output;
      }
    } catch { /* try next */ }
  }
  return null;
}

// Get a SharePoint-host-scoped token (works even when Graph permissions are restricted)
export function getSharePointToken(hostname: string): string | null {
  return tryAzureCliToken(`https://${hostname}`);
}

// ── Strategy 2: MSAL with well-known public client IDs (browser popup, no app reg needed)
async function tryMsalInteractive(tenantId: string): Promise<string | null> {
  for (const clientId of [AZ_CLI_CLIENT_ID, AZ_CLI_CLIENT_ID_FALLBACK]) {
    try {
      const app = buildMsalApp(tenantId, clientId);

      // Try silent cache first
      const accounts = await app.getTokenCache().getAllAccounts();
      if (accounts.length > 0 && accounts[0]) {
        try {
          const result: AuthenticationResult = await app.acquireTokenSilent({
            account: accounts[0],
            scopes: SCOPES,
          });
          console.error("✅ Using cached MSAL token");
          return result.accessToken;
        } catch { /* fall through */ }
      }

      // Device code flow — user visits a URL and enters a code
      const result = await app.acquireTokenByDeviceCode({
        scopes: SCOPES,
        deviceCodeCallback: (response) => {
          console.error("\n=== Microsoft Sign-In Required ===");
          console.error(response.message);
          console.error("(Same account you use for Teams/SharePoint)");
          console.error("==================================\n");
        },
      });

      if (!result) continue;
      console.error("✅ Microsoft sign-in successful");
      return result.accessToken;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Strategy 3: Custom app registration (optional, if admin provided one) ────
async function tryMsalCustomApp(tenantId: string, clientId: string): Promise<string | null> {
  try {
    const app = buildMsalApp(tenantId, clientId);
    const accounts = await app.getTokenCache().getAllAccounts();
    if (accounts.length > 0 && accounts[0]) {
      const result: AuthenticationResult = await app.acquireTokenSilent({
        account: accounts[0],
        scopes: SCOPES,
      });
      return result.accessToken;
    }
    const result = await app.acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (response) => {
        console.error("\n=== Microsoft Sign-In Required ===");
        console.error(response.message);
        console.error("==================================\n");
      },
    });
    if (!result) return null;
    return result.accessToken;
  } catch {
    return null;
  }
}

// ── Main: try all strategies in order ────────────────────────────────────────
export async function getGraphToken(tenantId?: string, clientId?: string): Promise<string> {
  const effectiveTenant = tenantId ?? "common";

  // 1. MSAL with cached token (silent) — fastest if previously authenticated with npm run auth
  //    Also triggers device code if no cache. Uses proper Files.Read.All scope.
  const interactiveToken = await tryMsalInteractive(effectiveTenant);
  if (interactiveToken) return interactiveToken;

  // 2. Custom app registration (if AZURE_CLIENT_ID is set)
  if (clientId) {
    const customToken = await tryMsalCustomApp(effectiveTenant, clientId);
    if (customToken) return customToken;
  }

  // 3. Azure CLI last resort — token may lack Files.Read.All but try anyway
  const cliToken = tryAzureCliToken();
  if (cliToken) return cliToken;

  throw new Error(
    "Could not obtain a Microsoft Graph token.\n\n" +
    "➡  Run this command to authenticate:\n" +
    "     cd C:\\VSCodeProjects\\GitHub\\mcp-teams-recorder && npm run auth\n\n" +
    "   This opens a browser sign-in (device code) and caches the token.\n" +
    "   After that, process_recording_url will work without further login prompts."
  );
}

function buildMsalApp(tenantId: string, clientId: string): PublicClientApplication {
  const tokenCache = fs.existsSync(TOKEN_CACHE_PATH)
    ? fs.readFileSync(TOKEN_CACHE_PATH, "utf-8")
    : undefined;

  return new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    cache: {
      cachePlugin: {
        beforeCacheAccess: async (context) => {
          if (tokenCache) context.tokenCache.deserialize(tokenCache);
        },
        afterCacheAccess: async (context) => {
          if (context.cacheHasChanged) {
            fs.writeFileSync(TOKEN_CACHE_PATH, context.tokenCache.serialize(), "utf-8");
          }
        },
      },
    },
  });
}


// ── URL type detection ────────────────────────────────────────────────────────

export type UrlType = "stream" | "sharepoint_folder" | "sharepoint_file" | "unknown";

export interface ParsedRecordingUrl {
  type: UrlType;
  filePath?: string;       // OneDrive relative path (for stream/personal URLs)
  folderPath?: string;     // OneDrive relative folder path
  hostname: string;
}

// Detect and parse any Teams recording URL type
export function parseRecordingUrl(url: string): ParsedRecordingUrl {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // Stream web app URL: .../_layouts/15/stream.aspx?id=/personal/.../file.mp4
  if (parsed.pathname.includes("/stream.aspx") && parsed.searchParams.has("id")) {
    const filePath = decodeURIComponent(parsed.searchParams.get("id")!);
    const folderPath = filePath.substring(0, filePath.lastIndexOf("/"));
    return { type: "stream", filePath, folderPath, hostname };
  }

  // SharePoint sharing link: /:v:/r/ or /:f:/r/ or /:u:/r/ — path contains file/folder
  // e.g. https://tenant.sharepoint.com/:v:/r/personal/user/Documents/file.mp4?csf=1&e=token
  const sharingMatch = parsed.pathname.match(/^\/:[\w]:\/?r(\/personal\/.+)$/);
  if (sharingMatch && sharingMatch[1]) {
    const fullPath = decodeURIComponent(sharingMatch[1]);
    const isFile = /\.\w{2,5}$/.test(fullPath);
    const folderPath = isFile ? fullPath.substring(0, fullPath.lastIndexOf("/")) : fullPath;
    return {
      type: isFile ? "sharepoint_file" : "sharepoint_folder",
      filePath: isFile ? fullPath : undefined,
      folderPath,
      hostname,
    };
  }

  // OneDrive personal site direct path: /personal/user/Documents/...
  if (parsed.pathname.includes("/personal/")) {
    const filePath = decodeURIComponent(parsed.pathname);
    const folderPath = filePath.substring(0, filePath.lastIndexOf("/"));
    const isFile = /\.\w{2,5}$/.test(filePath);
    return {
      type: isFile ? "sharepoint_file" : "sharepoint_folder",
      filePath: isFile ? filePath : undefined,
      folderPath: isFile ? folderPath : filePath,
      hostname,
    };
  }

  return { type: "unknown", hostname };
}

// ── Graph API: OneDrive personal (/me/drive) ─────────────────────────────────

interface DriveItem {
  name: string;
  "@microsoft.graph.downloadUrl"?: string;
  file?: { mimeType: string };
  folder?: object;
}

// Get file metadata + download URL by OneDrive path
async function getDriveItemByPath(
  accessToken: string,
  itemPath: string  // e.g. "/Documents/Recordings/file.mp4"
): Promise<DriveItem> {
  // Strip leading /personal/username prefix — Graph /me/drive uses path relative to drive root
  const relativePath = itemPath.replace(/^\/personal\/[^/]+/, "");
  const encoded = encodeURIComponent(relativePath);

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/drive/root:${relativePath}?$select=name,file,folder,@microsoft.graph.downloadUrl`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Graph item lookup failed (${response.status}): ${err}`);
  }

  return response.json() as Promise<DriveItem>;
}

// List children of a folder by OneDrive path
async function listDriveFolder(
  accessToken: string,
  folderPath: string
): Promise<DriveItem[]> {
  const relativePath = folderPath.replace(/^\/personal\/[^/]+/, "");

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/drive/root:${relativePath}:/children?$select=name,file,folder,@microsoft.graph.downloadUrl`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Graph folder listing failed (${response.status}): ${err}`);
  }

  const data = await response.json() as { value: DriveItem[] };
  return data.value ?? [];
}

// ── Public API used by pipeline ───────────────────────────────────────────────

// Resolve any Teams recording URL to a list of { name, downloadUrl, mimeType }
export async function resolveRecordingFiles(
  accessToken: string,
  url: string
): Promise<Array<{ name: string; downloadUrl: string; mimeType: string }>> {
  const info = parseRecordingUrl(url);
  const parsed = new URL(url);

  // Stream URL or sharing link with file path: list folder via /me/drive
  if ((info.type === "stream" || info.type === "sharepoint_file") && info.folderPath) {
    console.error(`Resolved as OneDrive file. Listing folder: ${info.folderPath}`);
    try {
      const items = await listDriveFolder(accessToken, info.folderPath);
      const results = items
        .filter((i) => i.file && i["@microsoft.graph.downloadUrl"])
        .map((i) => ({
          name: i.name,
          downloadUrl: i["@microsoft.graph.downloadUrl"]!,
          mimeType: i.file?.mimeType ?? "",
        }));
      if (results.length > 0) return results;
    } catch (err) {
      console.error(`/me/drive approach failed: ${(err as Error).message}`);
    }

    // Fallback: use embedded sharing token from URL (e.g. ?e=VP9p3P)
    const sharingToken = parsed.searchParams.get("e");
    if (sharingToken) {
      console.error("Falling back to embedded sharing token...");
      try {
        return await resolveViaShareToken(accessToken, url, info);
      } catch (err2) {
        console.error(`Sharing token approach failed: ${(err2 as Error).message}`);
      }
    }

    // Last resort: SharePoint REST API with site-scoped token
    if (info.hostname) {
      console.error("Trying SharePoint REST API (site-scoped token)...");
      try {
        const files = await resolveViaSharePointREST(url, info);
        if (files.length > 0) return files;
      } catch (err3) {
        console.error(`SharePoint REST failed: ${(err3 as Error).message}`);
      }
    }
  }

  // Folder URL
  if (info.type === "sharepoint_folder" && info.folderPath) {
    // Try SharePoint REST first for folders too
    if (info.hostname) {
      try {
        return await resolveViaSharePointREST(url, info);
      } catch { /* fall through */ }
    }
    const items = await listDriveFolder(accessToken, info.folderPath);
    return items
      .filter((i) => i.file && i["@microsoft.graph.downloadUrl"])
      .map((i) => ({
        name: i.name,
        downloadUrl: i["@microsoft.graph.downloadUrl"]!,
        mimeType: i.file?.mimeType ?? "",
      }));
  }

  // Classic sharing-link base64 encoding
  console.error("Trying classic Graph sharing token approach...");
  return listSharePointFolder(accessToken, url);
}

// Resolve via the sharing token in the URL — gets the driveItem and its siblings
async function resolveViaShareToken(
  accessToken: string,
  url: string,
  info: ParsedRecordingUrl
): Promise<Array<{ name: string; downloadUrl: string; mimeType: string }>> {
  // Encode full URL as Graph shares token
  const encoded = Buffer.from(url).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const shareToken = `u!${encoded}`;

  // Get the driveItem metadata to find the parent folder
  const itemResp = await fetch(
    `https://graph.microsoft.com/v1.0/shares/${shareToken}/driveItem?$select=name,parentReference,@microsoft.graph.downloadUrl,file`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!itemResp.ok) {
    throw new Error(`shares driveItem failed: ${itemResp.status} ${await itemResp.text()}`);
  }

  const item = await itemResp.json() as DriveItem & { parentReference?: { driveId: string; id: string } };

  if (item.parentReference?.driveId && item.parentReference?.id) {
    // List siblings in same folder
    const sibResp = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${item.parentReference.driveId}/items/${item.parentReference.id}/children?$select=name,file,@microsoft.graph.downloadUrl`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (sibResp.ok) {
      const data = await sibResp.json() as { value: DriveItem[] };
      return (data.value ?? [])
        .filter((i) => i.file && i["@microsoft.graph.downloadUrl"])
        .map((i) => ({
          name: i.name,
          downloadUrl: i["@microsoft.graph.downloadUrl"]!,
          mimeType: i.file?.mimeType ?? "",
        }));
    }
  }

  // If siblings fail, at minimum return the file itself
  if (item["@microsoft.graph.downloadUrl"]) {
    return [{ name: item.name, downloadUrl: item["@microsoft.graph.downloadUrl"]!, mimeType: "" }];
  }
  throw new Error("Could not resolve files from sharing token");
}

// Download a file directly from its @microsoft.graph.downloadUrl (no auth header needed)
export async function downloadFromUrl(
  downloadUrl: string,
  destPath: string
): Promise<void> {
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
}

// Extract SharePoint item info from a Teams recording share URL
export function parseSharePointUrl(url: string): { siteUrl: string; itemPath: string } | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const pathParts = parsed.pathname.split("/");
    const sitesIdx = pathParts.indexOf("sites");

    if (sitesIdx >= 0 && pathParts[sitesIdx + 1]) {
      const siteName = pathParts[sitesIdx + 1];
      const siteUrl = `https://${hostname}/sites/${siteName}`;
      const itemPath = pathParts.slice(sitesIdx + 2).join("/");
      return { siteUrl, itemPath: decodeURIComponent(itemPath) };
    }
    return null;
  } catch {
    return null;
  }
}

// Download a file from SharePoint/OneDrive using Graph API sharing token
export async function downloadSharePointFile(
  accessToken: string,
  driveItemUrl: string,
  destPath: string
): Promise<void> {
  const encoded = Buffer.from(driveItemUrl).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const shareToken = `u!${encoded}`;

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/shares/${shareToken}/driveItem/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    throw new Error(`Graph download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
}

// List files in a SharePoint folder (sharing link approach)
export async function listSharePointFolder(
  accessToken: string,
  driveItemUrl: string
): Promise<Array<{ name: string; downloadUrl: string; mimeType: string }>> {
  const encoded = Buffer.from(driveItemUrl).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const shareToken = `u!${encoded}`;

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/shares/${shareToken}/driveItem/children`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    throw new Error(`Graph listing failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { value: Array<{ name: string; "@microsoft.graph.downloadUrl": string; file?: { mimeType: string } }> };
  return (data.value ?? []).map((item) => ({
    name: item.name,
    downloadUrl: item["@microsoft.graph.downloadUrl"] ?? "",
    mimeType: item.file?.mimeType ?? "",
  }));
}

// ── SharePoint REST API (bypasses Graph permission issues) ────────────────────
// Uses a site-scoped token (az account get-access-token --resource https://{hostname})
// which works even when Graph Files.Read.All is not consented for the app.

interface SPFile {
  Name: string;
  ServerRelativeUrl: string;
  TimeLastModified: string;
}

export async function resolveViaSharePointREST(
  url: string,
  info: ParsedRecordingUrl
): Promise<Array<{ name: string; downloadUrl: string; mimeType: string }>> {
  if (!info.hostname) throw new Error("No hostname in parsed URL");
  const hostname = info.hostname;

  // Get SharePoint-scoped token
  const spToken = tryAzureCliToken(`https://${hostname}`);
  if (!spToken) throw new Error("Could not get SharePoint-scoped token");

  // Determine the site path (personal OneDrive or team site)
  // For personal: https://tenant-my.sharepoint.com/personal/user
  // We need to find the "web" (site) that contains the file
  let sitePath: string;
  let folderServerRelUrl: string;

  if (info.folderPath?.startsWith("/personal/")) {
    // personal OneDrive: site = /personal/{user}, folder = rest of path
    const parts = info.folderPath.split("/").filter(Boolean); // ["personal","user","Documents","Recordings"]
    sitePath = "/" + parts.slice(0, 2).join("/"); // /personal/user
    folderServerRelUrl = info.folderPath; // /personal/user/Documents/Recordings
  } else if (info.folderPath) {
    sitePath = "/";
    folderServerRelUrl = info.folderPath;
  } else {
    throw new Error("No folder path available");
  }

  const apiBase = `https://${hostname}${sitePath}/_api`;
  const encodedFolder = encodeURIComponent(folderServerRelUrl);

  console.error(`Trying SharePoint REST API: ${apiBase}/web/GetFolderByServerRelativeUrl(...)/Files`);

  const resp = await fetch(
    `${apiBase}/web/GetFolderByServerRelativeUrl('${encodedFolder}')/Files?$select=Name,ServerRelativeUrl,TimeLastModified`,
    {
      headers: {
        Authorization: `Bearer ${spToken}`,
        Accept: "application/json;odata=nometadata",
      },
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`SharePoint REST listing failed: ${resp.status} ${body.substring(0, 200)}`);
  }

  const data = await resp.json() as { value: SPFile[] };
  return (data.value ?? []).map((f) => ({
    name: f.Name,
    // Direct download URL — use SP token for download
    downloadUrl: `https://${hostname}${f.ServerRelativeUrl}`,
    mimeType: f.Name.endsWith(".mp4") ? "video/mp4"
      : f.Name.endsWith(".vtt") ? "text/vtt"
      : f.Name.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "",
    _spToken: spToken, // carry token for download
  } as { name: string; downloadUrl: string; mimeType: string; _spToken?: string }));
}

// Download a file using a SharePoint REST scoped token
export async function downloadWithSharePointToken(
  hostname: string,
  serverRelativeUrl: string,
  destPath: string
): Promise<void> {
  const spToken = tryAzureCliToken(`https://${hostname}`);
  if (!spToken) throw new Error("Could not get SharePoint-scoped token for download");

  const response = await fetch(`https://${hostname}${serverRelativeUrl}`, {
    headers: { Authorization: `Bearer ${spToken}` },
  });

  if (!response.ok) {
    throw new Error(`SharePoint download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
}


