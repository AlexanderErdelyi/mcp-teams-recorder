import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import type { TranscriptSegment } from "../types/index";

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
  sceneChangeThreshold?: number;  // 0-1, default 0.4
  segmentBoundaries?: boolean;    // extract at sampled transcript segment boundaries
  intervalSeconds?: number;       // fallback interval if no transcript
  maxScreenshots?: number;        // hard cap, default 25
  minSpacingSeconds?: number;     // min seconds between sampled frames, default 45
}

// Main extraction function
export async function extractScreenshots(
  videoPath: string,
  segments: TranscriptSegment[],
  options: ExtractionOptions = {}
): Promise<ExtractedFrame[]> {
  const {
    sceneChangeThreshold = 0.4,
    segmentBoundaries = true,
    intervalSeconds = 60,
    maxScreenshots = 25,
    minSpacingSeconds = 45,
  } = options;

  const outputDir = options.outputDir ?? path.join(os.tmpdir(), `mcp-screenshots-${Date.now()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  let timestamps: number[];

  if (segmentBoundaries && segments.length > 0) {
    timestamps = sampleTimestamps(segments, maxScreenshots, minSpacingSeconds);
  } else {
    const duration = await getVideoDuration(videoPath);
    timestamps = [];
    for (let ts = 0; ts < duration; ts += intervalSeconds) timestamps.push(ts);
  }

  // Cap total
  if (timestamps.length > maxScreenshots) {
    timestamps = timestamps.slice(0, maxScreenshots);
  }

  console.log(`Extracting ${timestamps.length} frames (from ${segments.length} segments)...`);

  // Extract in parallel batches of 4
  const frames: ExtractedFrame[] = [];
  const BATCH = 4;
  for (let i = 0; i < timestamps.length; i += BATCH) {
    const batch = timestamps.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (ts) => {
      const filePath = path.join(outputDir, `seg_${Math.round(ts * 1000)}.png`);
      await extractFrame(videoPath, ts, filePath);
      return { timestamp: ts, filePath, reason: "segment_boundary" as const };
    }));
    frames.push(...results);
  }

  // Only run scene detection if we have fewer than half the cap
  if (frames.length < maxScreenshots / 2) {
    const sceneFrames = await detectSceneChanges(videoPath, outputDir, sceneChangeThreshold);
    for (const sf of sceneFrames) {
      if (frames.length >= maxScreenshots) break;
      const alreadyCovered = frames.some((f) => Math.abs(f.timestamp - sf.timestamp) < minSpacingSeconds);
      if (!alreadyCovered) frames.push(sf);
    }
  }

  frames.sort((a, b) => a.timestamp - b.timestamp);
  return frames.filter((f) => fs.existsSync(f.filePath));
}

// Extract a single frame at a given timestamp
async function extractFrame(videoPath: string, timestamp: number, outputPath: string): Promise<void> {
  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .seekInput(timestamp)
      .frames(1)
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => {
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
      .frames(20)       // cap at 20 scene-change frames
      .output(path.join(outputDir, "scene_%04d.png"))
      .on("stderr", (line: string) => { stderr += line + "\n"; })
      .on("end", () => {
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
      .on("error", () => resolve([]))
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

/**
 * Sample up to `maxCount` timestamps from segments,
 * ensuring at least `minSpacingSeconds` between consecutive picks.
 */
function sampleTimestamps(
  segments: TranscriptSegment[],
  maxCount: number,
  minSpacingSeconds: number
): number[] {
  // Collect unique second-level timestamps from segment starts
  const all = [...new Set(segments.map((s) => Math.round(s.start)))].sort((a, b) => a - b);

  if (all.length === 0) return [];

  // Always include first
  const result: number[] = [all[0]!];

  for (const ts of all) {
    if (result.length >= maxCount) break;
    const last = result[result.length - 1]!;
    if (ts - last >= minSpacingSeconds) {
      result.push(ts);
    }
  }

  return result;
}

