import { z } from "zod";

export const TranscriptSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  speaker: z.string(),
  text: z.string(),
});

export const ScreenshotSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  filePath: z.string(),
  base64: z.string().optional(),
  relevanceScore: z.number().min(0).max(1),
  description: z.string(),
  tags: z.array(z.string()),
});

export const IssueSchema = z.object({
  title: z.string(),
  description: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  timestamp: z.number(),
  screenshotIds: z.array(z.string()),
});

export const FeatureSchema = z.object({
  title: z.string(),
  description: z.string(),
  timestamp: z.number(),
  screenshotIds: z.array(z.string()),
});

export const DecisionSchema = z.object({
  summary: z.string(),
  context: z.string(),
  timestamp: z.number(),
});

export const ActionItemSchema = z.object({
  title: z.string(),
  assignee: z.string().optional().nullable(),
  priority: z.enum(["low", "medium", "high"]),
  context: z.string(),
  timestamp: z.number().optional().default(0),
});

export const RecordingAnalysisSchema = z.object({
  id: z.string(),
  title: z.string(),
  duration: z.string(),
  processedAt: z.string(),
  source: z.enum(["url", "folder"]),
  sourceRef: z.string(),
  transcript: z.array(TranscriptSegmentSchema),
  screenshots: z.array(ScreenshotSchema),
  analysis: z.object({
    summary: z.string(),
    humanReadableSummary: z.string().optional().default(""),
    keyPoints: z.array(z.string()),
    issues: z.array(IssueSchema),
    features: z.array(FeatureSchema),
    decisions: z.array(DecisionSchema),
    actionItems: z.array(ActionItemSchema),
    speakers: z.array(z.string()),
    sentiment: z.enum(["positive", "neutral", "mixed", "negative"]),
    topics: z.array(z.string()),
  }),
  raw: z.object({
    transcriptText: z.string(),
    screenshotDir: z.string(),
  }),
});


