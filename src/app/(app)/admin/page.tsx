export const dynamic = "force-dynamic";

import { requirePagePermission } from "@/lib/auth/page-guard";
import { AdminClient } from "@/components/admin/admin-client";

export default async function AdminPage() {
  const caller = await requirePagePermission("admin");
  return <AdminClient currentUserId={caller.id} />;
}
