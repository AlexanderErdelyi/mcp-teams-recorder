import type {
  RecordingAnalysis,
  UserStorySummary,
  BugReportSummary,
  DocumentationSummary,
  FeedbackSummary,
} from "../types/index.js";

// Reshape RecordingAnalysis into a user story draft.
// Returns structured data — caller uses Azure MCP / ADO skill to create the actual work item.
export function summarizeForUserStory(analysis: RecordingAnalysis): UserStorySummary {
  const topFeature = analysis.analysis.features[0];
  const topActionItem = analysis.analysis.actionItems[0];
  const primarySpeaker = analysis.analysis.speakers[0] ?? "the team";

  const title = topFeature?.title
    ?? topActionItem?.title
    ?? `Feature from: ${analysis.title}`;

  const iWant = topFeature?.description ?? analysis.analysis.summary;
  const soThat = topActionItem?.context ?? analysis.analysis.keyPoints[0] ?? "the workflow is improved";

  const acceptanceCriteria: string[] = [
    ...analysis.analysis.features.map((f) => `✓ ${f.title}: ${f.description}`),
    ...analysis.analysis.actionItems
      .filter((a) => a.priority === "high")
      .map((a) => `✓ ${a.title}`),
  ].slice(0, 8);

  const relatedScreenshots = analysis.screenshots
    .filter((s) => s.relevanceScore >= 0.6)
    .map((s) => `[${formatTime(s.timestamp)}] ${s.description} — ${s.filePath}`)
    .slice(0, 5);

  return {
    recordingId: analysis.id,
    title,
    asA: primarySpeaker,
    iWant,
    soThat,
    acceptanceCriteria: acceptanceCriteria.length > 0
      ? acceptanceCriteria
      : [`The functionality described in the recording is implemented`],
    relatedScreenshots,
    priority: analysis.analysis.issues.some((i) => i.severity === "critical" || i.severity === "high")
      ? "high"
      : analysis.analysis.actionItems.some((a) => a.priority === "high")
        ? "medium"
        : "low",
    tags: [...analysis.analysis.topics, "recording", analysis.source],
  };
}

// Reshape into a bug report draft.
export function summarizeForBugReport(analysis: RecordingAnalysis): BugReportSummary {
  const topIssue = analysis.analysis.issues.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity)
  )[0];

  const stepsToReproduce: string[] = topIssue
    ? [
        `1. Watch recording at ${formatTime(topIssue.timestamp)}`,
        `2. Observe: ${topIssue.description}`,
        ...analysis.analysis.actionItems
          .filter((a) => a.priority === "high")
          .map((a, i) => `${i + 3}. ${a.title}`),
      ]
    : [`1. Watch recording: ${analysis.title}`];

  const relatedScreenshots = analysis.screenshots
    .filter((s) => s.tags.includes("error") || s.relevanceScore >= 0.7)
    .map((s) => `[${formatTime(s.timestamp)}] ${s.description} — ${s.filePath}`)
    .slice(0, 5);

  return {
    recordingId: analysis.id,
    title: topIssue?.title ?? `Bug from: ${analysis.title}`,
    severity: topIssue?.severity ?? "medium",
    stepsToReproduce,
    expectedBehavior: analysis.analysis.keyPoints[0] ?? "System should function correctly",
    actualBehavior: topIssue?.description ?? analysis.analysis.summary,
    relatedScreenshots,
    context: `Recording: ${analysis.title} | Duration: ${analysis.duration} | Processed: ${analysis.processedAt}`,
    tags: [...analysis.analysis.topics, "bug", "recording"],
  };
}

// Reshape into a documentation outline.
export function summarizeForDocumentation(analysis: RecordingAnalysis): DocumentationSummary {
  const outline = [
    {
      heading: "Overview",
      content: analysis.analysis.summary,
    },
    {
      heading: "Key Points",
      content: analysis.analysis.keyPoints.map((p) => `- ${p}`).join("\n"),
    },
    ...analysis.analysis.features.map((f) => ({
      heading: f.title,
      content: f.description,
    })),
    ...(analysis.analysis.decisions.length > 0
      ? [{
          heading: "Decisions Made",
          content: analysis.analysis.decisions.map((d) => `**${d.summary}**: ${d.context}`).join("\n\n"),
        }]
      : []),
    ...(analysis.analysis.actionItems.length > 0
      ? [{
          heading: "Next Steps",
          content: analysis.analysis.actionItems
            .map((a) => `- [ ] ${a.title}${a.assignee ? ` *(${a.assignee})*` : ""}`)
            .join("\n"),
        }]
      : []),
  ];

  const relatedScreenshots = analysis.screenshots
    .filter((s) => s.relevanceScore >= 0.5)
    .map((s) => `[${formatTime(s.timestamp)}] ${s.description} — ${s.filePath}`)
    .slice(0, 10);

  return {
    recordingId: analysis.id,
    title: analysis.title,
    outline,
    relatedScreenshots,
  };
}

// Reshape into a test feedback report.
export function summarizeForFeedback(analysis: RecordingAnalysis): FeedbackSummary {
  const positivePoints = analysis.analysis.keyPoints.filter((_, i) => i % 2 === 0).slice(0, 5);
  const issues = analysis.analysis.issues.map((issue) => ({
    recordingId: analysis.id,
    title: issue.title,
    severity: issue.severity,
    stepsToReproduce: [`Observed at ${formatTime(issue.timestamp)}: ${issue.description}`],
    expectedBehavior: "Feature should work as designed",
    actualBehavior: issue.description,
    relatedScreenshots: analysis.screenshots
      .filter((s) => issue.screenshotIds.includes(s.id))
      .map((s) => `[${formatTime(s.timestamp)}] ${s.description} — ${s.filePath}`),
    context: analysis.title,
    tags: [...analysis.analysis.topics, "feedback"],
  }));

  const relatedScreenshots = analysis.screenshots
    .filter((s) => s.tags.includes("error") || s.relevanceScore >= 0.6)
    .map((s) => `[${formatTime(s.timestamp)}] ${s.description} — ${s.filePath}`)
    .slice(0, 8);

  return {
    recordingId: analysis.id,
    title: `Test Feedback: ${analysis.title}`,
    overallSentiment: analysis.analysis.sentiment,
    positivePoints,
    negativePoints: analysis.analysis.issues.map((i) => i.description).slice(0, 5),
    suggestions: analysis.analysis.actionItems.map((a) => a.title).slice(0, 5),
    issues,
    relatedScreenshots,
  };
}

// --- Helpers ---

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function severityRank(s: string): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s] ?? 0;
}
