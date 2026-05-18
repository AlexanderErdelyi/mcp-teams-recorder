import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";

// ─── Annotation types ────────────────────────────────────────────────────────

export interface RectAnnotation {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  /** CSS color string, e.g. "#ff0000" or "rgba(255,0,0,0.3)" */
  color?: string;
  /** Optional label rendered above the rectangle */
  label?: string;
  /** Stroke width in pixels (default 3) */
  strokeWidth?: number;
  /** Fill the rectangle semi-transparently? (default false = outline only) */
  fill?: boolean;
}

export interface TextAnnotation {
  type: "text";
  x: number;
  y: number;
  text: string;
  color?: string;
  fontSize?: number;
  /** Draw a contrasting background box behind the text (default true) */
  background?: boolean;
}

export interface MarkerAnnotation {
  type: "marker";
  x: number;
  y: number;
  /** Number shown inside the circle (1-99) */
  number: number;
  color?: string;
}

export interface ArrowAnnotation {
  type: "arrow";
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  color?: string;
  strokeWidth?: number;
}

export type Annotation =
  | RectAnnotation
  | TextAnnotation
  | MarkerAnnotation
  | ArrowAnnotation;

export interface AnnotateOptions {
  /** Path to the source screenshot */
  inputPath: string;
  /** Where to write the output. Defaults to <inputPath>_annotated.png */
  outputPath?: string;
  annotations: Annotation[];
}

export interface AnnotateResult {
  outputPath: string;
  annotationCount: number;
  widthPx: number;
  heightPx: number;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function annotateScreenshot(
  options: AnnotateOptions
): Promise<AnnotateResult> {
  const { inputPath, annotations } = options;

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Screenshot not found: ${inputPath}`);
  }

  const img = sharp(inputPath);
  const meta = await img.metadata();
  const W = meta.width ?? 1280;
  const H = meta.height ?? 720;

  const outputPath =
    options.outputPath ??
    buildAnnotatedPath(inputPath);

  // Build one SVG layer containing all annotations
  const svg = buildSvg(annotations, W, H);

  await img
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(outputPath);

  return { outputPath, annotationCount: annotations.length, widthPx: W, heightPx: H };
}

// ─── SVG builder ─────────────────────────────────────────────────────────────

function buildSvg(annotations: Annotation[], W: number, H: number): string {
  const elements = annotations.map(renderAnnotation).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="1" dy="1" stdDeviation="2" flood-color="rgba(0,0,0,0.6)"/>
    </filter>
  </defs>
  ${elements}
</svg>`;
}

function renderAnnotation(a: Annotation): string {
  switch (a.type) {
    case "rect":
      return renderRect(a);
    case "text":
      return renderText(a);
    case "marker":
      return renderMarker(a);
    case "arrow":
      return renderArrow(a);
  }
}

function renderRect(a: RectAnnotation): string {
  const color = a.color ?? "#ff3b30";
  const stroke = a.strokeWidth ?? 3;
  const { r, g, b } = hexToRgb(color);
  const fillAttr = a.fill
    ? `fill="rgba(${r},${g},${b},0.25)"`
    : `fill="none"`;

  let label = "";
  if (a.label) {
    const fontSize = 14;
    const padding = 4;
    const textW = a.label.length * fontSize * 0.6 + padding * 2;
    const textH = fontSize + padding * 2;
    const lx = a.x;
    const ly = a.y - textH - 2;
    label = `
      <rect x="${lx}" y="${Math.max(0, ly)}" width="${textW}" height="${textH}"
            fill="${color}" rx="3"/>
      <text x="${lx + padding}" y="${Math.max(fontSize, ly + fontSize + padding / 2)}"
            font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="bold"
            fill="white">${escapeXml(a.label)}</text>`;
  }

  return `${label}
    <rect x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}"
          ${fillAttr} stroke="${color}" stroke-width="${stroke}" rx="2"/>`;
}

function renderText(a: TextAnnotation): string {
  const color = a.color ?? "#ffcc00";
  const fontSize = a.fontSize ?? 16;
  const showBg = a.background !== false;
  const padding = 5;
  const lineHeight = fontSize * 1.3;

  // Support multi-line via \n
  const lines = a.text.split(/\\n|\n/);
  const textW = Math.max(...lines.map((l) => l.length)) * fontSize * 0.6 + padding * 2;
  const textH = lines.length * lineHeight + padding * 2;

  const bg = showBg
    ? `<rect x="${a.x - padding}" y="${a.y - fontSize - padding}"
             width="${textW}" height="${textH}"
             fill="rgba(0,0,0,0.7)" rx="4"/>`
    : "";

  const textLines = lines
    .map(
      (line, i) =>
        `<text x="${a.x}" y="${a.y + i * lineHeight}"
               font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="bold"
               fill="${color}" filter="url(#shadow)">${escapeXml(line)}</text>`
    )
    .join("\n");

  return `${bg}\n${textLines}`;
}

function renderMarker(a: MarkerAnnotation): string {
  const color = a.color ?? "#007aff";
  const r = 16;
  return `
    <circle cx="${a.x}" cy="${a.y}" r="${r}" fill="${color}" stroke="white" stroke-width="2"/>
    <text x="${a.x}" y="${a.y + 5}" text-anchor="middle"
          font-family="Arial,sans-serif" font-size="14" font-weight="bold"
          fill="white">${a.number}</text>`;
}

function renderArrow(a: ArrowAnnotation): string {
  const color = a.color ?? "#ff3b30";
  const sw = a.strokeWidth ?? 3;
  const dx = a.toX - a.fromX;
  const dy = a.toY - a.fromY;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return "";

  // Arrow head triangle
  const headLen = 14;
  const headAngle = 0.4;
  const angle = Math.atan2(dy, dx);
  const x1 = a.toX - headLen * Math.cos(angle - headAngle);
  const y1 = a.toY - headLen * Math.sin(angle - headAngle);
  const x2 = a.toX - headLen * Math.cos(angle + headAngle);
  const y2 = a.toY - headLen * Math.sin(angle + headAngle);

  return `
    <line x1="${a.fromX}" y1="${a.fromY}" x2="${a.toX}" y2="${a.toY}"
          stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>
    <polygon points="${a.toX},${a.toY} ${x1},${y1} ${x2},${y2}"
             fill="${color}"/>`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildAnnotatedPath(inputPath: string): string {
  const ext = path.extname(inputPath);
  const base = inputPath.slice(0, -ext.length);
  return `${base}_annotated.png`;
}

function hexToRgb(color: string): { r: number; g: number; b: number } {
  // Strip rgba(...) — just return 255,60,48 for red as fallback
  const hex = color.replace(/^#/, "");
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return { r: 255, g: 59, b: 48 }; // default red
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Vision-based element location ───────────────────────────────────────────

export interface DetectedElement {
  label: string;
  description: string;
  /** Bounding box in pixels */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Suggested annotation type for this element */
  suggestedAnnotationType: "rect" | "marker" | "text";
  /** Suggested color based on context (red=problem, green=ok, blue=info, yellow=note) */
  suggestedColor: string;
}

export interface LocateElementsResult {
  elements: DetectedElement[];
  imageWidth: number;
  imageHeight: number;
  /** Ready-to-use annotations array you can pass directly to annotateScreenshot */
  suggestedAnnotations: Annotation[];
}

/**
 * Analyze a screenshot with GPT-4o Vision to detect UI elements.
 * Uses a grid-based localization strategy for accuracy:
 *   1. Overlay a labeled grid (cols A-H, rows 1-8) on a downscaled copy
 *   2. Ask the model: "which grid cell(s) contain element X?"
 *   3. Compute pixel coordinates from grid cell boundaries — no guessing
 */
export async function locateUiElements(
  imagePath: string,
  focus?: string
): Promise<LocateElementsResult> {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Screenshot not found: ${imagePath}`);
  }

  const meta = await sharp(imagePath).metadata();
  const W = meta.width ?? 1280;
  const H = meta.height ?? 720;

  const { client, visionModel } = await getAnnotatorClient();

  // ── Step 1: build a downscaled grid image ───────────────────────────────────
  const COLS = 8;
  const ROWS = 12;  // finer vertical resolution for single-row fields
  const GW = 960;
  const GH = Math.round(H * (GW / W));
  const cellW = Math.round(GW / COLS);
  const cellH = Math.round(GH / ROWS);

  // Build SVG grid overlay: column labels A-H, row labels 1-8
  const colLetters = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const gridLines: string[] = [];

  // Vertical lines + column labels
  for (let c = 0; c <= COLS; c++) {
    const x = c * cellW;
    gridLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${GH}" stroke="rgba(255,0,0,0.4)" stroke-width="1"/>`);
    if (c < COLS) {
      gridLines.push(`<text x="${x + cellW / 2}" y="16" text-anchor="middle" font-family="monospace" font-size="13" font-weight="bold" fill="red">${colLetters[c]}</text>`);
    }
  }
  // Horizontal lines + row labels
  for (let r = 0; r <= ROWS; r++) {
    const y = r * cellH;
    gridLines.push(`<line x1="0" y1="${y}" x2="${GW}" y2="${y}" stroke="rgba(255,0,0,0.4)" stroke-width="1"/>`);
    if (r < ROWS) {
      gridLines.push(`<text x="8" y="${y + cellH / 2 + 5}" font-family="monospace" font-size="13" font-weight="bold" fill="red">${r + 1}</text>`);
    }
  }

  const gridSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${GW}" height="${GH}">${gridLines.join("")}</svg>`;

  const gridImgBuf = await sharp(imagePath)
    .resize(GW, GH)
    .composite([{ input: Buffer.from(gridSvg), top: 0, left: 0 }])
    .png()
    .toBuffer();
  const gridB64 = gridImgBuf.toString("base64");

  // ── Step 2: ask model to identify grid cells ────────────────────────────────
  const focusPrompt = focus
    ? `Task: "${focus}".`
    : "Identify the most significant UI elements on this page.";

  const gridPrompt = `${focusPrompt}

The image has a red grid overlay with columns A-H (left to right) and rows 1-8 (top to bottom).
Each cell is labeled — e.g. "A1" is top-left, "H8" is bottom-right.

For each element requested, identify which grid cells it occupies and return:
- fromCol/fromRow: top-left cell of the element  
- toCol/toRow: bottom-right cell of the element (can be same as from for single-cell elements)
- For GROUPING: return ONE entry covering all items that should be grouped together

Return ONLY valid JSON, no markdown:
{
  "elements": [
    {
      "label": "short name",
      "description": "what it is",
      "fromCol": "B", "fromRow": 3,
      "toCol": "D", "toRow": 3,
      "suggestedAnnotationType": "rect",
      "suggestedColor": "#ff3b30"
    }
  ]
}

Color guide: "#ff3b30"=red/problem, "#34c759"=green/good, "#007aff"=blue/info, "#ffcc00"=yellow/warning, "#af52de"=purple/grouping`;

  const resp = await client.chat.completions.create({
    model: visionModel,
    max_tokens: 1200,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: gridPrompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${gridB64}`, detail: "high" } },
      ],
    }],
  });

  const raw = resp.choices[0]?.message?.content ?? "{}";
  let parsed: { elements: Array<Record<string, unknown>> };
  try {
    const clean = raw.replace(/^```[a-z]*\n?/gm, "").replace(/```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`Vision model returned invalid JSON: ${raw.slice(0, 300)}`);
  }

  // ── Step 3: convert grid cells → pixel coordinates ─────────────────────────
  const fullCellW = W / COLS;
  const fullCellH = H / ROWS;

  const elements: DetectedElement[] = (parsed.elements ?? []).map((el) => {
    const fc = colLetters.indexOf(String(el["fromCol"] ?? "A").toUpperCase());
    const tc = colLetters.indexOf(String(el["toCol"] ?? el["fromCol"] ?? "A").toUpperCase());
    const fr = Math.max(0, Number(el["fromRow"] ?? 1) - 1); // 1-indexed → 0-indexed
    const tr = Math.max(0, Number(el["toRow"] ?? el["fromRow"] ?? 1) - 1);

    const fromColIdx = Math.max(0, fc < 0 ? 0 : fc);
    const toColIdx   = Math.min(COLS - 1, tc < 0 ? fromColIdx : tc);
    const fromRowIdx = Math.min(ROWS - 1, fr);
    const toRowIdx   = Math.min(ROWS - 1, tr);

    const px = Math.round(fromColIdx * fullCellW);
    const py = Math.round(fromRowIdx * fullCellH);
    const pw = Math.round((toColIdx - fromColIdx + 1) * fullCellW);
    const ph = Math.round((toRowIdx - fromRowIdx + 1) * fullCellH);

    return {
      label: String(el["label"] ?? ""),
      description: String(el["description"] ?? ""),
      x: px,
      y: py,
      width: Math.min(pw, W - px),
      height: Math.min(ph, H - py),
      suggestedAnnotationType: (el["suggestedAnnotationType"] as DetectedElement["suggestedAnnotationType"]) ?? "rect",
      suggestedColor: String(el["suggestedColor"] ?? "#007aff"),
    };
  });

  const fontSize   = Math.max(16, Math.round(H / 45));
  const strokeWidth = Math.max(4, Math.round(H / 200));

  const suggestedAnnotations: Annotation[] = elements.map((el, i) => {
    if (el.suggestedAnnotationType === "marker") {
      return {
        type: "marker" as const,
        x: el.x + Math.round(el.width / 2),
        y: el.y + Math.round(el.height / 2),
        number: i + 1,
        color: el.suggestedColor,
      };
    }
    if (el.suggestedAnnotationType === "text") {
      return {
        type: "text" as const,
        x: el.x,
        y: el.y + el.height + fontSize + 4,
        text: el.label,
        color: el.suggestedColor,
        fontSize,
      };
    }
    return {
      type: "rect" as const,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      color: el.suggestedColor,
      label: el.label,
      strokeWidth,
    };
  });

  return { elements, imageWidth: W, imageHeight: H, suggestedAnnotations };
}

/**
 * One-shot: analyze the screenshot, detect elements, apply annotations, save result.
 * This is the context-aware version — no manual coordinates needed.
 */
export async function smartAnnotateScreenshot(
  imagePath: string,
  focus?: string,
  outputPath?: string
): Promise<{ result: AnnotateResult; elements: DetectedElement[] }> {
  const located = await locateUiElements(imagePath, focus);
  const result = await annotateScreenshot({
    inputPath: imagePath,
    annotations: located.suggestedAnnotations,
    outputPath,
  });
  return { result, elements: located.elements };
}

// ─── Auth helper for annotator (mirrors copilotAnalyzer) ─────────────────────

async function getAnnotatorClient(): Promise<{ client: OpenAI; visionModel: string }> {
  const pat = process.env["GITHUB_TOKEN"];
  if (!pat) throw new Error("GITHUB_TOKEN env var required");
  const model = process.env["COPILOT_MODEL"] ?? "gpt-4o";
  const overrideUrl = process.env["COPILOT_API_URL"];
  if (overrideUrl) {
    return { client: new OpenAI({ baseURL: overrideUrl, apiKey: pat }), visionModel: model };
  }
  return {
    client: new OpenAI({ baseURL: "https://models.inference.ai.azure.com", apiKey: pat }),
    visionModel: model,
  };
}
