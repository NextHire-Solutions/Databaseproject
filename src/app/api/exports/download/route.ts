import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api/require-permission";
import { exportCapFor } from "@/lib/auth/permissions";

export async function GET(request: NextRequest) {
  const gate = await requirePermission("export");
  if (!gate.ok) return gate.response;
  // stored export files can be any size, so a role with a row cap doesn't get them
  if (exportCapFor(gate.user.role)) {
    return NextResponse.json({ error: "Not available for this account." }, { status: 403 });
  }

  const filePath = request.nextUrl.searchParams.get("file");
  if (!filePath) {
    return NextResponse.json({ error: "Missing file parameter" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.storage
    .from("exports")
    .createSignedUrl(filePath, 3600);

  if (error || !data?.signedUrl) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to generate download link" },
      { status: 500 }
    );
  }

  return NextResponse.json({ url: data.signedUrl });
}
