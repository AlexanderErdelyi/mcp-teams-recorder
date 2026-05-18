import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { RecordingAnalysis } from "../types/index";
import { parseTranscript, transcriptToPlainText } from "./transcriptParser";
import { extractScreenshots } from "./screenshotExtractor";
import { scoreScreenshots } from "./copilotAnalyzer";
import { analyzeRecording } from "./copilotAnalyzer";
import { saveAnalysis, loadAnalysis, generateRecordingId } from "./cache";
import { getGraphToken, downloadSharePointFile, listSharePointFolder } from "./graphAuth";

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm", ".mov", ".avi"];
const TRANSCRIPT_EXTENSIONS = [".vtt", ".docx"];

// Process a recording from a SharePoint/Stream URL
export async function processRecordingUrl(
  url: string,
  forceReprocess = false
): Promise<RecordingAnalysis> {
  const id = generateRecordingId(url);

  if (!forceReprocess) {
    const cached = loadAnalysis(id);
    if (cached) return cached;
  }

  const tenantId = process.env["AZURE_TENANT_ID"];
  const clientId = process.env["AZURE_CLIENT_ID"]; // optional

  console.error("Authenticating with Microsoft Graph...");
  const token = await getGraphToken(tenantId, clientId ?? undefined);

  // Download to temp dir
  const tempDir = path.join(os.tmpdir(), `mcp-rec-${id}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // If URL points to a folder, list and find video + transcript
  // If URL points directly to a file, download it
  console.error("Listing SharePoint folder...");
  const files = await listSharePointFolder(token, url);

  const videoFile = files.find((f) => VIDEO_EXTENSIONS.includes(path.extname(f.name).toLowerCase()));
  const transcriptFile = files.find((f) => TRANSCRIPT_EXTENSIONS.includes(path.extname(f.name).toLowerCase()));

  if (!videoFile) {
    throw new Error("No video file found at the provided URL. Supported: " + VIDEO_EXTENSIONS.join(", "));
  }

  const videoPath = path.join(tempDir, videoFile.name);
  const transcriptPath = transcriptFile ? path.join(tempDir, transcriptFile.name) : null;

  console.error(`Downloading video: ${videoFile.name}`);
  await downloadSharePointFile(token, videoFile.downloadUrl, videoPath);

  if (transcriptFile && transcriptPath) {
    console.error(`Downloading transcript: ${transcriptFile.name}`);
    await downloadSharePointFile(token, transcriptFile.downloadUrl, transcriptPath);
  }

  return processLocalFiles(videoPath, transcriptPath, url, id, "url");
}

// Process a recording from a local folder (Plan B)
export async function processRecordingFolder(
  folderPath: string,
  forceReprocess = false
): Promise<RecordingAnalysis> {
  const id = generateRecordingId(folderPath);

  if (!forceReprocess) {
    const cached = loadAnalysis(id);
    if (cached) return cached;
  }

  if (!fs.existsSync(folderPath)) {
    throw new Error(`Folder not found: ${folderPath}`);
  }

  const files = fs.readdirSync(folderPath);
  const videoFile = files.find((f) => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()));
  const transcriptFile = files.find((f) => TRANSCRIPT_EXTENSIONS.includes(path.extname(f).toLowerCase()));

  if (!videoFile) {
    throw new Error(`No video file found in ${folderPath}. Supported: ${VIDEO_EXTENSIONS.join(", ")}`);
  }

  const videoPath = path.join(folderPath, videoFile);
  const transcriptPath = transcriptFile ? path.join(folderPath, transcriptFile) : null;

  return processLocalFiles(videoPath, transcriptPath, folderPath, id, "folder");
}

// Shared pipeline: parse transcript → extract screenshots → analyze → cache
async function processLocalFiles(
  videoPath: string,
  transcriptPath: string | null,
  sourceRef: string,
  id: string,
  source: "url" | "folder"
): Promise<RecordingAnalysis> {
  const title = path.basename(videoPath, path.extname(videoPath));

  // 1. Parse transcript
  console.error("Parsing transcript...");
  const segments = transcriptPath ? await parseTranscript(transcriptPath) : [];
  const transcriptText = transcriptToPlainText(segments);

  // 2. Extract screenshots
  console.error("Extracting screenshots...");
  const screenshotDir = path.join(path.dirname(videoPath), `screenshots-${id}`);
  const frames = await extractScreenshots(videoPath, segments, { outputDir: screenshotDir });

  // 3. Score screenshots with Copilot Vision
  console.error(`Scoring ${frames.length} frames with Copilot Vision...`);
  const screenshots = await scoreScreenshots(frames);

  // 4. Full analysis
  console.error("Running full recording analysis...");
  const analysis = await analyzeRecording(segments, screenshots, title);

  // 5. Build and cache result
  const result: RecordingAnalysis = {
    id,
    title,
    duration: formatDuration(segments),
    processedAt: new Date().toISOString(),
    source,
    sourceRef,
    transcript: segments,
    screenshots,
    analysis,
    raw: {
      transcriptText,
      screenshotDir,
    },
  };

  saveAnalysis(result);
  console.error(`Analysis complete. Cached as ${id}`);

  return result;
}

function formatDuration(segments: TranscriptSegment[]): string {
  if (segments.length === 0) return "00:00:00";
  const last = segments[segments.length - 1];
  if (!last) return "00:00:00";
  const total = last.end;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

// Import type for use in formatDuration
import type { TranscriptSegment } from "../types/index";


