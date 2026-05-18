import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { processRecordingUrl, processRecordingFolder, injectTranscriptAndReanalyze } from "./services/pipeline";
import { annotateScreenshot, smartAnnotateScreenshot, locateUiElements, type Annotation } from "./services/screenshotAnnotator";
import { loadAnalysis, listCachedAnalyses } from "./services/cache";
import {
  summarizeForUserStory,
  summarizeForBugReport,
  summarizeForDocumentation,
  summarizeForFeedback,
} from "./services/summarizers";

const server = new McpServer({
  name: "mcp-teams-recorder",
  version: "1.0.0",
});

// ─── Tool: process_recording_url ────────────────────────────────────────────
server.tool(
  "process_recording_url",
  "Download and analyze a Teams recording from a SharePoint or Stream URL. Returns a RecordingAnalysis with transcript, screenshots, and AI-extracted insights (issues, features, decisions, action items). Use the returned analysis with summarize_for_* tools to prepare structured output for downstream agents.",
  {
    url: z.string().describe("SharePoint or Stream URL of the Teams recording folder or file"),
    force_reprocess: z.boolean().optional().describe("Re-run analysis even if cached (default: false)"),
  },
  async ({ url, force_reprocess }) => {
    try {
      const analysis = await processRecordingUrl(url, force_reprocess ?? false);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...analysis,
                // Omit base64 from tool response to keep it readable
                screenshots: analysis.screenshots.map(({ base64: _b, ...s }) => s),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: process_recording_folder ─────────────────────────────────────────
server.tool(
  "process_recording_folder",
  "Analyze a Teams recording from a local folder. The folder should contain a video file (.mp4, .mkv, .webm) and optionally a transcript (.vtt or .docx). Use this as Plan B when SharePoint URL access is unavailable.",
  {
    folder_path: z.string().describe("Absolute path to the local folder containing video + transcript"),
    force_reprocess: z.boolean().optional().describe("Re-run analysis even if cached (default: false)"),
  },
  async ({ folder_path, force_reprocess }) => {
    try {
      const analysis = await processRecordingFolder(folder_path, force_reprocess ?? false);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...analysis,
                screenshots: analysis.screenshots.map(({ base64: _b, ...s }) => s),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: get_recording_analysis ───────────────────────────────────────────
server.tool(
  "get_recording_analysis",
  "Retrieve a previously processed RecordingAnalysis by its ID. Use list_recordings to find available IDs.",
  {
    recording_id: z.string().describe("Recording ID from a previous process_recording_* call"),
  },
  async ({ recording_id }) => {
    const analysis = loadAnalysis(recording_id);
    if (!analysis) {
      return {
        content: [{ type: "text", text: `No analysis found for ID: ${recording_id}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { ...analysis, screenshots: analysis.screenshots.map(({ base64: _b, ...s }) => s) },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── Tool: list_recordings ───────────────────────────────────────────────────
server.tool(
  "list_recordings",
  "List all previously processed recordings in the local cache.",
  {},
  async () => {
    const list = listCachedAnalyses();
    if (list.length === 0) {
      return { content: [{ type: "text", text: "No recordings processed yet." }] };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(list, null, 2),
        },
      ],
    };
  }
);

// ─── Tool: summarize_for_user_story ──────────────────────────────────────────
server.tool(
  "summarize_for_user_story",
  "Reshape a RecordingAnalysis into a structured user story draft. Returns title, as-a/i-want/so-that, acceptance criteria, and related screenshots. Pass the result to Azure DevOps MCP or an ADO skill to create the actual work item.",
  {
    recording_id: z.string().describe("Recording ID to summarize"),
  },
  async ({ recording_id }) => {
    const analysis = loadAnalysis(recording_id);
    if (!analysis) {
      return { content: [{ type: "text", text: `No analysis found for ID: ${recording_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(summarizeForUserStory(analysis), null, 2) }] };
  }
);

// ─── Tool: summarize_for_bug_report ──────────────────────────────────────────
server.tool(
  "summarize_for_bug_report",
  "Reshape a RecordingAnalysis into a structured bug report draft. Returns title, severity, steps to reproduce, expected vs actual behavior. Pass to Azure DevOps MCP or ADO skill to create the Bug work item.",
  {
    recording_id: z.string().describe("Recording ID to summarize"),
  },
  async ({ recording_id }) => {
    const analysis = loadAnalysis(recording_id);
    if (!analysis) {
      return { content: [{ type: "text", text: `No analysis found for ID: ${recording_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(summarizeForBugReport(analysis), null, 2) }] };
  }
);

// ─── Tool: summarize_for_documentation ───────────────────────────────────────
server.tool(
  "summarize_for_documentation",
  "Reshape a RecordingAnalysis into a documentation outline with headings and content sections. Pass to Wiki.js MCP, Azure DevOps Wiki, or any documentation tool to create the actual page.",
  {
    recording_id: z.string().describe("Recording ID to summarize"),
  },
  async ({ recording_id }) => {
    const analysis = loadAnalysis(recording_id);
    if (!analysis) {
      return { content: [{ type: "text", text: `No analysis found for ID: ${recording_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(summarizeForDocumentation(analysis), null, 2) }] };
  }
);

// ─── Tool: summarize_for_feedback ────────────────────────────────────────────
server.tool(
  "summarize_for_feedback",
  "Reshape a RecordingAnalysis into a structured test feedback report. Returns positive points, issues found (as bug drafts), suggestions, and overall sentiment. Use to create multiple Bug/Task work items from a test session recording.",
  {
    recording_id: z.string().describe("Recording ID to summarize"),
  },
  async ({ recording_id }) => {
    const analysis = loadAnalysis(recording_id);
    if (!analysis) {
      return { content: [{ type: "text", text: `No analysis found for ID: ${recording_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(summarizeForFeedback(analysis), null, 2) }] };
  }
);

// ─── Tool: inject_transcript ─────────────────────────────────────────────────
server.tool(
  "inject_transcript",
  "Provide a transcript for an existing recording and re-run the AI analysis. Use when auto-download of the VTT failed. Accepts: raw VTT content, Teams auto-summary text, or any timestamped text. Returns the updated RecordingAnalysis with full transcript-based insights.",
  {
    recording_id: z.string().describe("Recording ID from a previous process_recording_* call"),
    transcript_text: z.string().describe("Transcript content: VTT format, Teams auto-summary text, or plain timestamped text. Copy from Teams → Open Transcript → Download, or paste the meeting summary."),
  },
  async ({ recording_id, transcript_text }) => {
    try {
      const analysis = await injectTranscriptAndReanalyze(recording_id, transcript_text);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...analysis,
                screenshots: analysis.screenshots.map(({ base64: _b, ...s }) => s),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: get_full_transcript ───────────────────────────────────────────────
server.tool(
  "get_full_transcript",
  "Get the full plain-text transcript and human-readable summary for a recording. Use this to pass the complete transcript to other AI agents (documentation, work item creation, etc.).",
  {
    recording_id: z.string().describe("Recording ID from a previous process_recording_* call"),
  },
  async ({ recording_id }) => {
    const analysis = loadAnalysis(recording_id);
    if (!analysis) {
      return {
        content: [{ type: "text", text: `No analysis found for ID: ${recording_id}` }],
        isError: true,
      };
    }
    const hasTranscript = analysis.transcript.length > 0 || (analysis.raw?.transcriptText?.length ?? 0) > 0;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              recordingId: analysis.id,
              title: analysis.title,
              duration: analysis.duration,
              hasTranscript,
              transcriptSegmentCount: analysis.transcript.length,
              humanReadableSummary: analysis.analysis.humanReadableSummary,
              fullTranscriptText: analysis.raw?.transcriptText ?? "",
              actionItems: analysis.analysis.actionItems,
              speakers: analysis.analysis.speakers,
              topics: analysis.analysis.topics,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── Tool: annotate_screenshot ───────────────────────────────────────────────
server.tool(
  "annotate_screenshot",
  `Add visual annotations (rectangles, text notes, numbered markers, arrows) to a screenshot and save the result as a new file.
Annotations array supports four types:
  - rect:   highlight an area  { type:"rect", x, y, width, height, color?, label?, strokeWidth?, fill? }
  - text:   add a note         { type:"text", x, y, text, color?, fontSize?, background? }
  - marker: numbered pin       { type:"marker", x, y, number, color? }
  - arrow:  draw an arrow      { type:"arrow", fromX, fromY, toX, toY, color?, strokeWidth? }
Coordinates are in pixels from the top-left corner.
Colors accept CSS hex values (#ff0000) or rgba strings.
The annotated image is saved alongside the original with an _annotated.png suffix (or to output_path if provided).`,
  {
    input_path: z.string().describe("Absolute path to the source screenshot (PNG or JPEG)"),
    annotations: z
      .array(z.record(z.string(), z.unknown()))
      .describe("Array of annotation objects (rect / text / marker / arrow)"),
    output_path: z
      .string()
      .optional()
      .describe("Where to save the annotated image (optional; defaults to <input>_annotated.png)"),
  },
  async ({ input_path, annotations, output_path }) => {
    try {
      const result = await annotateScreenshot({
        inputPath: input_path,
        annotations: annotations as unknown as Annotation[],
        outputPath: output_path,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              outputPath: result.outputPath,
              annotationCount: result.annotationCount,
              imageSizePx: { width: result.widthPx, height: result.heightPx },
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: String(err) }),
          },
        ],
      };
    }
  }
);

// ─── Tool: locate_ui_elements ────────────────────────────────────────────────
server.tool(
  "locate_ui_elements",
  `Use GPT-4o Vision to analyze a screenshot and detect UI elements with their pixel coordinates.
Returns detected elements with bounding boxes AND a ready-to-use suggestedAnnotations array you can pass directly to annotate_screenshot.
Optionally provide a focus hint to target specific areas (e.g. "find input fields", "highlight error messages", "show navigation elements").`,
  {
    image_path: z.string().describe("Absolute path to the screenshot to analyze"),
    focus: z
      .string()
      .optional()
      .describe("Optional: natural language description of what to look for, e.g. 'find all form fields' or 'highlight sections that need grouping'"),
  },
  async ({ image_path, focus }) => {
    try {
      const located = await locateUiElements(image_path, focus);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              imageWidth: located.imageWidth,
              imageHeight: located.imageHeight,
              elementCount: located.elements.length,
              elements: located.elements,
              suggestedAnnotations: located.suggestedAnnotations,
              tip: "Pass suggestedAnnotations directly to annotate_screenshot to get a correctly annotated image, or customize them first.",
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: String(err) }) }],
      };
    }
  }
);

// ─── Tool: smart_annotate_screenshot ─────────────────────────────────────────
server.tool(
  "smart_annotate_screenshot",
  `Context-aware annotation: automatically analyzes the screenshot with GPT-4o Vision to understand the UI, detects element positions, then applies correctly-placed annotations. No manual coordinates needed.
Use this instead of annotate_screenshot when you want AI to figure out where things are.
Provide a focus hint to control what gets highlighted (e.g. "mark all input fields that need grouping", "highlight the problematic section", "annotate the navigation buttons").`,
  {
    image_path: z.string().describe("Absolute path to the source screenshot"),
    focus: z
      .string()
      .optional()
      .describe("What to focus on / what to annotate, e.g. 'group the data connection fields', 'show the bug in the form layout'"),
    output_path: z
      .string()
      .optional()
      .describe("Where to save the annotated image (defaults to <input>_annotated.png)"),
  },
  async ({ image_path, focus, output_path }) => {
    try {
      const { result, elements } = await smartAnnotateScreenshot(image_path, focus, output_path);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              outputPath: result.outputPath,
              annotationCount: result.annotationCount,
              imageSizePx: { width: result.widthPx, height: result.heightPx },
              detectedElements: elements.map((e) => ({
                label: e.label,
                description: e.description,
                bounds: { x: e.x, y: e.y, width: e.width, height: e.height },
              })),
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: String(err) }) }],
      };
    }
  }
);

// ─── Start server ────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-teams-recorder server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});


