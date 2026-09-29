export const dynamic = "force-dynamic";

import { requirePagePermission } from "@/lib/auth/page-guard";

// The Export page is a client component, so its server-side guard lives here: without it, anyone
// logged in could open the page by typing the address even though the sidebar hides it.
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePagePermission("export");
  return children;
}
