# Teams Recording Analyzer Skill

## Purpose
This skill teaches a Copilot agent how to use the `mcp-teams-recorder` MCP server to extract intelligence from Teams recordings, then hand off to the right downstream tools.

The MCP **never creates work items or documents itself** — it returns structured data. This skill bridges the gap by deciding what to do with the analysis.

---

## When to use this skill
Use this skill when the user:
- Pastes a Teams recording URL (SharePoint/Stream)
- Says "analyze this recording"
- Wants to create user stories, bugs, tasks, or docs from a meeting
- Shares a folder with a video + transcript
- Describes a test session and wants feedback converted to work items

---

## Step-by-step flow

### 1. Get the recording input
Ask the user: SharePoint/Stream URL, or local folder path?

- If URL → call `process_recording_url(url)`
- If folder → call `process_recording_folder(folder_path)`
- If already processed → call `list_recordings()` to find ID, then `get_recording_analysis(id)`

### 2. Show a brief summary
Once you have the RecordingAnalysis, show the user:
- Title, duration, speakers
- 3-5 key points
- Number of issues, features, action items found

### 3. Ask what they want to do
Offer these options (multiple can be selected):
- **User Story** → `summarize_for_user_story(id)` → pass to Azure DevOps MCP
- **Bug Report** → `summarize_for_bug_report(id)` → pass to Azure DevOps MCP
- **Test Feedback** → `summarize_for_feedback(id)` → creates multiple Bug/Task items via Azure DevOps MCP
- **Documentation** → `summarize_for_documentation(id)` → pass to Wiki.js MCP or Azure DevOps Wiki MCP
- **Just give me the raw analysis** → return full RecordingAnalysis JSON

### 4. Hand off to downstream tools

#### Creating a User Story in Azure DevOps:
```
summary = summarize_for_user_story(recording_id)
→ Use Azure DevOps MCP: create_work_item(
    type: "User Story",
    title: summary.title,
    description: format_as_user_story(summary),
    tags: summary.tags
  )
```

#### Creating a Bug in Azure DevOps:
```
bug = summarize_for_bug_report(recording_id)
→ Use Azure DevOps MCP: create_work_item(
    type: "Bug",
    title: bug.title,
    severity: bug.severity,
    description: format_as_bug(bug),
    reproSteps: bug.stepsToReproduce.join("\n")
  )
```

#### Creating documentation in Wiki.js:
```
docs = summarize_for_documentation(recording_id)
→ Use Wiki.js MCP: create_page(
    title: docs.title,
    content: format_as_markdown(docs.outline)
  )
```

#### Creating documentation in Azure DevOps Wiki:
```
docs = summarize_for_documentation(recording_id)
→ Use Azure DevOps Wiki MCP: create_or_update_page(
    path: /Recordings/${docs.title},
    content: format_as_markdown(docs.outline)
  )
```

#### Creating multiple items from test feedback:
```
feedback = summarize_for_feedback(recording_id)
→ For each bug in feedback.issues:
    Use Azure DevOps MCP: create_work_item(type: "Bug", ...)
→ For each suggestion in feedback.suggestions:
    Use Azure DevOps MCP: create_work_item(type: "Task", ...)
```

---

## Formatting helpers

### User Story description (Markdown)
```
**As a** {summary.asA}
**I want** {summary.iWant}
**So that** {summary.soThat}

### Acceptance Criteria
{summary.acceptanceCriteria.map(c => `- ${c}`).join('\n')}

### Related Screenshots
{summary.relatedScreenshots.join('\n')}

*Source: Recording ID {summary.recordingId}*
```

### Bug description (Markdown)
```
## Steps to Reproduce
{bug.stepsToReproduce.map((s, i) => `${i+1}. ${s}`).join('\n')}

## Expected Behavior
{bug.expectedBehavior}

## Actual Behavior
{bug.actualBehavior}

## Screenshots
{bug.relatedScreenshots.join('\n')}

## Context
{bug.context}
```

### Documentation page (Markdown)
```
{docs.outline.map(section => `## ${section.heading}\n\n${section.content}`).join('\n\n')}

---
*Generated from recording: {docs.recordingId}*
```

---

## Important notes

1. **Screenshots are local file paths** — if creating work items in Azure DevOps, upload screenshots as attachments first using ADO attachment API, then reference them.
2. **The analysis is cached** — re-running `process_recording_url` with the same URL returns instantly from cache unless `force_reprocess: true`.
3. **No transcript = degraded quality** — if no `.vtt` or `.docx` transcript is found, analysis quality drops. Encourage users to download the Teams transcript.
4. **GitHub Copilot Vision** is used for screenshot scoring — requires a valid `GITHUB_TOKEN` with Copilot access.

---

## Example prompts this skill handles

- *"Here's my sprint review recording: https://company.sharepoint.com/..."*
- *"I recorded a test session, here's the folder: C:\recordings\sprint-test*"
- *"Create user stories from last week's planning meeting recording"*
- *"I found bugs while testing, convert my recording to bug reports in ADO"*
- *"Document what was discussed in this architecture meeting"*
- *"Analyze this recording and tell me what needs to be done"*
