// The enrichment flow.
//
// ============================== CURRENT FLOW (v2, Sep 2026) ==============================
// Client-directed rebuild ("scratch this and use MillionVerifier / don't search personal"):
//
//   1. Preferred email present -> verify with MillionVerifier. result "ok" -> USE IT.
//   2. Otherwise (no email, or verification failed) -> WORK-EMAIL enrichment only:
//        company domain (worker-supplied from our own DB; OpenAI lookup as fallback)
//        -> BetterEnrich work finder -> MillionVerifier again. "ok" -> use, else no email.
//   3. PERSONAL-EMAIL SEARCH IS RETIRED (LinkedIn hunt + BetterEnrich personal): the client
//      may want it back, so the whole legacy flow is preserved below as enrichAgentLegacy —
//      switching back is re-pointing the enrichAgent export, nothing else.
//   Safe verdict = MillionVerifier result "ok" ONLY (catch_all/unknown/risky are not sent).
//
// ============================ LEGACY FLOW (Jul-Sep 2026, kept) ============================
// An exact replica of the client's Clay table, decoded column by column
// from screenshots (July 2026). Two branches, gated on whether Courted gave a preferred email:
//
//   BRANCH A — "No Emails -> Enrich Both" (no preferred email):
//     Find LinkedIn (AI web research) -> BetterEnrich personal email -> Instantly verify
//     -> if not safe: Find Domain (AI web research) -> BetterEnrich work email -> Instantly verify
//     -> Final Email = safe personal, else safe professional, else none.
//
//   BRANCH B — "FLOW: Both Emails -> Priority Pro -> Enrich Both" (preferred email exists):
//     Split preferred email into personal vs professional by domain list.
//     Personal track: verify Courted personal; if missing/invalid -> LinkedIn -> BetterEnrich
//       personal -> verify. Final Personal = BE result || Courted.
//     Professional track: verify Courted professional; if personal not safe AND courted
//       professional not valid -> Find Domain -> BetterEnrich work -> verify.
//       Final Professional = BE work || Courted professional.
//     Final Email = safe personal first, else safe professional (personal priority).
//
// Providers (env keys):
//   BETTERENRICH_API_KEY     — find-work-email-low-cost-v2-alt (v2); personal finder legacy-only
//   MILLIONVERIFIER_API_KEY  — v2 verification (replaces Instantly)
//   OPENAI_API_KEY           — OPTIONAL in v2: domain lookup fallback when our DB has no domain
//   INSTANTLY_API_KEY        — legacy flow only, no longer required

const env = process.env;

// Clay's personal-domain list, verbatim.
const PERSONAL_DOMAINS = [
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "comcast.net",
  "icloud.com", "me.com", "live.com", "msn.com", "proton.me", "protonmail.com",
  "yandex.com", "zoho.com", "rediffmail.com", "gmx.com", "mail.com", "inbox.com",
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Clay's safe-status list ("Safe to Send" formulas). The group-1 variant checked =="verified"
// only; the FLOW variant checks this list — we normalize on the broader list for both branches.
const SAFE_STATUSES = ["valid", "verified", "ok", "deliverable"];

const lc = (s) => (s ?? "").toLowerCase();
const isPersonalEmail = (e) => EMAIL_RE.test(lc(e)) && PERSONAL_DOMAINS.some((d) => lc(e).endsWith("@" + d));
const isProfessionalEmail = (e) => EMAIL_RE.test(lc(e)) && !PERSONAL_DOMAINS.some((d) => lc(e).endsWith("@" + d));
const isSafe = (status) => SAFE_STATUSES.includes(lc(status));

export function providersConfigured() {
  // v2: MillionVerifier + BetterEnrich. OpenAI is optional (domain-lookup fallback only);
  // Instantly is legacy-only. Until MILLIONVERIFIER_API_KEY is set on the worker, the enrich
  // stage idles safely (items wait as pending) rather than running the retired flow.
  return !!(env.BETTERENRICH_API_KEY && env.MILLIONVERIFIER_API_KEY);
}

// Legacy gate, kept for a switch-back (see enrichAgentLegacy).
export function legacyProvidersConfigured() {
  return !!(env.BETTERENRICH_API_KEY && env.INSTANTLY_API_KEY && env.OPENAI_API_KEY);
}

// ---------------------------------------------------------------------------
// Small helpers: timed fetch with retry/backoff on 429/5xx (Clay's own run showed the
// domain step dying on rate limits — retries are how we do better than the original).
// ---------------------------------------------------------------------------
async function jsonFetch(url, opts, { tries = 3, timeoutMs = 60000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* keep raw */ }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${url} -> ${res.status}: ${text.slice(0, 150)}`);
      } else if (!res.ok) {
        const err = new Error(`${url} -> ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err; // non-retryable 4xx
      } else {
        return json;
      }
    } catch (e) {
      if (e.status) throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw lastErr ?? new Error(`${url} failed`);
}

// Providers hide their response field names — scan common ones, then any email-looking string.
function pickEmail(json) {
  if (!json || typeof json !== "object") return null;
  const flat = JSON.stringify(json);
  for (const k of ["email", "personal_email", "work_email", "professional_email", "result"]) {
    const m = flat.match(new RegExp(`"${k}"\\s*:\\s*"([^"]+@[^"]+)"`, "i"));
    if (m && EMAIL_RE.test(m[1])) return m[1].toLowerCase();
  }
  const any = flat.match(/"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})"/);
  return any && EMAIL_RE.test(any[1]) ? any[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// BetterEnrich (same endpoints + auth header style as the Clay HTTP columns)
// ---------------------------------------------------------------------------
const BE_BASE = "https://app.betterenrich.com/api/v1";
const beHeaders = () => ({ "content-type": "application/json", accept: "application/json", Authorization: env.BETTERENRICH_API_KEY });

async function bePersonalEmail(linkedinURL) {
  const j = await jsonFetch(`${BE_BASE}/find-personal-email-alt`, {
    method: "POST", headers: beHeaders(), body: JSON.stringify({ linkedinURL }),
  });
  return pickEmail(j);
}
async function beWorkEmail(full_name, company_domain) {
  const j = await jsonFetch(`${BE_BASE}/find-work-email-low-cost-v2-alt`, {
    method: "POST", headers: beHeaders(), body: JSON.stringify({ full_name, company_domain }),
  });
  return pickEmail(j);
}

// ---------------------------------------------------------------------------
// Instantly "Verify Email" (Clay column: Instantly > Verify Email). The verdict lives in
// `verification_status` — the API also returns `status: "success"` meaning "call worked",
// which must NOT be read as a verdict (verified live 2026-07-08).
// ---------------------------------------------------------------------------
async function instantlyVerify(email) {
  const headers = { Authorization: `Bearer ${env.INSTANTLY_API_KEY}`, "content-type": "application/json" };
  let status = null;
  // first call kicks off the verification ("pending"); re-POSTing the same email returns the
  // finished verdict (verified live 2026-07-08 — there is no working GET endpoint for this).
  for (let i = 0; i < 60; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000)); // 1s granularity — a verify often finishes in 1-3s and the old 3s poll wasted ~2s per round
    const j = await jsonFetch("https://api.instantly.ai/api/v2/email-verification", {
      method: "POST", headers, body: JSON.stringify({ email }),
    });
    status = j?.verification_status ?? status;
    if (status && lc(status) !== "pending") break;
  }
  return lc(status) || "unknown";
}

// ---------------------------------------------------------------------------
// MillionVerifier (v2 verifier). Single-check API; the verdict is `result`:
// ok | catch_all | unknown | disposable | invalid. Client decision (Sep 2026):
// ONLY "ok" is safe to send — catch_all raises bounce risk and is rejected.
// ---------------------------------------------------------------------------
async function millionVerify(email) {
  const j = await jsonFetch(
    `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(env.MILLIONVERIFIER_API_KEY)}&email=${encodeURIComponent(email)}&timeout=20`,
    { method: "GET" },
    { timeoutMs: 45000 }
  );
  const verdict = lc(j?.result) || "unknown";
  // surface quota exhaustion as an ERROR (cleanRun=false), never as a verdict — otherwise an
  // empty MV account would silently mark every lead unsendable and cache it
  if (verdict === "error" || /credit|api key/i.test(String(j?.error ?? ""))) {
    throw new Error(`MillionVerifier error: ${JSON.stringify(j).slice(0, 150)}`);
  }
  return verdict;
}
const isSafeMV = (verdict) => verdict === "ok";

// ---------------------------------------------------------------------------
// "Claygent" web research — GPT-4o Mini + web search via the OpenAI Responses API,
// prompts copied verbatim from the Clay columns.
// ---------------------------------------------------------------------------
async function openaiWebResearch(prompt, schemaName, schema) {
  const j = await jsonFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_RESEARCH_MODEL || "gpt-4o-mini",
      tools: [{ type: "web_search_preview" }],
      input: prompt,
      text: { format: { type: "json_schema", name: schemaName, schema, strict: true } },
    }),
  }, { timeoutMs: 120000 });
  const text =
    j?.output_text ??
    j?.output?.flatMap((o) => o?.content ?? []).find((c) => c?.type === "output_text")?.text;
  try { return JSON.parse(text); } catch { return null; }
}

async function findLinkedIn(agent) {
  const out = await openaiWebResearch(
    `Find the LinkedIn profile URL for this real estate professional.

Inputs:
Full Name: ${agent.full_name ?? ""}
Office: ${agent.office_name ?? ""}
Office City: ${agent.office_city ?? ""}

Search Google and find the most likely LinkedIn profile for the person.

Use search queries similar to these:
- site:linkedin.com/in/ "Full Name" "Office"
- site:linkedin.com/in/ "Full Name" "Office City"
- site:linkedin.com/in/ "Full Name" real estate
- site:linkedin.com/in/ "Full Name" realtor
- "Full Name" "Office" LinkedIn

Prioritize profiles where:
- The full name matches exactly or very closely
- The brokerage/company matches the Office field
- The profile is related to real estate, realtor, broker, mortgage, or property services

If multiple profiles exist, choose the strongest overall match based on name + brokerage similarity.

If no confident match exists, return blank.

Return only the LinkedIn profile URL and nothing else.`,
    "linkedin_result",
    {
      type: "object",
      properties: { linkedinProfileUrl: { type: "string", description: "The LinkedIn profile URL of the real estate professional or blank if not found" } },
      required: ["linkedinProfileUrl"],
      additionalProperties: false,
    }
  );
  const url = out?.linkedinProfileUrl?.trim();
  return url && /linkedin\.com\//i.test(url) ? url : null;
}

async function findDomain(agent) {
  const out = await openaiWebResearch(
    `You are finding the official website domain for a real estate brokerage office in ${agent.office_city ?? ""}.

Input:
- Office name: ${agent.office_name ?? ""}
- Office City: ${agent.office_city ?? ""}

Step 1: If Office is empty → return nothing and stop.
Step 2: If Office contains any of the following brand names, return the corresponding domain directly without searching and stop:
- "eXp Realty" → exprealty.com
- "Compass" → compass.com
- "Serhant" → serhant.com
- "Real Broker" → joinreal.com
- "Redfin" → redfin.com
- "Fathom Realty" → fathomrealty.com

Step 3: Search Google for: ${agent.office_name ?? ""} ${agent.office_city ?? ""} official website
Step 4: From the results, identify the official website for this specific office location,
not the national brand homepage. For example, prefer "century21titans.ca" over "century21.ca",
or "royallepagesignature.ca" over "royallepage.ca".
Step 5: Visit the URL to confirm:
- The page loads without a 404 or redirect to an unrelated site
- The company name or brand appears anywhere on the page
- The site is clearly about a real estate business (even a simple one-page site is fine — small brokerages rarely have listings or agent directories)

Do NOT reject a domain just because the site looks simple or lacks property listings.
Only reject if: the page is down, belongs to a completely different business, or is a generic directory listing (like Yelp, Zillow, or Yellow Pages) rather than the company's own website.

Step 6: If no dedicated office site is found, fall back to the national brand domain (e.g., century21.ca, royallepage.ca, kw.com).

Step 7: Return only the verified domain in this format: example.com No "https://", no "www.", no trailing slash. Nothing else.`,
    "domain_result",
    {
      type: "object",
      properties: { domain: { type: "string", description: "The verified official website domain for the real estate brokerage office, in the format example.com, without https://, www., or trailing slash." } },
      required: ["domain"],
      additionalProperties: false,
    }
  );
  const d = out?.domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  return d && d.includes(".") && !d.includes(" ") ? d : null;
}

// ---------------------------------------------------------------------------
// THE v2 FLOW (current). Returns { hit, cleanRun } like the legacy one, same step-trace
// contract, so the worker needs no changes beyond passing agent.office_domain.
//
//   has email -> MV verify -> ok? use : work-hunt
//   no email  -> work-hunt
//   work-hunt = domain (DB-first via agent.office_domain, OpenAI fallback)
//               -> BetterEnrich work finder -> MV verify -> ok? use : nothing
// ---------------------------------------------------------------------------
export async function enrichAgent(agent, log) {
  let errors = 0;
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const out = await fn();
      log.push({ step: name, ok: true, ms: Date.now() - t0, note: out == null || out === "" ? "miss" : String(out).slice(0, 120) });
      return out;
    } catch (e) {
      errors++;
      log.push({ step: name, ok: false, ms: Date.now() - t0, note: (e instanceof Error ? e.message : "error").slice(0, 200) });
      return null;
    }
  };

  const preferred = (agent.preferred_email ?? "").trim();
  let result = null;

  // 1) verify what we already have
  if (preferred) {
    const v = await step("verify_preferred_mv", () => millionVerify(preferred));
    if (isSafeMV(v)) {
      result = {
        email: preferred, status: v,
        provider: isPersonalEmail(preferred) ? "courted_personal" : "courted_professional",
      };
    }
  }

  // 2) work-email enrichment — the single funnel for BOTH no-email and failed-verify leads.
  //    Personal-email search is retired; see enrichAgentLegacy below to restore it.
  if (!result) {
    let domain = null;
    if (agent.office_domain) {
      domain = agent.office_domain;
      log.push({ step: "db_domain", ok: true, ms: 0, note: domain });
    } else if (env.OPENAI_API_KEY && agent.office_name) {
      domain = await step("find_domain", () => findDomain(agent));
    }
    const work = domain ? await step("be_work", () => beWorkEmail(agent.full_name, domain)) : null;
    if (work && lc(work) === lc(preferred)) {
      // the finder returned the exact email that just failed verification — don't pay to
      // re-verify a known-bad address
      log.push({ step: "verify_work_mv", ok: true, ms: 0, note: "same as failed preferred — skipped" });
    } else if (work) {
      const v2 = await step("verify_work_mv", () => millionVerify(work));
      if (isSafeMV(v2)) result = { email: work, status: v2, provider: "betterenrich_professional" };
    }
  }

  return { hit: result, cleanRun: errors === 0 };
}

// ---------------------------------------------------------------------------
// ============================= RETIRED, KEPT ON PURPOSE =============================
// The legacy flow (personal-email search + Instantly), retired Sep 2026 per client
// instruction "don't search for personal email". Kept fully intact — the client may want
// to switch back. To restore: export this as enrichAgent and use legacyProvidersConfigured.
// Returns { email, status, provider } | null, plus writes a step trace into `log`.
// Provider misses are just "miss" entries in the trace. A step that ERRORS (vs. missing)
// flips cleanRun=false via the `errors` counter so the caller never caches a not-found
// produced by an outage.
// ---------------------------------------------------------------------------
export async function enrichAgentLegacy(agent, log) {
  let errors = 0;
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const out = await fn();
      log.push({ step: name, ok: true, ms: Date.now() - t0, note: out == null || out === "" ? "miss" : String(out).slice(0, 120) });
      return out;
    } catch (e) {
      errors++;
      log.push({ step: name, ok: false, ms: Date.now() - t0, note: (e instanceof Error ? e.message : "error").slice(0, 200) });
      return null;
    }
  };

  const preferred = (agent.preferred_email ?? "").trim();
  let result = null;

  if (!preferred) {
    // ---------------- BRANCH A: "No Emails -> Enrich Both" ----------------
    const linkedin = agent.office_name ? await step("find_linkedin", () => findLinkedIn(agent)) : null;
    const personal = linkedin ? await step("be_personal", () => bePersonalEmail(linkedin)) : null;
    const personalStatus = personal ? await step("verify_personal", () => instantlyVerify(personal)) : null;
    if (personal && isSafe(personalStatus)) {
      result = { email: personal, status: personalStatus, provider: "betterenrich_personal" };
    } else {
      const domain = agent.office_name ? await step("find_domain", () => findDomain(agent)) : null;
      const work = domain ? await step("be_work", () => beWorkEmail(agent.full_name, domain)) : null;
      const workStatus = work ? await step("verify_work", () => instantlyVerify(work)) : null;
      if (work && isSafe(workStatus)) result = { email: work, status: workStatus, provider: "betterenrich_professional" };
    }
  } else {
    // ---------------- BRANCH B: "FLOW: Both Emails -> Priority Pro" ----------------
    const personalCourted = isPersonalEmail(preferred) ? preferred : "";
    const professionalCourted = isProfessionalEmail(preferred) ? preferred : "";

    // personal track
    const vPersonalCourted = personalCourted ? await step("verify_personal_courted", () => instantlyVerify(personalCourted)) : null;
    let personalBE = null, vPersonalBE = null;
    if ((!personalCourted || lc(vPersonalCourted) === "invalid") && agent.office_name) {
      const linkedin = await step("find_linkedin", () => findLinkedIn(agent));
      personalBE = linkedin ? await step("be_personal", () => bePersonalEmail(linkedin)) : null;
      vPersonalBE = personalBE ? await step("verify_personal_be", () => instantlyVerify(personalBE)) : null;
    }
    const finalPersonalStatus = vPersonalBE ?? vPersonalCourted; // BE result wins (Clay's merge order)
    const finalPersonalEmail = personalBE || personalCourted;
    const safePersonal = !!finalPersonalEmail && isSafe(finalPersonalStatus);

    // professional track
    const vProfCourted = professionalCourted ? await step("verify_professional_courted", () => instantlyVerify(professionalCourted)) : null;
    let workBE = null, vWorkBE = null;
    // Deliberate fix over Clay: hunt for a professional email ONLY when the Courted one isn't
    // safe. (Clay compared the verdict to "valid" — a word Instantly never returns — so its
    // hunt always ran, and a bad guessed email could override a perfectly verified one.)
    if (!safePersonal && agent.office_name && !(professionalCourted && isSafe(vProfCourted))) {
      const domain = await step("find_domain", () => findDomain(agent));
      workBE = domain ? await step("be_work", () => beWorkEmail(agent.full_name, domain)) : null;
      vWorkBE = workBE ? await step("verify_work_be", () => instantlyVerify(workBE)) : null;
    }
    const finalProfStatus = vWorkBE ?? vProfCourted;
    const finalProfEmail = workBE || professionalCourted;
    const safeProf = !!finalProfEmail && isSafe(finalProfStatus);

    // Final Email (2): personal priority
    if (safePersonal) {
      result = { email: finalPersonalEmail, status: finalPersonalStatus, provider: personalBE ? "betterenrich_personal" : "courted_personal" };
    } else if (safeProf) {
      result = { email: finalProfEmail, status: finalProfStatus, provider: workBE ? "betterenrich_professional" : "courted_professional" };
    }
  }

  return { hit: result, cleanRun: errors === 0 };
}
