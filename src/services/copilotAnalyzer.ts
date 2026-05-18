import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import OpenAI from "openai";
import type { Screenshot, TranscriptSegment, RecordingAnalysis } from "../types/index";
import type { ExtractedFrame } from "./screenshotExtractor";

async function getCopilotToken(githubToken: string): Promise<string | null> {
  // Try current endpoints for Copilot token exchange
  const endpoints = [
    "https://api.github.com/copilot_internal/v2/token",
    "https://api.github.com/copilot_internal/token",
  ];
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `token ${githubToken}`, Accept: "application/json" },
      });
      if (resp.ok) {
        const data = await resp.json() as { token: string };
        if (data.token) return data.token;
      }
    } catch { /* try next */ }
  }
  return null;
}

function getGhAuthToken(): string | null {
  // Use the gh CLI OAuth token — works if `gh auth login` has been run
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    const token = execSync("gh auth token", { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    if (token && token.length > 10) return token;
  } catch { /* gh not available or not logged in */ }
  return null;
}

async function getCopilotClient(): Promise<{ client: OpenAI; visionModel: string; textModel: string }> {
  const pat = process.env["GITHUB_TOKEN"];
  if (!pat) throw new Error("GITHUB_TOKEN env var required");

  const customModel = process.env["COPILOT_MODEL"];

  // Strategy 1: use COPILOT_API_URL override if set
  const overrideUrl = process.env["COPILOT_API_URL"];
  if (overrideUrl) {
    const model = customModel ?? "gpt-4o";
    return { client: new OpenAI({ baseURL: overrideUrl, apiKey: pat }), visionModel: model, textModel: model };
  }

  // Strategy 2: exchange PAT for Copilot token → use api.githubcopilot.com
  const copilotToken = await getCopilotToken(pat);
  if (copilotToken) {
    const model = customModel ?? "gpt-4o";
    console.error(`Using api.githubcopilot.com (Copilot token exchange), model: ${model}`);
    return { client: new OpenAI({ baseURL: "https://api.githubcopilot.com", apiKey: copilotToken }), visionModel: model, textModel: model };
  }
  console.error("Copilot token exchange failed — trying gh auth token...");

  // Strategy 3: gh auth token → exchange for Copilot token
  const ghToken = getGhAuthToken();
  if (ghToken && ghToken !== pat) {
    const copilotToken2 = await getCopilotToken(ghToken);
    if (copilotToken2) {
      const model = customModel ?? "gpt-4o";
      console.error(`Using api.githubcopilot.com (gh auth token exchange), model: ${model}`);
      return { client: new OpenAI({ baseURL: "https://api.githubcopilot.com", apiKey: copilotToken2 }), visionModel: model, textModel: model };
    }
    const model = customModel ?? "gpt-4o";
    console.error(`Using api.githubcopilot.com (gh auth token direct), model: ${model}`);
    return { client: new OpenAI({ baseURL: "https://api.githubcopilot.com", apiKey: ghToken }), visionModel: model, textModel: model };
  }

  // Strategy 4: GitHub Models (needs 'models' PAT permission or classic PAT)
  // OpenAI-compat SDK uses plain model names (no openai/ prefix)
  const model = customModel ?? "gpt-4o";
  console.error(`Using models.inference.ai.azure.com (fallback), model: ${model}`);
  return { client: new OpenAI({ baseURL: "https://models.inference.ai.azure.com", apiKey: pat }), visionModel: model, textModel: model };
}

// Step 1: Score each screenshot for relevance using Copilot Vision
export async function scoreScreenshots(frames: ExtractedFrame[]): Promise<Screenshot[]> {
  const { client, visionModel } = await getCopilotClient();
  const scored: Screenshot[] = [];

  for (const frame of frames) {
    if (!fs.existsSync(frame.filePath)) continue;

    const base64 = fs.readFileSync(frame.filePath).toString("base64");
    const ext = path.extname(frame.filePath).slice(1) || "png";

    try {
      const response = await client.chat.completions.create({
        model: visionModel,
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

  // Filter low-relevance, deduplicate visually similar screens, cap at 20
  const filtered = scored.filter((s) => s.relevanceScore >= 0.3);
  return deduplicateScreenshots(filtered).slice(0, 20);
}

// Remove screenshots that show the same UI state.
// Uses Jaccard similarity on description words + tag overlap + time proximity.
// Keeps the highest-scored representative per unique screen.
function deduplicateScreenshots(screenshots: Screenshot[]): Screenshot[] {
  // Sort best-first so we keep the highest-scored version of each unique screen
  const sorted = [...screenshots].sort((a, b) => b.relevanceScore - a.relevanceScore);
  const kept: Screenshot[] = [];

  for (const candidate of sorted) {
    const isDuplicate = kept.some((existing) => isSameScreen(existing, candidate));
    if (!isDuplicate) kept.push(candidate);
  }

  // Restore chronological order for downstream consumers
  return kept.sort((a, b) => a.timestamp - b.timestamp);
}

// Two screenshots are "the same screen" if they are visually/semantically similar
// AND close in time (within 120s) OR strongly similar regardless of time.
function isSameScreen(a: Screenshot, b: Screenshot): boolean {
  const descSimilarity = jaccardWords(a.description, b.description);
  const tagSimilarity = jaccardSet(a.tags, b.tags);
  const timeDiff = Math.abs(a.timestamp - b.timestamp);

  // Very strong description overlap → same screen regardless of time
  if (descSimilarity > 0.65) return true;

  // Moderate description overlap + close in time
  if (descSimilarity > 0.35 && timeDiff < 120) return true;

  // Same tag signature (same type of UI) + close in time → same screen
  // e.g. both tagged ["ui", "form", "configuration"] appearing within 2 minutes
  if (tagSimilarity > 0.6 && timeDiff < 120) return true;

  return false;
}

function jaccardWords(a: string, b: string): number {
  const wordsOf = (s: string) =>
    new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : intersection / union;
}

function jaccardSet(a: string[], b: string[]): number {
  const sa = new Set(a.map((s) => s.toLowerCase()));
  const sb = new Set(b.map((s) => s.toLowerCase()));
  const intersection = [...sa].filter((w) => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : intersection / union;
}

// Step 2: Full recording analysis from transcript + filtered screenshots
export async function analyzeRecording(
  transcript: TranscriptSegment[],
  screenshots: Screenshot[],
  title: string
): Promise<RecordingAnalysis["analysis"]> {
  const { client, textModel } = await getCopilotClient();

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

  // Use full transcript — no truncation for typical meeting lengths (up to 15000 chars)
  const transcriptExcerpt = transcriptText.slice(0, 15000);
  const hasTranscript = transcriptExcerpt.trim().length > 0;

  const prompt = `You are analyzing a Teams meeting recording. The content may be in German, English, or mixed — always respond in the SAME language as the meeting content.

Title: ${title}

${hasTranscript ? `Full Transcript:
${transcriptExcerpt}` : "No transcript available — analyze from screenshots only."}

Screenshot descriptions:
${screenshotDescriptions || "No screenshots available."}

Analyze this recording and respond with ONLY a valid JSON object in this exact format:
{
  "summary": "<2-4 sentence overview in the meeting's language>",
  "humanReadableSummary": "<Bullet-point summary in the style of Microsoft Teams auto-summary. Each bullet: '• Topic heading: Description with details. [M:SS]' — include timestamps from the transcript. Write in the same language as the meeting. Aim for 4-8 bullets covering the key discussion points, decisions, and actions.>",
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
      "title": "<what needs to be done — specific and actionable>",
      "assignee": "<name if mentioned, else null>",
      "priority": "low|medium|high",
      "context": "<why this is needed and what it involves>",
      "timestamp": <seconds from start when this was discussed, or 0>
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
    model: textModel,
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
    humanReadableSummary: parsed.humanReadableSummary ?? parsed.summary ?? "",
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


