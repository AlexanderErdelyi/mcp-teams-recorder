import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PublicClientApplication, type AuthenticationResult } from "@azure/msal-node";

const TOKEN_CACHE_PATH = path.join(os.homedir(), ".mcp-teams-recorder-token.json");

const SCOPES = [
  "Files.Read.All",
  "Sites.Read.All",
  "User.Read",
];

function buildMsalApp(tenantId: string, clientId: string): PublicClientApplication {
  const tokenCache = fs.existsSync(TOKEN_CACHE_PATH)
    ? fs.readFileSync(TOKEN_CACHE_PATH, "utf-8")
    : undefined;

  const app = new PublicClientApplication({
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

  return app;
}

export async function getGraphToken(tenantId: string, clientId: string): Promise<string> {
  const app = buildMsalApp(tenantId, clientId);

  // Try silent first (cached token)
  const accounts = await app.getTokenCache().getAllAccounts();
  if (accounts.length > 0 && accounts[0]) {
    try {
      const result: AuthenticationResult = await app.acquireTokenSilent({
        account: accounts[0],
        scopes: SCOPES,
      });
      return result.accessToken;
    } catch {
      // Fall through to interactive
    }
  }

  // Device code flow — prints instructions to stdout
  const result = await app.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.error("\n=== Microsoft Sign-In Required ===");
      console.error(response.message);
      console.error("==================================\n");
    },
  });

  if (!result) throw new Error("Authentication failed — no token returned");
  return result.accessToken;
}

// Extract SharePoint item info from a Teams recording share URL
export function parseSharePointUrl(url: string): { siteUrl: string; itemPath: string } | null {
  try {
    const parsed = new URL(url);
    // e.g. https://company.sharepoint.com/sites/team/Shared%20Documents/...
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

// Download a file from SharePoint/OneDrive using Graph API
export async function downloadSharePointFile(
  accessToken: string,
  driveItemUrl: string,
  destPath: string
): Promise<void> {
  // Use Graph API with sharing link
  // Encode the sharing URL as a base64url token
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

// List files in a SharePoint folder to find video + transcript
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
