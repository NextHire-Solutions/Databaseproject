// Railway cron-service entrypoint: runs the provider syncs AND the MasterInbox reply pull,
// in order, then exits.
//
// This replaced `node scripts/cron-bison-sync.mjs` as the bison-cron service's start command when
// Instantly was connected, so one cron service covers both providers on the same 6-hourly schedule
// rather than adding a second service that could drift out of step.
//
// The two scripts are spawned as child processes rather than imported: each one uses top-level
// await and calls process.exit(), so importing the first would end the run before the second
// started.
//
// They are INDEPENDENT on purpose. Bison runs first (it was here first, and its own lead mirror is
// fire-and-forget so the request returns quickly), but Instantly runs whether or not Bison
// succeeded -- an EmailBison API outage must not stop reply data arriving from Instantly. The exit
// code is non-zero if EITHER failed, so Railway still shows the run as failed and the other
// provider's result is not hidden by it.
//
// Env vars needed on the cron service (unchanged): CRON_TOKEN, optionally APP_URL.
import { spawnSync } from "child_process";

function run(label, file) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (r.error) {
    console.error(`${label} could not start:`, r.error.message);
    return 1;
  }
  const code = r.status ?? 1;
  console.log(`${label} exited ${code}`);
  return code;
}

const bison = run("bison-sync", "scripts/cron-bison-sync.mjs");
const instantly = run("instantly-sync", "scripts/cron-instantly-sync.mjs");
// Replies come from MasterInbox since 2026-09, not from the sequencer sweeps. Independent of the
// two above for the same reason they are independent of each other: a sequencer outage must not
// stop reply data arriving.
const replies = run("masterinbox-replies", "scripts/cron-masterinbox-replies.mjs");

console.log(`\nsummary: bison=${bison === 0 ? "ok" : "FAILED"} instantly=${instantly === 0 ? "ok" : "FAILED"} replies=${replies === 0 ? "ok" : "FAILED"}`);
process.exit(bison === 0 && instantly === 0 && replies === 0 ? 0 : 1);
