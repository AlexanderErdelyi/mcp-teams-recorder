/**
 * Azure DevOps attachment uploader.
 * Uploads local screenshot files to ADO as work item attachments,
 * returning URLs of the form:
 *   https://dev.azure.com/{org}/{project}/_apis/wit/attachments/{guid}
 *
 * Required env vars (same ones used by the Azure DevOps MCP):
 *   ADO_ORG       – e.g. "mycompany"   (or full URL in ADO_ORG_URL)
 *   ADO_PAT       – Personal Access Token with "Work Items (Read & Write)" scope
 *   ADO_PROJECT   – default project name (can be overridden per call)
 */

import * as fs from "fs";
import * as path from "path";
import type { Screenshot } from "../types/index";

export interface UploadedScreenshot {
  screenshotId: string;
  timestamp: number;
  description: string;
  fileName: string;
  attachmentUrl: string;     // ADO REST URL — use in work item HTML as <img src="...">
  adoMarkdown: string;       // ![]({url}) — for wiki pages
  adoHtml: string;           // <img src="..." ...> — for work item descriptions
}

export interface AdoUploadOptions {
  /** ADO org name (e.g. "mycompany") or full URL */
  orgOrUrl?: string;
  /** ADO project name */
  project?: string;
  /** ADO Personal Access Token */
  pat?: string;
  /** Max number of screenshots to upload (default: all) */
  maxScreenshots?: number;
}

function getAdoConfig(opts: AdoUploadOptions) {
  const pat = opts.pat ?? process.env["ADO_PAT"] ?? process.env["AZURE_DEVOPS_TOKEN"];
  if (!pat) throw new Error("ADO_PAT (or AZURE_DEVOPS_TOKEN) env var required for screenshot upload");

  const orgRaw = opts.orgOrUrl ?? process.env["ADO_ORG_URL"] ?? process.env["ADO_ORG"];
  if (!orgRaw) throw new Error("ADO_ORG (or ADO_ORG_URL) env var required for screenshot upload");

  // Normalise to base URL
  const baseUrl = orgRaw.startsWith("http")
    ? orgRaw.replace(/\/$/, "")
    : `https://dev.azure.com/${orgRaw}`;

  const project = opts.project ?? process.env["ADO_PROJECT"];
  if (!project) throw new Error("ADO_PROJECT env var required for screenshot upload");

  return { baseUrl, project, pat };
}

/** Upload a single file to ADO attachments API. Returns the attachment URL. */
async function uploadFile(
  baseUrl: string,
  project: string,
  pat: string,
  filePath: string,
  fileName: string
): Promise<string> {
  const fileContent = fs.readFileSync(filePath);
  const base64Auth = Buffer.from(`:${pat}`).toString("base64");

  const url = `${baseUrl}/${encodeURIComponent(project)}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=7.1`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64Auth}`,
      "Content-Type": "application/octet-stream",
    },
    body: fileContent,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ADO attachment upload failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json() as { url: string };
  return data.url;
}

/**
 * Upload screenshots from a RecordingAnalysis to Azure DevOps.
 * Returns enriched screenshot objects with ADO attachment URLs.
 */
export async function uploadScreenshotsToAdo(
  screenshots: Screenshot[],
  recordingTitle: string,
  opts: AdoUploadOptions = {}
): Promise<UploadedScreenshot[]> {
  const { baseUrl, project, pat } = getAdoConfig(opts);

  const toUpload = screenshots.slice(0, opts.maxScreenshots ?? screenshots.length);
  const results: UploadedScreenshot[] = [];
  const safeTitle = recordingTitle.replace(/[^a-z0-9_\-]/gi, "_").slice(0, 40);

  for (const ss of toUpload) {
    if (!fs.existsSync(ss.filePath)) {
      console.error(`Screenshot not found, skipping: ${ss.filePath}`);
      continue;
    }

    const ts = Math.round(ss.timestamp);
    const fileName = `${safeTitle}_t${ts}_${ss.id}.png`;

    try {
      const attachmentUrl = await uploadFile(baseUrl, project, pat, ss.filePath, fileName);

      results.push({
        screenshotId: ss.id,
        timestamp: ss.timestamp,
        description: ss.description,
        fileName,
        attachmentUrl,
        adoMarkdown: `![${ss.description}](${attachmentUrl})`,
        adoHtml: `<img src="${attachmentUrl}" alt="${ss.description.replace(/"/g, "&quot;")}" style="max-width:800px;" />`,
      });

      console.error(`Uploaded: ${fileName} → ${attachmentUrl}`);
    } catch (err) {
      console.error(`Failed to upload ${fileName}: ${(err as Error).message}`);
      // Continue with remaining screenshots
    }
  }

  return results;
}

/** Build an HTML attachment reference string suitable for ADO work item description HTML. */
export function buildAdoAttachmentHtml(uploads: UploadedScreenshot[]): string {
  if (uploads.length === 0) return "";
  const imgs = uploads
    .map((u) => `<p><strong>${u.description}</strong><br/>${u.adoHtml}</p>`)
    .join("\n");
  return `<h3>Screenshots</h3>\n${imgs}`;
}
