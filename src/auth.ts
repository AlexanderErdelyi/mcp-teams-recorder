/**
 * Standalone auth helper — run with: npm run auth
 *
 * Triggers MSAL device code flow to get a Graph token with Files.Read.All / Sites.Read.All.
 * The token is cached to ~/.mcp-teams-recorder-token.json and reused silently by the MCP server.
 *
 * Run this once after initial setup, or whenever you see a "download failed" or "access denied" error.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PublicClientApplication } from "@azure/msal-node";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const TOKEN_CACHE_PATH = path.join(os.homedir(), ".mcp-teams-recorder-token.json");

// Well-known public client IDs that work for delegated SharePoint/Graph access
// These are pre-authorized for Files.Read.All via interactive consent
const PUBLIC_CLIENT_IDS = [
  { id: "1950a258-227b-4e31-a9cf-717495945fc2", name: "Azure PowerShell" },   // well-known, broad consent
  { id: "d3590ed6-52b3-4102-aeff-aad2292ab01c", name: "Microsoft Office" },   // broad consent
];

const SCOPES = [
  "https://graph.microsoft.com/Files.Read.All",
  "https://graph.microsoft.com/Sites.Read.All",
  "https://graph.microsoft.com/User.Read",
];

async function runDeviceCodeAuth(tenantId: string, clientId: string, clientName: string): Promise<string | null> {
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
        beforeCacheAccess: async (ctx) => {
          if (tokenCache) ctx.tokenCache.deserialize(tokenCache);
        },
        afterCacheAccess: async (ctx) => {
          if (ctx.cacheHasChanged) {
            fs.writeFileSync(TOKEN_CACHE_PATH, ctx.tokenCache.serialize(), "utf-8");
            console.log(`✅ Token cached to ${TOKEN_CACHE_PATH}`);
          }
        },
      },
    },
  });

  // Try silent first (from cache)
  try {
    const accounts = await app.getTokenCache().getAllAccounts();
    if (accounts.length > 0 && accounts[0]) {
      const result = await app.acquireTokenSilent({ account: accounts[0], scopes: SCOPES });
      if (result?.accessToken) {
        console.log(`✅ Token refreshed silently (${clientName})`);
        return result.accessToken;
      }
    }
  } catch { /* fall through to device code */ }

  // Interactive device code
  try {
    const result = await app.acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (response) => {
        console.log("\n" + "=".repeat(60));
        console.log(" Microsoft Sign-In Required");
        console.log("=".repeat(60));
        console.log(response.message);
        console.log("=".repeat(60) + "\n");
      },
    });
    return result?.accessToken ?? null;
  } catch (err) {
    console.error(`  ↳ ${clientName} failed: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}

async function main() {
  console.log("mcp-teams-recorder — SharePoint Auth Setup");
  console.log("=".repeat(60));

  const tenantId = process.env["AZURE_TENANT_ID"] ?? "common";
  console.log(`Tenant: ${tenantId === "common" ? "common (auto-detect from login)" : tenantId}`);
  console.log(`Scopes: ${SCOPES.join(", ")}\n`);

  for (const { id, name } of PUBLIC_CLIENT_IDS) {
    console.log(`Trying client: ${name} (${id})`);
    const token = await runDeviceCodeAuth(tenantId, id, name);
    if (token) {
      console.log("\n✅ Authentication successful!");
      console.log(`Token cached — the MCP server will use it silently from now on.`);
      console.log(`\nYou can now use process_recording_url in Copilot Chat.\n`);
      process.exit(0);
    }
  }

  console.error("\n❌ All auth strategies failed.");
  console.error("Try setting AZURE_TENANT_ID in your .env file and retry.");
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
