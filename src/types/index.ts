// Central data contract for mcp-teams-recorder.
// All downstream agents, skills, and tools consume RecordingAnalysis.

export interface TranscriptSegment {
  start: number;   // seconds from start
  end: number;     // seconds from start
  speaker: string;
  text: string;
}

export interface Screenshot {
  id: string;
  timestamp: number;        // seconds from start
  filePath: string;         // absolute local path to PNG
  base64?: string;          // optional inline data for API calls
  relevanceScore: number;   // 0-1, assigned by Copilot Vision
  description: string;      // Copilot-generated caption
  tags: string[];           // e.g. ["ui", "error", "diagram", "code"]
}

export interface Issue {
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  timestamp: number;
  screenshotIds: string[];
}

export interface Feature {
  title: string;
  description: string;
  timestamp: number;
  screenshotIds: string[];
}

export interface Decision {
  summary: string;
  context: string;
  timestamp: number;
}

export interface ActionItem {
  title: string;
  assignee?: string | null;
  priority: "low" | "medium" | "high";
  context: string;
  timestamp?: number;
}

export interface RecordingAnalysis {
  id: string;
  title: string;
  duration: string;         // "HH:MM:SS"
  processedAt: string;      // ISO timestamp
  source: "url" | "folder";
  sourceRef: string;        // original URL or folder path

  transcript: TranscriptSegment[];
  screenshots: Screenshot[];

  analysis: {
    summary: string;
    humanReadableSummary: string;  // timestamped bullet points, language-native, like Teams auto-summary
    keyPoints: string[];
    issues: Issue[];
    features: Feature[];
    decisions: Decision[];
    actionItems: ActionItem[];
    speakers: string[];
    sentiment: "positive" | "neutral" | "mixed" | "negative";
    topics: string[];
  };

  raw: {
    transcriptText: string;
    screenshotDir: string;
  };
}

// Shaped summaries for downstream tools — no side effects
export interface UserStorySummary {
  recordingId: string;
  title: string;
  asA: string;
  iWant: string;
  soThat: string;
  acceptanceCriteria: string[];
  relatedScreenshots: string[];
  priority: "low" | "medium" | "high";
  tags: string[];
}

export interface BugReportSummary {
  recordingId: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  stepsToReproduce: string[];
  expectedBehavior: string;
  actualBehavior: string;
  relatedScreenshots: string[];
  context: string;
  tags: string[];
}

export interface DocumentationSummary {
  recordingId: string;
  title: string;
  outline: Array<{ heading: string; content: string }>;
  relatedScreenshots: string[];
}

export interface FeedbackSummary {
  recordingId: string;
  title: string;
  overallSentiment: string;
  positivePoints: string[];
  negativePoints: string[];
  suggestions: string[];
  issues: BugReportSummary[];
  relatedScreenshots: string[];
}


