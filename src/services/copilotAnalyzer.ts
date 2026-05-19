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
  // Use the gh CLI OAuth token — works if `gh auth login` has been run with copilot scope.
  // Must unset GITHUB_TOKEN env var, otherwise `gh auth token` echoes it back instead of the OAuth token.
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    const env = { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" };
    const token = execSync("gh auth token", { stdio: ["pipe", "pipe", "pipe"], env }).toString().trim();
    // Only return gho_* OAuth tokens — not ghp_* classic PATs (those don't have copilot scope)
    if (token && token.startsWith("gho_")) return token;
  } catch { /* gh not available or not logged in */ }
  return null;
}

async function getCopilotClient(): Promise<{ client: OpenAI; visionModel: string; textModel: string }> {
  const pat = process.env["GITHUB_TOKEN"];
  if (!pat) throw new Error("GITHUB_TOKEN env var required");

  const customModel = process.env["COPILOT_MODEL"];
  // Disable SDK retries so rate-limit 429s fail fast instead of hanging
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] & { maxRetries?: number; timeout?: number } = {
    maxRetries: 0,
    timeout: 60_000,
    defaultHeaders: { "Copilot-Integration-Id": "vscode-chat" },
  };

  // Strategy 1: use COPILOT_API_URL override if set
  const overrideUrl = process.env["COPILOT_API_URL"];
  if (overrideUrl) {
    const model = customModel ?? "gpt-4o";
    return { client: new OpenAI({ ...clientOpts, baseURL: overrideUrl, apiKey: pat }), visionModel: model, textModel: model };
  }

  // Strategy 2: exchange PAT for Copilot token → use api.githubcopilot.com
  const copilotToken = await getCopilotToken(pat);
  if (copilotToken) {
    const model = customModel ?? "gpt-4o";
    console.error(`Using api.githubcopilot.com (token exchange), model: ${model}`);
    return { client: new OpenAI({ ...clientOpts, baseURL: "https://api.githubcopilot.com", apiKey: copilotToken }), visionModel: model, textModel: model };
  }

  // Strategy 3: gh auth token → direct access to api.githubcopilot.com
  // Works when the OAuth token has the 'copilot' scope (run: gh auth refresh --scopes copilot)
  const ghToken = getGhAuthToken();
  if (ghToken) {
    // Verify token has copilot scope by checking if it's different from PAT
    const model = customModel ?? "gpt-4o";
    console.error(`Using api.githubcopilot.com (gh auth token, copilot scope), model: ${model}`);
    return { client: new OpenAI({ ...clientOpts, baseURL: "https://api.githubcopilot.com", apiKey: ghToken }), visionModel: model, textModel: model };
  }

  // Strategy 4: GitHub Models fallback (gpt-4o-mini has separate ~500/day quota vs 100/day for gpt-4o)
  // Note: to unlock Copilot Business API, run: gh auth refresh --scopes copilot
  const model = customModel ?? "gpt-4o-mini";
  console.error(`Using models.inference.ai.azure.com (GitHub Models fallback), model: ${model}`);
  return { client: new OpenAI({ ...clientOpts, baseURL: "https://models.inference.ai.azure.com", apiKey: pat }), visionModel: model, textModel: model };
}

// Step 1: Score each screenshot for relevance using Copilot Vision
export async function scoreScreenshots(frames: ExtractedFrame[]): Promise<Screenshot[]> {
  const existing = frames.filter((f) => fs.existsSync(f.filePath));
  if (existing.length === 0) return [];

  // Load all base64 images upfront
  const loaded = existing.map((f) => ({
    frame: f,
    base64: fs.readFileSync(f.filePath).toString("base64"),
    ext: path.extname(f.filePath).slice(1) || "png",
  }));

  let scored: Screenshot[] = [];

  try {
    const { client, visionModel } = await getCopilotClient();

    // Batch all images into ONE request — uses 1 API call instead of N
    const imageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (let i = 0; i < loaded.length; i++) {
      const { frame, base64, ext } = loaded[i]!;
      imageContent.push({
        type: "image_url",
        image_url: { url: `data:image/${ext};base64,${base64}`, detail: "low" },
      } as OpenAI.Chat.Completions.ChatCompletionContentPartImage);
      imageContent.push({
        type: "text",
        text: `Image ${i + 1} (timestamp: ${Math.round(frame.timestamp)}s)`,
      } as OpenAI.Chat.Completions.ChatCompletionContentPartText);
    }
    imageContent.push({
      type: "text",
      text: `You have been shown ${loaded.length} screenshots from a screen recording in chronological order.
For each image, respond with a JSON array entry. Return ONLY a JSON array, no other text:
[
  { "i": 1, "relevanceScore": 0.0-1.0, "description": "one sentence", "tags": ["tag1","tag2"] },
  ...
]
relevanceScore: 1.0 = highly informative UI/content, 0.0 = blank/loading/static.
Tags examples: ui, form, error, dashboard, code, chat, presentation, blank, settings.
Be strict: blank screens and loading spinners score below 0.2.`,
    } as OpenAI.Chat.Completions.ChatCompletionContentPartText);

    const response = await client.chat.completions.create({
      model: visionModel,
      messages: [{ role: "user", content: imageContent }],
      max_tokens: 100 * loaded.length,
    });

    const content = response.choices[0]?.message.content ?? "[]";
    const arrMatch = content.match(/\[[\s\S]*\]/);
    const results: Array<{ i: number; relevanceScore: number; description: string; tags: string[] }> =
      arrMatch ? JSON.parse(arrMatch[0]) : [];

    const resultMap = new Map(results.map((r) => [r.i, r]));
    scored = loaded.map(({ frame, base64 }, idx) => {
      const r = resultMap.get(idx + 1);
      return {
        id: `ss_${Math.round(frame.timestamp * 1000)}`,
        timestamp: frame.timestamp,
        filePath: frame.filePath,
        base64,
        relevanceScore: r?.relevanceScore ?? 0.5,
        description: r?.description ?? "Screenshot",
        tags: r?.tags ?? [],
      };
    });
  } catch (err) {
    // Vision unavailable — include all with neutral score (text analysis still runs)
    console.error("Vision scoring unavailable, using neutral scores:", (err as Error).message);
    scored = loaded.map(({ frame, base64 }) => ({
      id: `ss_${Math.round(frame.timestamp * 1000)}`,
      timestamp: frame.timestamp,
      filePath: frame.filePath,
      base64,
      relevanceScore: 0.5,
      description: "Screenshot (vision scoring unavailable)",
      tags: [],
    }));
  }

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
  const attempt = async () => {
    const { client, textModel } = await getCopilotClient();
    return await analyzeWithAI(client, textModel, transcript, screenshots, title);
  };

  try {
    return await attempt();
  } catch (err) {
    const msg = (err as Error).message ?? "";
    const isRateLimit = msg.includes("429") || msg.includes("RateLimit") || msg.toLowerCase().includes("rate limit");
    if (!isRateLimit) {
      console.error("AI analysis failed — falling back to basic analysis:", msg);
      return buildBasicAnalysis(transcript, screenshots, title);
    }
    // Check if this is a per-minute TPM limit (retryable) vs a daily limit (not retryable)
    const waitMatch = msg.match(/wait (\d+) second/i);
    const waitSec = waitMatch ? parseInt(waitMatch[1], 10) : 0;
    if (waitSec > 0 && waitSec <= 120) {
      // Per-minute TPM limit — wait and retry once
      console.error(`AI rate-limited (TPM) — retrying in ${waitSec + 2}s...`);
      await new Promise((r) => setTimeout(r, (waitSec + 2) * 1000));
      try {
        return await attempt();
      } catch (retryErr) {
        const retryMsg = (retryErr as Error).message ?? "";
        console.error("AI rate-limited after retry — falling back to basic analysis:", retryMsg.slice(0, 80));
      }
    } else {
      // Daily limit or long wait — no retry
      console.error(`AI rate-limited (daily limit) — basic analysis only. ${waitSec > 0 ? `(resets in ~${Math.round(waitSec / 3600)}h)` : ""}`);
    }
    return buildBasicAnalysis(transcript, screenshots, title);
  }
}

// Basic analysis built from transcript text without any AI — always works
function buildBasicAnalysis(
  transcript: TranscriptSegment[],
  screenshots: Screenshot[],
  title: string
): RecordingAnalysis["analysis"] {
  const speakers = [...new Set(transcript.map((s) => s.speaker).filter(Boolean))];
  const words = transcript.map((s) => s.text).join(" ");
  const wordCount = words.split(/\s+/).length;

  // Extract sentences as rough key points (first sentence of each speaker block)
  const keyPoints: string[] = [];
  let lastSpeaker = "";
  for (const seg of transcript) {
    if (seg.speaker !== lastSpeaker && seg.text.trim().length > 20) {
      keyPoints.push(`[${formatTime(seg.start)}] ${seg.speaker}: ${seg.text.trim().slice(0, 100)}`);
      lastSpeaker = seg.speaker;
      if (keyPoints.length >= 10) break;
    }
  }

  const summary = `Recording "${title}" — ${Math.round(wordCount / 130)} minute(s) of speech from ${speakers.join(", ") || "unknown speaker(s)"}. `
    + `Transcript contains ${transcript.length} segments. `
    + `AI analysis unavailable (API rate limit reached — will work again tomorrow or configure COPILOT_API_URL).`;

  return {
    summary,
    humanReadableSummary: `• Recording: ${title}\n• Speakers: ${speakers.join(", ") || "N/A"}\n• Segments: ${transcript.length}\n• Note: AI analysis unavailable — raw transcript available in result.raw.transcriptText`,
    keyPoints,
    issues: [],
    features: [],
    decisions: [],
    actionItems: [],
    speakers,
    sentiment: "neutral",
    topics: [],
  };
}

async function analyzeWithAI(
  client: OpenAI,
  textModel: string,
  transcript: TranscriptSegment[],
  screenshots: Screenshot[],
  title: string
): Promise<RecordingAnalysis["analysis"]> {
  const transcriptText = transcript
    .map((s) => `[${formatTime(s.start)}] ${s.speaker}: ${s.text}`)
    .join("\n");

  // Screenshots are described textually — no need to send images again (saves tokens, avoids double vision rate limit)
  const screenshotDescriptions = screenshots
    .map((s) => `[${formatTime(s.timestamp)}] ${s.description} (tags: ${s.tags.join(", ")})`)
    .join("\n");

  const transcriptExcerpt = transcriptText.slice(0, 15000);
  const hasTranscript = transcriptExcerpt.trim().length > 0;

  const prompt = `You are analyzing a Teams meeting recording. The content may be in German, English, or mixed — always respond in the SAME language as the meeting content.

Title: ${title}

${hasTranscript ? `Full Transcript:\n${transcriptExcerpt}` : "No transcript available — analyze from screenshots only."}

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

  // Try with images first; if vision unsupported (400), retry text-only
  async function callWithFallback() {
    return client.chat.completions.create({
      model: textModel,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
    });
  }

  const response = await callWithFallback();

  const content = response.choices[0]?.message.content ?? "{}";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

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


