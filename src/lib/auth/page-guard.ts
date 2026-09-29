import { redirect } from "next/navigation";
import { getCaller, callerCan, type Caller } from "@/lib/auth/caller";
import type { Permission } from "@/lib/auth/permissions";

// Page-level guard for a server layout or page. The sidebar hiding an icon does not stop someone
// typing the address, so each restricted page checks here and sends anyone without permission
// back to Search. (A deactivated account lands on Search too, where the app layout shows the
// "account disabled" notice instead of the page.)
export async function requirePagePermission(...anyOf: Permission[]): Promise<Caller> {
  const caller = await getCaller();
  if (!caller) redirect("/login");
  if (!callerCan(caller, anyOf)) redirect("/search");
  return caller;
}
