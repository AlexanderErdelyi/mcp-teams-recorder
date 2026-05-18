import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import type { TranscriptSegment } from "../types/index.js";

// Point fluent-ffmpeg at the static binary
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

export interface ExtractedFrame {
  timestamp: number;
  filePath: string;
  reason: "scene_change" | "segment_boundary" | "interval";
}

export interface ExtractionOptions {
  outputDir?: string;
  sceneChangeThreshold?: number;  // 0-1, default 0.3
  segmentBoundaries?: boolean;    // extract at each transcript segment
  intervalSeconds?: number;       // fallback interval if no transcript
}

// Main extraction function
export async function extractScreenshots(
  videoPath: string,
  segments: TranscriptSegment[],
  options: ExtractionOptions = {}
): Promise<ExtractedFrame[]> {
  const {
    sceneChangeThreshold = 0.3,
    segmentBoundaries = true,
    intervalSeconds = 30,
  } = options;

  const outputDir = options.outputDir ?? path.join(os.tmpdir(), `mcp-screenshots-${Date.now()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const frames: ExtractedFrame[] = [];

  // 1. Extract at transcript segment boundaries
  if (segmentBoundaries && segments.length > 0) {
    const timestamps = getUniqueTimestamps(segments);
    for (const ts of timestamps) {
      const filePath = path.join(outputDir, `seg_${Math.round(ts * 1000)}.png`);
      await extractFrame(videoPath, ts, filePath);
      frames.push({ timestamp: ts, filePath, reason: "segment_boundary" });
    }
  } else {
    // Fallback: extract at regular intervals
    const duration = await getVideoDuration(videoPath);
    for (let ts = 0; ts < duration; ts += intervalSeconds) {
      const filePath = path.join(outputDir, `interval_${Math.round(ts)}.png`);
      await extractFrame(videoPath, ts, filePath);
      frames.push({ timestamp: ts, filePath, reason: "interval" });
    }
  }

  // 2. Add scene-change frames via ffmpeg scene detection
  const sceneFrames = await detectSceneChanges(videoPath, outputDir, sceneChangeThreshold);
  for (const sf of sceneFrames) {
    // Only add if not already covered by a segment boundary within 2 seconds
    const alreadyCovered = frames.some((f) => Math.abs(f.timestamp - sf.timestamp) < 2);
    if (!alreadyCovered) {
      frames.push(sf);
    }
  }

  // Sort by timestamp
  frames.sort((a, b) => a.timestamp - b.timestamp);

  // Remove frames where the file doesn't exist (extraction may have failed at edge of video)
  return frames.filter((f) => fs.existsSync(f.filePath));
}

// Extract a single frame at a given timestamp
async function extractFrame(videoPath: string, timestamp: number, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(timestamp)
      .frames(1)
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => {
        // Don't reject on individual frame failures — just skip
        console.warn(`Frame extraction warning at ${timestamp}s: ${err.message}`);
        resolve();
      })
      .run();
  });
}

// Use ffmpeg scene detection filter to find scene changes
async function detectSceneChanges(
  videoPath: string,
  outputDir: string,
  threshold: number
): Promise<ExtractedFrame[]> {
  return new Promise((resolve) => {
    const frames: ExtractedFrame[] = [];
    let stderr = "";

    ffmpeg(videoPath)
      .videoFilters(`select='gt(scene,${threshold})',showinfo`)
      .frames(50)       // cap at 50 scene-change frames
      .output(path.join(outputDir, "scene_%04d.png"))
      .on("stderr", (line: string) => { stderr += line + "\n"; })
      .on("end", () => {
        // Parse showinfo output for timestamps — e.g. "pts_time:12.345"
        const matches = [...stderr.matchAll(/pts_time:([\d.]+)/g)];
        let i = 1;
        for (const match of matches) {
          const timestamp = parseFloat(match[1] ?? "0");
          const filePath = path.join(outputDir, `scene_${String(i).padStart(4, "0")}.png`);
          if (fs.existsSync(filePath)) {
            frames.push({ timestamp, filePath, reason: "scene_change" });
          }
          i++;
        }
        resolve(frames);
      })
      .on("error", () => resolve([])) // scene detection is best-effort
      .run();
  });
}

// Get duration of a video in seconds
function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration ?? 0);
    });
  });
}

// Deduplicate and sample segment boundary timestamps
function getUniqueTimestamps(segments: TranscriptSegment[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const seg of segments) {
    const ts = Math.round(seg.start);
    if (!seen.has(ts)) {
      seen.add(ts);
      result.push(ts);
    }
  }
  return result;
}
