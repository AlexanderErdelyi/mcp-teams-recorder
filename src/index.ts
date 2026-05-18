import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { processRecordingUrl, processRecordingFolder } from "./services/pipeline.js";
import { loadAnalysis, listCachedAnalyses } from "./services/cache.js";
import {
  summarizeForUserStory,
  summarizeForBugReport,
  summarizeForDocumentation,
  summarizeForFeedback,
} from "./services/summarizers.js";

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
