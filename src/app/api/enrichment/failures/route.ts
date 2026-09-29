import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { requirePermission } from "@/lib/api/require-permission";

interface StepEntry {
  step: string;
  ok: boolean;
  note?: string;
}

// Make raw provider errors readable: "https://api.openai.com/v1/responses -> 429: {...quota...}"
// -> "OpenAI (find_linkedin): out of credits / quota exceeded (429)".
function prettyReason(step: string, note: string): string {
  const provider = note.includes("openai.com") ? "OpenAI" : note.includes("betterenrich") ? "BetterEnrich" : note.includes("instantly") ? "Instantly" : note.includes("Bison") ? "EmailBison" : "";
  const status = /->\s*(\d{3})/.exec(note)?.[1];
  let what = "";
  if (/exceeded your current quota|billing/i.test(note)) what = "out of credits / quota exceeded";
  else if (status === "429") what = "rate limited";
  else if (/timeout|timed out/i.test(note)) what = "timed out";
  else what = note.replace(/^https?:\/\/\S+\s*->\s*\d*:?\s*/, "").replace(/\s+/g, " ").slice(0, 120);
  return `${provider ? provider + " " : ""}(${step}): ${what}${status ? ` [${status}]` : ""}`;
}

// Failed items of a batch, with human-readable reasons — feeds the Export page failure viewer.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("export");
  if (!gate.ok) return gate.response;

  const batchId = new URL(req.url).searchParams.get("batchId");
  if (!batchId) return NextResponse.json({ error: "batchId required" }, { status: 400 });

  const { rows } = await getPool().query(
    `select a.full_name, i.email, i.error, i.attempts, i.step_log
       from enrichment_items i
       join agents a on a.id = i.agent_id
      where i.batch_id = $1 and i.status = 'failed'
      order by a.full_name`,
    [batchId]
  );
  const failures = rows.map((r) => {
    const errSteps = ((r.step_log ?? []) as StepEntry[]).filter((s) => !s.ok);
    const reasons = errSteps.length
      ? [...new Set(errSteps.map((s) => prettyReason(s.step, s.note ?? "error")))]
      : [r.error ?? "unknown error"]; // push-stage failures store the reason in error directly
    return { full_name: r.full_name, email: r.email, attempts: r.attempts, reasons };
  });
  return NextResponse.json({ failures });
}
