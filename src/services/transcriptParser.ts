import * as fs from "fs";
import * as path from "path";
import mammoth from "mammoth";
import type { TranscriptSegment } from "../types/index.js";

// Parse WebVTT (.vtt) transcript into segments
export function parseVtt(content: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const blocks = content.split(/\n\n+/).filter((b) => b.trim());

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    // Find the timestamp line: 00:00:01.000 --> 00:00:05.000
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;

    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
    const start = vttTimeToSeconds(startStr);
    const end = vttTimeToSeconds(endStr);

    // Remaining lines are cue text — may include <v Speaker>text</v>
    const textLines = lines.filter((l) => !l.includes("-->") && !/^\d+$/.test(l.trim()));
    const rawText = textLines.join(" ").trim();

    const speakerMatch = rawText.match(/^<v ([^>]+)>(.*)<\/v>$/s);
    const speaker = speakerMatch ? speakerMatch[1].trim() : "Unknown";
    const text = speakerMatch ? speakerMatch[2].trim() : rawText.replace(/<[^>]+>/g, "").trim();

    if (text) {
      segments.push({ start, end, speaker, text });
    }
  }

  return segments;
}

// Parse Teams .docx transcript (exported via Teams)
export async function parseDocxTranscript(filePath: string): Promise<TranscriptSegment[]> {
  const result = await mammoth.extractRawText({ path: filePath });
  const lines = result.value.split("\n").filter((l) => l.trim());
  const segments: TranscriptSegment[] = [];

  // Teams .docx format: "Speaker Name\nHH:MM:SS\nText content"
  let i = 0;
  while (i < lines.length) {
    const possibleSpeaker = lines[i];
    const possibleTime = lines[i + 1];
    const possibleText = lines[i + 2];

    if (possibleTime && /^\d{1,2}:\d{2}(:\d{2})?$/.test(possibleTime.trim())) {
      const start = hhmmssToSeconds(possibleTime.trim());
      const text = possibleText?.trim() ?? "";
      segments.push({ start, end: start + 30, speaker: possibleSpeaker.trim(), text });
      i += 3;
    } else {
      i++;
    }
  }

  return segments;
}

// Auto-detect and parse transcript file
export async function parseTranscript(filePath: string): Promise<TranscriptSegment[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".vtt") {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseVtt(content);
  } else if (ext === ".docx") {
    return parseDocxTranscript(filePath);
  }
  throw new Error(`Unsupported transcript format: ${ext}. Supported: .vtt, .docx`);
}

export function transcriptToPlainText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => `[${formatTime(s.start)}] ${s.speaker}: ${s.text}`)
    .join("\n");
}

// --- Helpers ---

function vttTimeToSeconds(timeStr: string): number {
  // Format: HH:MM:SS.mmm or MM:SS.mmm
  const parts = timeStr.trim().split(":");
  if (parts.length === 3) {
    return parseInt(parts[0]!) * 3600 + parseInt(parts[1]!) * 60 + parseFloat(parts[2]!);
  } else {
    return parseInt(parts[0]!) * 60 + parseFloat(parts[1]!);
  }
}

function hhmmssToSeconds(timeStr: string): number {
  const parts = timeStr.split(":").map(Number);
  if (parts.length === 3) {
    return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  }
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}
