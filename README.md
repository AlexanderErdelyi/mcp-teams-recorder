# mcp-teams-recorder

MCP server that processes Teams recordings (SharePoint/Stream URLs or local folders) and returns structured intelligence — transcript, relevant screenshots, AI analysis — for use by downstream agents and skills.

**This MCP is an intelligence extraction layer, not an action layer.** It never creates work items or documents. Other tools (Azure DevOps MCP, Wiki.js MCP, ADO skills) consume its output.

---

## Architecture

```
You (or your agent/skill)
  → process_recording_url / process_recording_folder
      → Microsoft Graph (download)
      → ffmpeg (smart screenshots)
      → GitHub Copilot Vision (score screenshots)
      → GitHub Copilot API (analyze transcript + screenshots)
      → returns RecordingAnalysis (cached locally)
  → summarize_for_user_story / bug_report / documentation / feedback
      → returns structured draft
  → hand off to Azure DevOps MCP / Wiki.js MCP / any tool
```

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/your-org/mcp-teams-recorder
cd mcp-teams-recorder
npm install
npm run build
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:
```env
# Required: your GitHub token with Copilot access
GITHUB_TOKEN=ghp_...

# Required for SharePoint/Stream URL downloads:
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**Getting AZURE_CLIENT_ID**: Register an app in [Azure Portal → App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps).
- Platform: Mobile and desktop applications
- Redirect URI: `https://login.microsoftonline.com/common/oauth2/nativeclient`
- API permissions: `Files.Read.All`, `Sites.Read.All`, `User.Read` (all Delegated)

### 3. Register in your MCP client (VS Code / Copilot CLI)

Add to your MCP server config (e.g., `.vscode/mcp.json` or `~/.copilot/mcp.json`):

```json
{
  "mcpServers": {
    "mcp-teams-recorder": {
      "command": "node",
      "args": ["C:/vscodeprojects/github/mcp-teams-recorder/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}",
        "AZURE_TENANT_ID": "${env:AZURE_TENANT_ID}",
        "AZURE_CLIENT_ID": "${env:AZURE_CLIENT_ID}"
      }
    }
  }
}
```

---

## MCP Tools

| Tool | Input | Returns |
|---|---|---|
| `process_recording_url` | SharePoint/Stream URL | `RecordingAnalysis` |
| `process_recording_folder` | Local folder path | `RecordingAnalysis` |
| `get_recording_analysis` | Recording ID | Cached `RecordingAnalysis` |
| `list_recordings` | — | List of cached recordings |
| `summarize_for_user_story` | Recording ID | `UserStorySummary` |
| `summarize_for_bug_report` | Recording ID | `BugReportSummary` |
| `summarize_for_documentation` | Recording ID | `DocumentationSummary` |
| `summarize_for_feedback` | Recording ID | `FeedbackSummary` (with bug list) |

---

## RecordingAnalysis schema

```typescript
{
  id: string,
  title: string,
  duration: string,           // "01:23:45"
  transcript: [{ start, end, speaker, text }],
  screenshots: [{ id, timestamp, filePath, relevanceScore, description, tags }],
  analysis: {
    summary: string,
    keyPoints: string[],
    issues: [{ title, description, severity, timestamp, screenshotIds }],
    features: [{ title, description, timestamp, screenshotIds }],
    decisions: [{ summary, context, timestamp }],
    actionItems: [{ title, assignee, priority, context }],
    speakers: string[],
    sentiment: "positive" | "neutral" | "mixed" | "negative",
    topics: string[]
  }
}
```

---

## Usage examples

### With Azure DevOps MCP (create user story from recording):
```
1. process_recording_url("https://company.sharepoint.com/...")
2. summarize_for_user_story(recording_id)
3. Azure DevOps MCP: create_work_item(type: "User Story", ...)
```

### With Wiki.js MCP (document a meeting):
```
1. process_recording_folder("C:/recordings/architecture-review")
2. summarize_for_documentation(recording_id)
3. Wiki.js MCP: create_page(title, content)
```

### From a test session (create multiple bugs):
```
1. process_recording_url("https://...")
2. summarize_for_feedback(recording_id)
3. For each issue → Azure DevOps MCP: create_work_item(type: "Bug", ...)
```

---

## Plan B: local folder

If SharePoint URL access fails, download the recording manually from Teams:
1. In Teams, go to the meeting recording
2. Click **Download** to get the `.mp4`
3. Click **...** → **Open transcript** → **Download (.vtt)**
4. Put both files in a folder, e.g., `C:\recordings\sprint-demo`
5. Call `process_recording_folder("C:/recordings/sprint-demo")`

---

## Skill template

See [`skills/recording-analyzer.skill.md`](skills/recording-analyzer.skill.md) for a reusable Copilot skill that orchestrates this MCP with Azure DevOps, Wiki.js, and other tools.

---

## Caching

Processed analyses are cached in `.recordings-cache/` as JSON files (keyed by content hash of the source URL/path). Re-calling `process_recording_url` with the same URL returns instantly from cache. Use `force_reprocess: true` to re-run.
