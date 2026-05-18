/**
 * Live test — uses az login + real SharePoint URL + GITHUB_TOKEN
 * Run: npx ts-node test/test-live.ts
 */

import "dotenv/config";
import { parseRecordingUrl } from "../src/services/graphAuth";
import { getGraphToken, resolveRecordingFiles } from "../src/services/graphAuth";
import { processRecordingUrl } from "../src/services/pipeline";

const URL = process.argv[2] ?? "";

if (!URL) {
  console.error("Usage: npx ts-node test/test-live.ts <recording-url>");
  process.exit(1);
}

async function main() {
  console.log("\n=== Step 1: Parse URL ===");
  const parsed = parseRecordingUrl(URL);
  console.log(JSON.stringify(parsed, null, 2));

  console.log("\n=== Step 2: Get Graph token (az login) ===");
  const token = await getGraphToken();
  console.log("✅ Token obtained (first 20 chars):", token.slice(0, 20) + "...");

  console.log("\n=== Step 3: Resolve files in folder (Graph API) ===");
  try {
    const files = await resolveRecordingFiles(token, URL);
    console.log(`Found ${files.length} files:`);
    files.forEach(f => console.log(`  - ${f.name} (${f.mimeType})`));
  } catch (err) {
    console.log(`⚠️  Graph/REST resolution failed: ${(err as Error).message}`);
    console.log("   (yt-dlp browser-cookie fallback will be used in Step 4)");
  }

  console.log("\n=== Step 4: Full pipeline (download + screenshots + AI analysis) ===");
  console.log("⚠️  This will download the video and run Copilot Vision — may take several minutes...\n");
  const analysis = await processRecordingUrl(URL);

  console.log("\n✅ Analysis complete!");
  console.log(`ID: ${analysis.id}`);
  console.log(`Title: ${analysis.title}`);
  console.log(`Duration: ${analysis.duration}`);
  console.log(`Speakers: ${analysis.analysis.speakers.join(", ")}`);
  console.log(`Screenshots kept: ${analysis.screenshots.length}`);
  console.log(`\nSummary:\n${analysis.analysis.summary}`);
  console.log(`\nKey points:`);
  analysis.analysis.keyPoints.forEach(p => console.log(`  - ${p}`));
  console.log(`\nIssues found: ${analysis.analysis.issues.length}`);
  analysis.analysis.issues.forEach(i => console.log(`  [${i.severity.toUpperCase()}] ${i.title}`));
  console.log(`\nAction items: ${analysis.analysis.actionItems.length}`);
  analysis.analysis.actionItems.forEach(a => console.log(`  [${a.priority}] ${a.title}${a.assignee ? ` → ${a.assignee}` : ""}`));
}

main().catch(err => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
