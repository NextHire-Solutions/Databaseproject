import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/api/log-audit";
import { requirePermission } from "@/lib/api/require-permission";

export async function POST(request: NextRequest) {
  // Admin-only: this used to be open to any logged-in user, who could fire a reset email at any
  // account and put whatever name they liked in the audit log (performedBy came from the body).
  const gate = await requirePermission("admin");
  if (!gate.ok) return gate.response;

  const supabase = createAdminClient();

  let body: { userId: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { userId } = body;
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  // Get user email
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("email")
    .eq("id", userId)
    .single();

  if (!profile?.email) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Send password reset email.
  //
  // NOT request.nextUrl.origin: on Railway the app sits behind a proxy and that resolves to the
  // INTERNAL container origin (localhost:8080), so the emailed link pointed somewhere the
  // recipient's browser cannot reach. auth/callback/route.ts:10-12 already works around this by
  // reading x-forwarded-host; here the configured public URL is simpler and canonical.
  //
  // The target is /auth/callback?type=recovery, matching the self-service reset on the login page.
  // The old /login target relied on that page's hash handler, which routes invite and recovery
  // alike to /accept-invite -- an "accept your invitation" screen shown to an existing user who
  // asked to reset a password. The callback sends recovery to /set-password, which is the page
  // that actually means it.
  //
  // NOTE: this only works once the redirect is allowlisted in Supabase (Authentication -> URL
  // Configuration). If it is not, Supabase silently falls back to its Site URL and the link goes
  // wherever that points, which is how these emails ended up on localhost:3000.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin;
  const { error } = await supabase.auth.resetPasswordForEmail(profile.email, {
    redirectTo: `${siteUrl}/auth/callback?type=recovery`,
  });

  if (error) {
    // Supabase's own wording for a 429 here is "email rate limit exceeded", which reads like a
    // bug rather than a quota. The built-in SMTP allows only a handful of auth emails per hour, so
    // a few reset attempts in a row genuinely exhaust it. Say what to do about it, and pass the
    // status through instead of flattening every failure to a 500.
    const status = (error as { status?: number }).status ?? 500;
    const message =
      status === 429
        ? "Supabase's email rate limit is exhausted — it allows only a few auth emails per hour. Wait an hour and retry, or set a custom SMTP provider in Supabase to raise the limit."
        : error.message;
    return NextResponse.json({ error: message }, { status });
  }

  await logAudit({
    action: "Password Reset",
    performedBy: gate.user.email, // who is actually logged in — never taken from the request body
    details: `User Email: ${profile.email}`,
  });

  return NextResponse.json({ success: true });
}
