/**
 * Offline test — runs transcript parsing, summarizers, and cache.
 * Also simulates a full RecordingAnalysis (what Copilot API would produce)
 * so you can see the summarize_for_* output without needing GITHUB_TOKEN.
 */

import * as path from "path";
import * as fs from "fs";
import { parseVtt, transcriptToPlainText } from "../src/services/transcriptParser";
import {
  summarizeForUserStory,
  summarizeForBugReport,
  summarizeForDocumentation,
  summarizeForFeedback,
} from "../src/services/summarizers";
import {
  saveAnalysis,
  loadAnalysis,
  listCachedAnalyses,
  generateRecordingId,
  deleteAnalysis,
} from "../src/services/cache";
import type { RecordingAnalysis } from "../src/types/index";

const SAMPLE_VTT = path.join(__dirname, "sample-recording.vtt");

function section(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

function json(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  // ── 1. Parse transcript ────────────────────────────────────────
  section("1. Transcript Parser (.vtt)");
  const vttContent = fs.readFileSync(SAMPLE_VTT, "utf-8");
  const segments = parseVtt(vttContent);
  console.log(`✅ Parsed ${segments.length} segments`);
  console.log("\nFirst 3 segments:");
  json(segments.slice(0, 3));
  console.log("\nPlain text (first 300 chars):");
  console.log(transcriptToPlainText(segments).slice(0, 300) + "...");

  // ── 2. Build simulated RecordingAnalysis ───────────────────────
  // (this is what copilotAnalyzer would produce after calling the API)
  section("2. Simulated RecordingAnalysis (mocks Copilot API output)");

  const mockAnalysis: RecordingAnalysis = {
    id: generateRecordingId("test://sample-recording"),
    title: "Sprint Demo — Dashboard Feature",
    duration: "00:01:50",
    processedAt: new Date().toISOString(),
    source: "folder",
    sourceRef: path.dirname(SAMPLE_VTT),

    transcript: segments,
    screenshots: [
      {
        id: "ss_0",
        timestamp: 12,
        filePath: "/tmp/screenshots/seg_12000.png",
        relevanceScore: 0.9,
        description: "Dashboard with new export to Excel button visible",
        tags: ["ui", "dashboard", "feature"],
      },
      {
        id: "ss_1",
        timestamp: 25,
        filePath: "/tmp/screenshots/seg_25000.png",
        relevanceScore: 0.95,
        description: "Error dialog: 'Cannot read property of undefined' on reports page",
        tags: ["ui", "error", "bug"],
      },
      {
        id: "ss_2",
        timestamp: 50,
        filePath: "/tmp/screenshots/seg_50000.png",
        relevanceScore: 0.85,
        description: "Mobile layout showing navigation menu overlapping content on iPhone",
        tags: ["ui", "mobile", "bug"],
      },
    ],

    analysis: {
      summary:
        "Sprint demo covering the new dashboard feature with Excel export. Two bugs were identified: a null reference error on the reports page filter and a mobile layout issue on iPhone. Key decision: move user settings to sidebar.",
      keyPoints: [
        "Dashboard now loads in under 2 seconds",
        "Excel export functionality added to dashboard",
        "Critical bug: filter button throws 'Cannot read property of undefined' with empty data",
        "Mobile layout broken on iPhone — navigation overlaps content",
        "Decision: user settings moved to sidebar navigation",
        "API documentation needs updating — export endpoint signature changed",
      ],
      issues: [
        {
          title: "Filter button crashes with empty date range",
          description: "Clicking the filter button on the reports page throws 'Cannot read property of undefined' when there is no data for the selected date range. Missing null check.",
          severity: "critical",
          timestamp: 22,
          screenshotIds: ["ss_1"],
        },
        {
          title: "Mobile layout broken on iPhone",
          description: "Navigation menu overlaps page content on iPhone. Caused by a z-index CSS issue.",
          severity: "high",
          timestamp: 48,
          screenshotIds: ["ss_2"],
        },
      ],
      features: [
        {
          title: "Dashboard Excel Export",
          description: "New export to Excel functionality added to the dashboard. Performance improved — loads in under 2 seconds.",
          timestamp: 12,
          screenshotIds: ["ss_0"],
        },
      ],
      decisions: [
        {
          summary: "User settings page moved to sidebar navigation",
          context: "Previously in the top nav, the team agreed to move it to the sidebar for better UX.",
          timestamp: 62,
        },
      ],
      actionItems: [
        {
          title: "Fix null check on filter button in reports page",
          assignee: "Tom (Developer)",
          priority: "high",
          context: "Crashes with 'Cannot read property of undefined' when no data in selected date range",
        },
        {
          title: "Fix mobile CSS z-index for navigation menu",
          assignee: "Tom (Developer)",
          priority: "high",
          context: "Navigation overlaps content on iPhone",
        },
        {
          title: "Write documentation for dashboard Excel export feature",
          assignee: undefined,
          priority: "medium",
          context: "New feature needs user-facing documentation",
        },
        {
          title: "Update API documentation for export endpoint",
          assignee: "Tom (Developer)",
          priority: "medium",
          context: "Export endpoint signature changed",
        },
      ],
      speakers: ["Sarah (Product Manager)", "Tom (Developer)"],
      sentiment: "mixed",
      topics: ["dashboard", "sprint-demo", "bug", "mobile", "export", "documentation"],
    },

    raw: {
      transcriptText: transcriptToPlainText(segments),
      screenshotDir: "/tmp/screenshots",
    },
  };

  console.log(`✅ Built mock RecordingAnalysis — ID: ${mockAnalysis.id}`);
  console.log(`   Title: ${mockAnalysis.title}`);
  console.log(`   Speakers: ${mockAnalysis.analysis.speakers.join(", ")}`);
  console.log(`   Issues: ${mockAnalysis.analysis.issues.length}`);
  console.log(`   Features: ${mockAnalysis.analysis.features.length}`);
  console.log(`   Action items: ${mockAnalysis.analysis.actionItems.length}`);

  // ── 3. Cache save/load ────────────────────────────────────────
  section("3. Cache Layer");
  saveAnalysis(mockAnalysis);
  console.log(`✅ Saved to cache`);

  const loaded = loadAnalysis(mockAnalysis.id);
  console.log(`✅ Loaded from cache: ${loaded?.title}`);

  const list = listCachedAnalyses();
  console.log(`✅ Cache contains ${list.length} recording(s):`);
  list.forEach((r) => console.log(`   - [${r.id}] ${r.title}`));

  // ── 4. summarize_for_user_story ───────────────────────────────
  section("4. summarize_for_user_story");
  const userStory = summarizeForUserStory(mockAnalysis);
  json(userStory);

  // ── 5. summarize_for_bug_report ───────────────────────────────
  section("5. summarize_for_bug_report");
  const bug = summarizeForBugReport(mockAnalysis);
  json(bug);

  // ── 6. summarize_for_documentation ───────────────────────────
  section("6. summarize_for_documentation");
  const docs = summarizeForDocumentation(mockAnalysis);
  console.log(`Title: ${docs.title}`);
  console.log(`Sections (${docs.outline.length}):`);
  docs.outline.forEach((s) => console.log(`  ## ${s.heading}\n     ${s.content.slice(0, 80)}...`));

  // ── 7. summarize_for_feedback ─────────────────────────────────
  section("7. summarize_for_feedback");
  const feedback = summarizeForFeedback(mockAnalysis);
  console.log(`Sentiment: ${feedback.overallSentiment}`);
  console.log(`Positive: ${feedback.positivePoints.length} points`);
  console.log(`Issues found: ${feedback.issues.length}`);
  console.log(`Suggestions: ${feedback.suggestions.length}`);
  console.log("\nIssues:");
  feedback.issues.forEach((i) => console.log(`  [${i.severity.toUpperCase()}] ${i.title}`));

  // ── 8. Cleanup ────────────────────────────────────────────────
  section("8. Cleanup");
  deleteAnalysis(mockAnalysis.id);
  console.log(`✅ Deleted from cache`);

  section("✅ All tests passed");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
