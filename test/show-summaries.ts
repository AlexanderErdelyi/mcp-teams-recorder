import "dotenv/config";
import { loadAnalysis } from "../src/services/cache";
import { summarizeForUserStory, summarizeForBugReport, summarizeForDocumentation, summarizeForFeedback } from "../src/services/summarizers";

const id = process.argv[2] ?? "52df7054a6d2f5af";
const a = loadAnalysis(id);
if (!a) { console.log("Analysis not found for id: " + id); process.exit(1); }

console.log("\n========== USER STORY ==========");
console.log(JSON.stringify(summarizeForUserStory(a), null, 2));

console.log("\n========== BUG REPORT ==========");
console.log(JSON.stringify(summarizeForBugReport(a), null, 2));

console.log("\n========== DOCUMENTATION ==========");
console.log(JSON.stringify(summarizeForDocumentation(a), null, 2));

console.log("\n========== FEEDBACK ==========");
console.log(JSON.stringify(summarizeForFeedback(a), null, 2));
