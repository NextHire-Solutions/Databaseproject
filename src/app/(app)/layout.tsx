export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getCaller } from "@/lib/auth/caller";
import { TopBar } from "@/components/layout/top-bar";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { RoleProvider } from "@/lib/context/role-context";

function initialsOf(name: string | null, email: string): string {
  if (name && name.trim()) {
    const p = name.trim().split(/\s+/);
    return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || name[0].toUpperCase();
  }
  return (email[0] ?? "?").toUpperCase();
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Same resolver the API routes use, so what the screen shows and what the server allows
  // cannot drift apart.
  const caller = await getCaller();
  if (!caller) redirect("/login");

  // Deactivated accounts stay logged in but get nothing: every API route refuses them, so
  // rendering the app would only show a shell of failing requests.
  if (!caller.active) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f6f7f9]">
        <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center">
          <p className="text-sm font-medium text-neutral-900">This account has been disabled.</p>
          <p className="mt-1 text-sm text-neutral-500">Contact an administrator to restore access.</p>
        </div>
      </div>
    );
  }

  const role = caller.role ?? "viewer";

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar initials={initialsOf(caller.name, caller.email || "?")} email={caller.email} />
      <div className="flex min-h-0 flex-1">
        <SidebarNav role={role} />
        <RoleProvider role={role}>
          <main className="flex-1 overflow-auto bg-[#f6f7f9] p-5">{children}</main>
        </RoleProvider>
      </div>
    </div>
  );
}
