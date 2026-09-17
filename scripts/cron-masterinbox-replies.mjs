// Railway cron-service entrypoint: pulls REPLIES from the MasterInbox Supabase into
// agent_replies by pinging /api/cron/masterinbox-replies, then exits.
//
// This is the source of the "Replied" flag since 2026-09. It replaced the sequencer replied
// sweeps, which lost a reply whenever its campaign was deleted (the mirror rows are pruned to
// the live campaign list). agent_replies is append-only, so a reply survives any sequencer
// housekeeping. MasterInbox is read for replies ONLY — campaign membership, campaign names and
// bounces still come from the bison/instantly syncs.
//
// Env vars needed on the cron service:
//   CRON_TOKEN  — same value as the web service's CRON_TOKEN
//   APP_URL     — optional; defaults to the production web URL
// (MASTERINBOX_URL / MASTERINBOX_SERVICE_KEY live on the WEB service, which does the fetching.)

const APP_URL = process.env.APP_URL || "https://web-production-34f4a.up.railway.app";
const token = process.env.CRON_TOKEN;

if (!token) {
  console.error("CRON_TOKEN is not set on this service.");
  process.exit(1);
}

try {
  const res = await fetch(`${APP_URL}/api/cron/masterinbox-replies`, {
    method: "POST",
    headers: { "x-cron-token": token },
  });
  const body = await res.text();
  console.log(`masterinbox-replies -> HTTP ${res.status}: ${body}`);
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error("masterinbox-replies failed:", e instanceof Error ? e.message : e);
  process.exit(1);
}
