import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, spawnSync } from "child_process";
import type { RecordingAnalysis, TranscriptSegment } from "../types/index";
import { parseTranscript, transcriptToPlainText } from "./transcriptParser";
import { extractScreenshots } from "./screenshotExtractor";
import { scoreScreenshots } from "./copilotAnalyzer";
import { analyzeRecording } from "./copilotAnalyzer";
import { saveAnalysis, loadAnalysis, generateRecordingId } from "./cache";
import { getGraphToken, resolveRecordingFiles, downloadFromUrl, downloadWithSharePointToken, parseRecordingUrl } from "./graphAuth";

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm", ".mov", ".avi"];
const TRANSCRIPT_EXTENSIONS = [".vtt", ".docx"];

// Download a resolved file — handles both anonymous download URLs and SP-REST URLs
async function downloadResolvedFile(
  file: { name: string; downloadUrl: string; mimeType: string },
  destPath: string,
  sourceUrl: string
): Promise<void> {
  const parsedDl = new URL(file.downloadUrl);
  if (!parsedDl.searchParams.has("tempauth") && !parsedDl.searchParams.has("access_token")) {
    const info = parseRecordingUrl(sourceUrl);
    if (info.hostname) {
      try {
        const serverRelativeUrl = parsedDl.pathname;
        return await downloadWithSharePointToken(info.hostname, serverRelativeUrl, destPath);
      } catch { /* fall through */ }
    }
  }
  return downloadFromUrl(file.downloadUrl, destPath);
}

// ── yt-dlp fallback (uses browser cookies — works if user can view in browser) ─
// Common install locations for yt-dlp (WinGet installs here but may not be on PATH yet)
const YT_DLP_FALLBACK_PATHS = [
  path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages",
    "yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe", "yt-dlp.exe"),
  "C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe",
];

function resolveYtDlp(): string | null {
  try {
    execSync("yt-dlp --version", { stdio: "pipe" });
    return "yt-dlp"; // found on PATH
  } catch { /* not on PATH */ }
  for (const p of YT_DLP_FALLBACK_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function downloadViaYtDlp(url: string, destDir: string, graphToken?: string): { videoPath: string | null; transcriptPath: string | null } {
  const ytDlpCmd = resolveYtDlp();
  if (!ytDlpCmd) {
    throw new Error(
      "yt-dlp is not installed.\n" +
      "Install with:  winget install yt-dlp.yt-dlp\n" +
      "Or:            pip install yt-dlp"
    );
  }

  const outputTemplate = path.join(destDir, "%(title)s.%(ext)s");

  // Build a list of strategies to try in order
  const strategies: { label: string; args: string[] }[] = [];

  // 1. Cookies file from env var (most reliable — doesn't require browser to be closed)
  const cookiesFile = process.env["COOKIES_FILE"];
  if (cookiesFile && fs.existsSync(cookiesFile)) {
    strategies.push({
      label: `cookies file (${path.basename(cookiesFile)})`,
      args: ["--cookies", cookiesFile],
    });
  }

  // 2. Bearer token via --add-headers (works for some SharePoint setups)
  if (graphToken) {
    strategies.push({
      label: "Bearer token (az login)",
      args: ["--add-headers", `Authorization:Bearer ${graphToken}`],
    });
  }

  // 3. Browser cookies — Firefox first (works even when browser is open), then others
  for (const browser of ["firefox", "edge", "chrome", "chromium"]) {
    strategies.push({
      label: `${browser} browser cookies`,
      args: ["--cookies-from-browser", browser],
    });
  }

  const commonArgs = [
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs", "en.*,de.*",
    "--sub-format", "vtt",
    "--convert-subs", "vtt",
    "-o", outputTemplate,
  ];

  let lastError = "";
  for (const { label, args } of strategies) {
    console.error(`Trying yt-dlp with ${label}...`);
    const result = spawnSync(
      ytDlpCmd,
      [...args, ...commonArgs, url],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 600_000 }
    );

    if (result.status === 0) {
      const files = fs.readdirSync(destDir);
      const videoFile = files.find((f) => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()));
      const transcriptFile = files.find((f) => f.endsWith(".vtt") || f.endsWith(".srt"));
      console.error(`✅ yt-dlp download complete via ${label}. Files: ${files.join(", ")}`);
      return {
        videoPath: videoFile ? path.join(destDir, videoFile) : null,
        transcriptPath: transcriptFile ? path.join(destDir, transcriptFile) : null,
      };
    }

    const stderr = (result.stderr?.toString() ?? "").trim();
    const isAuthError = stderr.includes("cookie") || stderr.includes("Could not find") ||
      stderr.includes("browser") || stderr.includes("login") || stderr.includes("401") ||
      stderr.includes("403") || stderr.includes("Unsupported URL");
    lastError = stderr.substring(0, 300);

    if (isAuthError) {
      console.error(`  ↳ auth/cookie issue, trying next strategy...`);
      continue;
    }
    // Non-auth error — stop trying
    console.error(`  ↳ yt-dlp error: ${lastError}`);
    break;
  }

  throw new Error(
    "yt-dlp: all download strategies failed.\n\n" +
    "Best fix — export cookies from your browser:\n" +
    "  1. Install the 'Get cookies.txt LOCALLY' extension in Edge/Chrome\n" +
    "  2. Navigate to your SharePoint site and log in\n" +
    "  3. Click the extension → Export cookies.txt\n" +
    "  4. Set COOKIES_FILE=C:\\path\\to\\cookies.txt in your .env file\n\n" +
    "Alternatively, close Edge/Chrome completely and retry (browser was likely open\n" +
    "and locking its cookie database).\n\n" +
    `Last error: ${lastError}`
  );
}

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

  // Try Graph auth — but don't fail hard, yt-dlp browser cookies are the reliable fallback
  let token: string | null = null;
  try {
    console.error("Trying Microsoft Graph authentication...");
    token = await getGraphToken(tenantId, clientId ?? undefined);
  } catch (authErr) {
    console.error(`Graph auth skipped: ${(authErr as Error).message.split("\n")[0]}`);
    console.error("Will try yt-dlp with browser cookies instead...");
  }

  // Download to temp dir
  const tempDir = path.join(os.tmpdir(), `mcp-rec-${id}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Try Graph/SharePoint REST API first (only if we have a token)
  let videoPath: string | null = null;
  let transcriptPath: string | null = null;

  let graphFailed = !token; // skip Graph entirely if no token
  if (token) {
    try {
      console.error("Resolving recording files from URL...");
      const files = await resolveRecordingFiles(token, url);

      const videoFile = files.find((f) => VIDEO_EXTENSIONS.includes(path.extname(f.name).toLowerCase()));
      const transcriptFile = files.find((f) => TRANSCRIPT_EXTENSIONS.includes(path.extname(f.name).toLowerCase()));

      if (!videoFile) {
        throw new Error(`No video file found at URL. Found: ${files.map((f) => f.name).join(", ") || "nothing"}`);
      }

      videoPath = path.join(tempDir, videoFile.name);
      transcriptPath = transcriptFile ? path.join(tempDir, transcriptFile.name) : null;

      console.error(`Downloading video: ${videoFile.name}`);
      await downloadResolvedFile(videoFile, videoPath, url);

      if (transcriptFile && transcriptPath) {
        console.error(`Downloading transcript: ${transcriptFile.name}`);
        await downloadResolvedFile(transcriptFile, transcriptPath, url);
      } else {
        console.error("No transcript found via Graph — will rely on screenshots");
      }
    } catch (graphErr) {
      console.error(`Graph/REST access failed: ${(graphErr as Error).message}`);
      graphFailed = true;
    }
  }

  // Fallback: yt-dlp with browser cookies (Firefox works even when open)
  if (graphFailed) {
    console.error("\n⚠️  Trying yt-dlp with browser cookies (Firefox first)...");
    try {
      const result = downloadViaYtDlp(url, tempDir, token ?? undefined);
      videoPath = result.videoPath;
      transcriptPath = result.transcriptPath;

      // If yt-dlp didn't get the transcript, try to fetch the VTT directly from SharePoint
      if (!transcriptPath && videoPath) {
        transcriptPath = await tryDownloadTranscriptDirectly(url, videoPath, tempDir);
      }
    } catch (ytErr) {
      throw new Error(
        `All download methods failed.\n\n` +
        `Graph/REST error: ${graphFailed ? "403/401 — tenant policy blocks app access" : "ok"}\n` +
        `yt-dlp error: ${(ytErr as Error).message}\n\n` +
        `➡  Manual fallback:\n` +
        `   1. Download the recording from Teams (.mp4)\n` +
        `   2. Download the transcript: Teams → ... → Open transcript → Download (.vtt)\n` +
        `   3. Put both files in one folder\n` +
        `   4. Use: process_recording_folder({ folder_path: "C:\\\\your\\\\folder" })`
      );
    }
  }

  if (!videoPath) {
    throw new Error("Could not obtain video file. Use process_recording_folder as a fallback.");
  }

  return processLocalFiles(videoPath, transcriptPath, url, id, "url");
}

// Try to download the VTT transcript directly from SharePoint (same folder as the MP4)
// Teams stores it alongside the recording with the same base name but .vtt extension.
async function tryDownloadTranscriptDirectly(
  originalUrl: string,
  videoPath: string,
  destDir: string
): Promise<string | null> {
  const info = parseRecordingUrl(originalUrl);
  if (!info.hostname || !info.filePath) return null;

  // Build candidate VTT paths — Teams typically uses same base name as the MP4
  const baseName = path.basename(info.filePath, path.extname(info.filePath));
  const folderPath = info.filePath.substring(0, info.filePath.lastIndexOf("/"));
  const vttCandidates = [
    `${folderPath}/${baseName}.vtt`,
    `${folderPath}/${baseName}-Transcript.vtt`,
    `${folderPath}/${baseName}_transcript.vtt`,
  ];

  for (const vttServerRelPath of vttCandidates) {
    const destPath = path.join(destDir, path.basename(vttServerRelPath));
    try {
      console.error(`Trying to download transcript: ${vttServerRelPath}`);
      await downloadWithSharePointToken(info.hostname, vttServerRelPath, destPath);
      // Verify it looks like a VTT file (not an error HTML page)
      const content = fs.readFileSync(destPath, "utf-8");
      if (content.includes("WEBVTT") || content.trim().length > 50) {
        console.error(`✅ Transcript downloaded: ${path.basename(destPath)}`);
        return destPath;
      }
      fs.unlinkSync(destPath); // delete corrupt file
    } catch { /* try next */ }
  }

  console.error("Could not auto-download transcript (SharePoint access restricted). Use inject_transcript to provide it manually.");
  return null;
}

// Re-analyze an existing recording with a newly provided transcript text.
// Useful when auto-download of VTT failed and the user copies the transcript from Teams.
export async function injectTranscriptAndReanalyze(
  id: string,
  transcriptText: string
): Promise<RecordingAnalysis> {
  const existing = loadAnalysis(id);
  if (!existing) throw new Error(`No cached analysis found for ID: ${id}`);

  // Parse the transcript — detect format
  let segments: TranscriptSegment[];

  if (transcriptText.trimStart().startsWith("WEBVTT")) {
    // Standard VTT format — write to temp file and parse
    const tmpVtt = path.join(os.tmpdir(), `mcp-inject-${id}.vtt`);
    fs.writeFileSync(tmpVtt, transcriptText, "utf-8");
    try {
      segments = await parseTranscript(tmpVtt);
    } finally {
      try { fs.unlinkSync(tmpVtt); } catch { /* ok */ }
    }
  } else {
    // Plain text or Teams auto-summary format — convert to segments
    // Try to detect timestamped lines like "Text here 0:16" or "[0:16] Text" or "0:16 Text"
    segments = parseTimestampedText(transcriptText);
  }

  console.error(`Re-analyzing with ${segments.length} transcript segments...`);

  // Re-run full AI analysis with the new transcript (keep existing screenshots)
  const newAnalysis = await analyzeRecording(segments, existing.screenshots, existing.title);
  const plainText = transcriptToPlainText(segments);

  const updated: RecordingAnalysis = {
    ...existing,
    transcript: segments,
    analysis: newAnalysis,
    raw: {
      ...existing.raw,
      transcriptText: plainText || transcriptText,
    },
  };

  if (segments.length > 0) {
    const last = segments[segments.length - 1];
    if (last && last.end > 0) {
      const h = Math.floor(last.end / 3600);
      const m = Math.floor((last.end % 3600) / 60);
      const s = Math.floor(last.end % 60);
      updated.duration = [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
    }
  }

  saveAnalysis(updated);
  console.error(`Re-analysis complete with transcript. Cached as ${id}`);
  return updated;
}

// Parse a plain/timestamped text block into TranscriptSegment[]
// Handles Teams auto-summary format: "Topic: text. 0:16"
// and simple: "[0:16] Speaker: text" or "0:16 text"
function parseTimestampedText(text: string): TranscriptSegment[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const segments: TranscriptSegment[] = [];
  let currentTime = 0;

  for (const line of lines) {
    // Match timestamps: 0:16, 1:06, 10:30 or 1:06:30
    const tsMatch = line.match(/(\d{1,2}:\d{2}(?::\d{2})?)[\s.]*$/);
    let timestamp = currentTime;
    let textContent = line;

    if (tsMatch && tsMatch[1]) {
      const parts = tsMatch[1].split(":").map(Number);
      timestamp = parts.length === 3
        ? (parts[0]! * 3600) + (parts[1]! * 60) + (parts[2]!)
        : (parts[0]! * 60) + (parts[1]!);
      textContent = line.slice(0, tsMatch.index).trim();
    }

    // Match speaker prefix: "Speaker: text" or "[timestamp] Speaker: text"
    const bracketTs = textContent.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*/);
    if (bracketTs) {
      const parts = bracketTs[1]!.split(":").map(Number);
      timestamp = parts.length === 3
        ? (parts[0]! * 3600) + (parts[1]! * 60) + (parts[2]!)
        : (parts[0]! * 60) + (parts[1]!);
      textContent = textContent.slice(bracketTs[0].length).trim();
    }

    const speakerMatch = textContent.match(/^([A-ZÄÖÜa-zäöüß][^:]{1,30}):\s+(.+)/);
    const speaker = speakerMatch ? speakerMatch[1]!.trim() : "Speaker";
    const finalText = speakerMatch ? speakerMatch[2]!.trim() : textContent;

    if (finalText.length > 0) {
      segments.push({
        start: timestamp,
        end: timestamp + 30, // estimate 30s per segment
        speaker,
        text: finalText,
      });
      currentTime = timestamp + 30;
    }
  }

  return segments;
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



