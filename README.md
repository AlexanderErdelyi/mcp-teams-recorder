# mcp-teams-recorder

MCP server that processes Teams recordings (SharePoint/Stream URLs or local folders) and returns structured intelligence — transcript, relevant screenshots, AI analysis — for use by downstream agents and skills.

**This MCP is an intelligence extraction layer, not an action layer.** It never creates work items or documents. Other tools (Azure DevOps MCP, Wiki.js MCP, ADO skills) consume its output.

---

## Architecture

```
You (or your agent/skill)
  → process_recording_url / process_recording_folder
      → Azure CLI / MSAL (auth: az login → app registration → local folder)
      → yt-dlp (video download)
      → SharePoint Graph API (transcript .vtt download, if accessible)
      → ffmpeg (smart screenshots: transcript-aligned + scene detection)
      → GitHub Copilot Vision (score + describe each screenshot)
      → Jaccard deduplication (remove visually redundant screenshots)
      → GitHub Copilot API (analyze transcript + screenshots → RecordingAnalysis)
      → returns RecordingAnalysis (cached locally)
  → inject_transcript        ← paste Teams auto-summary transcript manually
  → get_full_transcript      ← returns human-readable summary + full text
  → summarize_for_*          ← focused drafts for downstream agents
  → annotate_screenshot      ← add manual annotations (rect, text, marker, arrow)
  → smart_annotate_screenshot ← AI auto-detects elements and annotates
  → locate_ui_elements       ← detect UI element positions for custom annotation
  → hand off to Azure DevOps MCP / Wiki.js / any other tool
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
# Required: GitHub token with models/Copilot access
GITHUB_TOKEN=ghp_...

# Optional: Azure app registration for SharePoint URL downloads
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**Auth priority (automatic fallback chain):**
1. `az login` (Azure CLI) — no config needed, just be logged in
2. App registration (`AZURE_TENANT_ID` + `AZURE_CLIENT_ID`) — interactive browser OAuth
3. Local folder (`process_recording_folder`) — no auth needed, download the files manually

**Getting AZURE_CLIENT_ID** (optional): Register an app in [Azure Portal → App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps).
- Platform: Mobile and desktop applications
- Redirect URI: `https://login.microsoftonline.com/common/oauth2/nativeclient`
- API permissions: `Files.Read.All`, `Sites.Read.All`, `User.Read` (all Delegated)

### 3. Register in your MCP client (VS Code / Copilot CLI)

Add to `.vscode/mcp.json` or `~/.copilot/mcp.json`:

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

## MCP Tools (13 total)

### Recording pipeline

| Tool | Input | Returns |
|---|---|---|
| `process_recording_url` | SharePoint/Stream URL | `RecordingAnalysis` |
| `process_recording_folder` | Local folder path | `RecordingAnalysis` |
| `get_recording_analysis` | Recording ID | Cached `RecordingAnalysis` |
| `list_recordings` | — | List of cached recordings |

### Transcript

| Tool | Input | Returns |
|---|---|---|
| `inject_transcript` | Recording ID + transcript text | Re-analyzed `RecordingAnalysis` |
| `get_full_transcript` | Recording ID | Human-readable summary + full VTT text + action items |

Transcripts are auto-downloaded from SharePoint when possible. If that fails (tenant restriction), paste the Teams auto-generated transcript into `inject_transcript` — the analysis will re-run with the full transcript and produce timestamped, language-aware output.

### Summarizers (for downstream agents)

| Tool | Input | Returns |
|---|---|---|
| `summarize_for_user_story` | Recording ID | `UserStorySummary` — title, acceptance criteria, story points |
| `summarize_for_bug_report` | Recording ID | `BugReportSummary` — repro steps, severity, expected vs actual |
| `summarize_for_documentation` | Recording ID | `DocumentationSummary` — structured doc with sections |
| `summarize_for_feedback` | Recording ID | `FeedbackSummary` — issues list with priorities |

### Screenshot annotation

| Tool | Input | Returns |
|---|---|---|
| `annotate_screenshot` | Image path + annotations array | Annotated image path |
| `smart_annotate_screenshot` | Image path + focus description | Annotated image (AI auto-positions) |
| `locate_ui_elements` | Image path + focus | Detected elements + coordinates + suggested annotations |

---

## RecordingAnalysis schema

```typescript
{
  id: string,
  title: string,
  duration: string,             // "01:23:45"
  humanReadableSummary: string, // timestamped bullet points (like Teams auto-summary)
  transcript: [{ start, end, speaker, text }],
  screenshots: [{ id, timestamp, filePath, relevanceScore, description, tags }],
  analysis: {
    summary: string,
    keyPoints: string[],
    issues: [{ title, description, severity, timestamp, screenshotIds }],
    features: [{ title, description, timestamp, screenshotIds }],
    decisions: [{ summary, context, timestamp }],
    actionItems: [{ title, assignee, priority, context, timestamp }],
    speakers: string[],
    sentiment: "positive" | "neutral" | "mixed" | "negative",
    topics: string[]
  }
}
```

---

## Screenshot annotation types

`annotate_screenshot` accepts an array of annotation objects:

```jsonc
// Rectangle — highlight a region
{ "type": "rect", "x": 100, "y": 200, "width": 400, "height": 80,
  "color": "#ff3b30", "label": "Bug here", "fill": true, "strokeWidth": 3 }

// Text note — with dark background for readability
{ "type": "text", "x": 500, "y": 150, "text": "Should be grouped\nwith section above",
  "color": "#ffcc00", "fontSize": 18 }

// Numbered marker — circle pin for step-by-step reference
{ "type": "marker", "x": 350, "y": 420, "number": 1, "color": "#007aff" }

// Arrow — point from one thing to another
{ "type": "arrow", "fromX": 600, "fromY": 300, "toX": 400, "toY": 250,
  "color": "#ff9500", "strokeWidth": 3 }
```

The original screenshot is always preserved. Annotated images are saved as `<original>_annotated.png`.

**`smart_annotate_screenshot`** uses GPT-4o Vision with a grid-based localization strategy to auto-detect element positions — useful for large sections and groups. For precise field-level annotation, use `locate_ui_elements` to get coordinates, then fine-tune with `annotate_screenshot`.

---

## Screenshot intelligence

Screenshots are extracted in two phases:

1. **Transcript-aligned** — one screenshot per transcript segment boundary (captures the moment a new topic is discussed)
2. **Scene change detection** — ffmpeg detects visual transitions (threshold 0.3), catching UI changes between segments

After extraction, each screenshot is:
- Scored by GPT-4o Vision (0–1 relevance score)
- Filtered (≥ 0.3 kept, max 20)
- **Deduplicated** via Jaccard similarity on description words + tags — removes visually redundant frames showing the same UI state

---

## Usage examples

### Create a user story from a recording
```
1. process_recording_url("https://company.sharepoint.com/...")
2. inject_transcript(id, "<paste Teams transcript>")   ← if auto-download fails
3. summarize_for_user_story(id)
4. Azure DevOps MCP → create_work_item(type: "User Story", ...)
```

### Document a meeting in Wiki.js
```
1. process_recording_folder("C:/recordings/architecture-review")
2. inject_transcript(id, "<transcript>")
3. summarize_for_documentation(id)
4. Wiki.js MCP → create_page(title, content)
```

### Test session → bug reports with annotated screenshots
```
1. process_recording_url("https://...")
2. inject_transcript(id, "<transcript>")
3. summarize_for_feedback(id)                         ← get issue list
4. smart_annotate_screenshot(screenshot_path,         ← annotate each bug
     "highlight the field with the wrong value")
5. Azure DevOps MCP → create_work_item(type: "Bug", attachments: [annotated_path])
```

---

## Plan B: local folder

If SharePoint URL access fails, download the recording manually from Teams:
1. In Teams, go to the meeting recording
2. Click **Download** → save the `.mp4`
3. Click **...** → **Open transcript** → **Download (.vtt)**
4. Put both files in a folder, e.g., `C:\recordings\sprint-demo`
5. Call `process_recording_folder("C:/recordings/sprint-demo")`

---

## Skill template

See [`skills/recording-analyzer.skill.md`](skills/recording-analyzer.skill.md) for a reusable Copilot skill that orchestrates this MCP with Azure DevOps, Wiki.js, and other tools.

---

## Caching

Processed analyses are cached in `.recordings-cache/` as JSON files (keyed by content hash of the source URL/path). Re-calling `process_recording_url` with the same URL returns instantly from cache. Use `force_reprocess: true` to re-run.

---

## Future plans

### Improved screenshot annotation accuracy

The current `smart_annotate_screenshot` uses GPT-4o Vision with a grid overlay for element localization. While good for large sections, it has limitations for precise field-level annotation in dense UIs. Two planned improvements:

#### Option A: Azure Computer Vision OCR
Use Azure AI Vision's Read API to extract all text blocks with **exact bounding boxes** from the screenshot. When asked to annotate "DW Username field", the OCR result tells us exactly where the text "DW Username" appears — no estimation needed. Requires a free Azure Computer Vision resource (5,000 free calls/month).

```
screenshot → Azure CV OCR → text + bounding boxes
           → match requested element to text block
           → annotate at exact coordinates
```

#### Option B: OmniParser (Microsoft Research)
[OmniParser](https://github.com/microsoft/OmniParser) is an open-source UI grounding model purpose-built for screenshots. It returns bounding boxes for every interactive element (buttons, fields, checkboxes, icons) with ~98% accuracy — regardless of whether they have visible text labels.

Run locally:
```bash
git clone https://github.com/microsoft/OmniParser
cd OmniParser
python gradio_demo.py   # starts REST API on localhost:7861
```

The MCP would then call `http://localhost:7861` with the screenshot and element name, and receive precise coordinates. Best choice when you need icon/button detection beyond what OCR can provide.
