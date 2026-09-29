import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/require-permission";

// Reserved endpoint for future Instantly integration
// POST /api/integrations/instantly/push — Push leads directly to Instantly campaign
export async function POST(request: NextRequest) {
  const gate = await requirePermission("campaign.send");
  if (!gate.ok) return gate.response;

  return NextResponse.json(
    {
      error: "Not implemented yet",
      message: "This endpoint is reserved for future Instantly integration. It will push leads directly to an Instantly campaign.",
    },
    { status: 501 }
  );
}
