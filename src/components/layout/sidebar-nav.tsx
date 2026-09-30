"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Users, Database, FileDown, Building2, Shield, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { hasPermission } from "@/types/auth";
import type { UserRole } from "@/types/auth";
import { createClient } from "@/lib/supabase/client";

const NAV = [
  { title: "Agent Search", href: "/search", icon: Users, minRole: "viewer" as UserRole },
  { title: "Import", href: "/import", icon: Database, minRole: "manager" as UserRole },
  { title: "Export", href: "/export", icon: FileDown, minRole: "salesperson" as UserRole },
  { title: "Clients", href: "/webhooks", icon: Building2, minRole: "admin" as UserRole },
];

export function SidebarNav({ role }: { role: UserRole }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const itemClass = (active: boolean) =>
    cn(
      "flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
      active ? "bg-brand/10 text-brand" : "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
    );

  return (
    <aside className="flex w-16 shrink-0 flex-col items-center gap-1.5 border-r border-[#ebecf0] bg-white py-3">
      {NAV.filter((i) => hasPermission(role, i.minRole)).map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} title={item.title} className={itemClass(active)}>
            <item.icon className="h-5 w-5" />
          </Link>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-1.5">
        {hasPermission(role, "admin") && (
          <Link href="/admin" title="Admin" className={itemClass(pathname.startsWith("/admin"))}>
            <Shield className="h-5 w-5" />
          </Link>
        )}
        <button type="button" onClick={signOut} title="Sign out" className={itemClass(false)}>
          <LogOut className="h-5 w-5" />
        </button>
      </div>
    </aside>
  );
}
