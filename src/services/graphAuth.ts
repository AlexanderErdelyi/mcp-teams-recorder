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

// Azure CLI public client ID — pre-consented in every tenant, no app registration needed
const AZ_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

// ── Strategy 1: Azure CLI (az login) ─────────────────────────────────────────
// Same approach as Azure MCP. Works if user has run `az login`.
function tryAzureCliToken(): string | null {
  try {
    const output = execSync(
      'az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv',
      { stdio: ["pipe", "pipe", "pipe"] }
    ).toString().trim();
    if (output && output.length > 20) {
      console.error("✅ Using Azure CLI token (az login session)");
      return output;
    }
  } catch {
    // az not installed or not logged in
  }
  return null;
}

// ── Strategy 2: MSAL with Azure CLI client ID (browser popup, no app reg needed)
async function tryMsalInteractive(tenantId: string): Promise<string | null> {
  try {
    const app = buildMsalApp(tenantId, AZ_CLI_CLIENT_ID);

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

    if (!result) return null;
    console.error("✅ Microsoft sign-in successful");
    return result.accessToken;
  } catch {
    return null;
  }
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
  // 1. Azure CLI (no config needed — just `az login`)
  const cliToken = tryAzureCliToken();
  if (cliToken) return cliToken;

  // 2. MSAL with Azure CLI public client ID (no app registration needed)
  //    Only needs tenantId (or "common" for multi-tenant)
  const effectiveTenant = tenantId ?? "common";
  const interactiveToken = await tryMsalInteractive(effectiveTenant);
  if (interactiveToken) return interactiveToken;

  // 3. Custom app registration (if AZURE_CLIENT_ID is set)
  if (clientId) {
    const customToken = await tryMsalCustomApp(effectiveTenant, clientId);
    if (customToken) return customToken;
  }

  throw new Error(
    "Could not obtain a Microsoft Graph token. Try one of:\n" +
    "  1. Run 'az login' in your terminal (easiest — no config needed)\n" +
    "  2. Set AZURE_TENANT_ID in .env and sign in when prompted\n" +
    "  3. Set AZURE_TENANT_ID + AZURE_CLIENT_ID in .env (requires app registration)"
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


