import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import OpenAI from "openai";
import type { Screenshot, TranscriptSegment, RecordingAnalysis } from "../types/index";
import type { ExtractedFrame } from "./screenshotExtractor";

function getCopilotClient(): OpenAI {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN env var required for GitHub Copilot API");

  return new OpenAI({
    baseURL: "https://api.githubcopilot.com",
    apiKey: token,
  });
}

const MODEL_VISION = "gpt-4o";
const MODEL_TEXT = "gpt-4o";

// Step 1: Score each screenshot for relevance using Copilot Vision
export async function scoreScreenshots(frames: ExtractedFrame[]): Promise<Screenshot[]> {
  const client = getCopilotClient();
  const scored: Screenshot[] = [];

  for (const frame of frames) {
    if (!fs.existsSync(frame.filePath)) continue;

    const base64 = fs.readFileSync(frame.filePath).toString("base64");
    const ext = path.extname(frame.filePath).slice(1) || "png";

    try {
      const response = await client.chat.completions.create({
        model: MODEL_VISION,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/${ext};base64,${base64}`, detail: "low" },
              },
              {
                type: "text",
                text: `Analyze this screenshot from a screen recording. Respond with JSON only:
{
  "relevanceScore": <0.0-1.0, where 1.0 = highly informative UI/content, 0.0 = blank/static/no useful info>,
  "description": "<one sentence describing what is shown>",
  "tags": ["<tag1>", "<tag2>"] // e.g. ui, error, diagram, code, dashboard, form, chat, presentation, blank
}

Be strict: blank screens, loading spinners, or static desktop should score below 0.2.`,
              },
            ],
          },
        ],
        max_tokens: 200,
      });

      const content = response.choices[0]?.message.content ?? "{}";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      scored.push({
        id: `ss_${Math.round(frame.timestamp * 1000)}`,
        timestamp: frame.timestamp,
        filePath: frame.filePath,
        base64,
        relevanceScore: parsed.relevanceScore ?? 0.5,
        description: parsed.description ?? "Screenshot",
        tags: parsed.tags ?? [],
      });
    } catch (err) {
      // If vision fails for a frame, include it with neutral score
      scored.push({
        id: `ss_${Math.round(frame.timestamp * 1000)}`,
        timestamp: frame.timestamp,
        filePath: frame.filePath,
        relevanceScore: 0.5,
        description: "Screenshot (analysis unavailable)",
        tags: [],
      });
    }
  }

  // Return only screenshots with relevance >= 0.3, capped at 20
  return scored
    .filter((s) => s.relevanceScore >= 0.3)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 20);
}

// Step 2: Full recording analysis from transcript + filtered screenshots
export async function analyzeRecording(
  transcript: TranscriptSegment[],
  screenshots: Screenshot[],
  title: string
): Promise<RecordingAnalysis["analysis"]> {
  const client = getCopilotClient();

  const transcriptText = transcript
    .map((s) => `[${formatTime(s.start)}] ${s.speaker}: ${s.text}`)
    .join("\n");

  // Build vision content with top 5 screenshots
  const topScreenshots = screenshots.slice(0, 5);
  const imageContent: OpenAI.Chat.ChatCompletionContentPart[] = topScreenshots.map((ss) => ({
    type: "image_url" as const,
    image_url: {
      url: `data:image/png;base64,${ss.base64 ?? ""}`,
      detail: "low" as const,
    },
  }));

  const screenshotDescriptions = screenshots
    .map((s) => `[${formatTime(s.timestamp)}] ${s.description} (tags: ${s.tags.join(", ")})`)
    .join("\n");

  const prompt = `You are analyzing a Teams meeting recording. 

Title: ${title}

Transcript (excerpt — full text provided):
${transcriptText.slice(0, 6000)}

Screenshot descriptions:
${screenshotDescriptions}

Analyze this recording and respond with ONLY a JSON object in this exact format:
{
  "summary": "<2-4 sentence overview of the meeting>",
  "keyPoints": ["<point 1>", "<point 2>", ...],
  "issues": [
    {
      "title": "<short title>",
      "description": "<what the issue is>",
      "severity": "low|medium|high|critical",
      "timestamp": <seconds>,
      "screenshotIds": []
    }
  ],
  "features": [
    {
      "title": "<feature name>",
      "description": "<what was shown/discussed>",
      "timestamp": <seconds>,
      "screenshotIds": []
    }
  ],
  "decisions": [
    {
      "summary": "<decision made>",
      "context": "<why/how>",
      "timestamp": <seconds>
    }
  ],
  "actionItems": [
    {
      "title": "<what needs to be done>",
      "assignee": "<name if mentioned>",
      "priority": "low|medium|high",
      "context": "<why this is needed>"
    }
  ],
  "speakers": ["<name1>", "<name2>"],
  "sentiment": "positive|neutral|mixed|negative",
  "topics": ["<topic1>", "<topic2>"]
}`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "user",
      content: imageContent.length > 0
        ? [...imageContent, { type: "text" as const, text: prompt }]
        : prompt,
    },
  ];

  const response = await client.chat.completions.create({
    model: MODEL_TEXT,
    messages,
    max_tokens: 2000,
  });

  const content = response.choices[0]?.message.content ?? "{}";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

  // Attach screenshot IDs to issues/features that reference them
  const issuesWithScreenshots = (parsed.issues ?? []).map((issue: RecordingAnalysis["analysis"]["issues"][0]) => ({
    ...issue,
    screenshotIds: screenshots
      .filter((s) => Math.abs(s.timestamp - (issue.timestamp ?? 0)) < 30)
      .map((s) => s.id),
  }));

  const featuresWithScreenshots = (parsed.features ?? []).map((f: RecordingAnalysis["analysis"]["features"][0]) => ({
    ...f,
    screenshotIds: screenshots
      .filter((s) => Math.abs(s.timestamp - (f.timestamp ?? 0)) < 30)
      .map((s) => s.id),
  }));

  return {
    summary: parsed.summary ?? "",
    keyPoints: parsed.keyPoints ?? [],
    issues: issuesWithScreenshots,
    features: featuresWithScreenshots,
    decisions: parsed.decisions ?? [],
    actionItems: parsed.actionItems ?? [],
    speakers: parsed.speakers ?? [],
    sentiment: parsed.sentiment ?? "neutral",
    topics: parsed.topics ?? [],
  };
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}


