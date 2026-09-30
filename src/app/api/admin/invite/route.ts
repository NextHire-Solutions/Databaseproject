import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/api/log-audit";

interface InvitePayload {
  email: string;
  name?: string | null;
  role: string;
  password?: string;
}

export async function POST(request: NextRequest) {
  // Auth check
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Role check — only owner and admin can invite users
  const supabase = createAdminClient();
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || !["owner", "admin"].includes(profile.role)) {
    return NextResponse.json({ error: "Only owners and admins can invite users" }, { status: 403 });
  }

  let body: InvitePayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { email, name, role, password } = body;
  if (!email || !role) {
    return NextResponse.json({ error: "Email and role required" }, { status: 400 });
  }

  // The fallback pointed at database-renaissance-production, a DIFFERENT project's Railway app.
  // NEXT_PUBLIC_SITE_URL is set in production so the wrong value never shipped, but an invite sent
  // from an environment missing that var would have mailed a link to someone else's deployment.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://web-production-34f4a.up.railway.app";

  let data: { user: { id: string } | null };

  if (password?.trim()) {
    // Create user with password — they can log in immediately
    const result = await supabase.auth.admin.createUser({
      email,
      password: password.trim(),
      email_confirm: true,
      user_metadata: { role, full_name: name ?? null },
    });
    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }
    data = result.data;
  } else {
    // Invite user — Supabase sends a magic link email
    const result = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { role, full_name: name ?? null },
      redirectTo: `${siteUrl}/auth/callback?type=invite`,
    });
    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }
    data = result.data;
  }

  // Create user_profiles entry
  if (data.user) {
    const { error: profileError } = await supabase.from("user_profiles").upsert(
      {
        id: data.user.id,
        email,
        full_name: name ?? null,
        role,
        is_active: true,
        // 0124, fail-closed: a new manager/viewer sees NO clients until the owner ticks some
        // (Admin -> Users -> Clients). Owner/admin are always unrestricted.
        client_access: ["owner", "admin"].includes(role) ? "all" : "selected",
      },
      { onConflict: "id" }
    );

    if (profileError) {
      console.error("Profile upsert failed:", JSON.stringify(profileError));
      return NextResponse.json(
        { error: `Profile save failed: ${profileError.message} (code: ${profileError.code}, details: ${profileError.details})` },
        { status: 500 }
      );
    }
  }

  await logAudit({
    action: "User Invited",
    details: `User Email: ${email}, Role: ${role}`,
  });

  return NextResponse.json({ success: true, userId: data.user?.id });
}
