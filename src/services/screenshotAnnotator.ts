import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";

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
