import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { RecordingAnalysis } from "../types/index";
import { RecordingAnalysisSchema } from "../types/schemas";

const CACHE_DIR = path.resolve(process.cwd(), ".recordings-cache");

function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheFilePath(id: string): string {
  return path.join(CACHE_DIR, `${id}.json`);
}

export function generateRecordingId(sourceRef: string): string {
  return crypto.createHash("sha256").update(sourceRef).digest("hex").slice(0, 16);
}

export function saveAnalysis(analysis: RecordingAnalysis): void {
  ensureCacheDir();
  fs.writeFileSync(cacheFilePath(analysis.id), JSON.stringify(analysis, null, 2), "utf-8");
}

export function loadAnalysis(id: string): RecordingAnalysis | null {
  const filePath = cacheFilePath(id);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return RecordingAnalysisSchema.parse(raw);
  } catch {
    return null;
  }
}

export function listCachedAnalyses(): Array<{ id: string; title: string; processedAt: string; source: string }> {
  ensureCacheDir();
  return fs
    .readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf-8"));
        return {
          id: raw.id ?? f.replace(".json", ""),
          title: raw.title ?? "Unknown",
          processedAt: raw.processedAt ?? "",
          source: raw.sourceRef ?? "",
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.processedAt.localeCompare(a.processedAt));
}

export function deleteAnalysis(id: string): boolean {
  const filePath = cacheFilePath(id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}


