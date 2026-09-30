import type { UserRole } from "@/types/auth";

// What a person may do in the app — the ONE list every layer reads:
//
//   - API routes      refuse with 403 (src/lib/api/require-permission.ts). This is the layer that
//                     actually protects anything: every button is just a request to a route, and a
//                     route can be called directly without the button.
//   - pages           redirect to /search (src/lib/auth/page-guard.ts).
//   - the screen      hides sidebar icons and buttons (useCan in role-context). Cosmetic only.
//
// A role is a preset bundle of permissions. Per-user overrides will layer on top of the preset;
// because every check already goes through can(), they will apply everywhere without touching
// the routes again.
//
// Pure module — imported by both server and client code, so it must not import anything
// server-only.

export type Permission =
  | "search" //        Agent Search: results, filters, counts, agent and office profiles (read)
  | "views" //         saved views: create, edit, delete your own
  | "agents.edit" //   change agent records: agent-provided contact, Team Leader / Managing Broker tags
  | "export" //        CSV download, the Export page, enrichment results
  | "campaign.send" // push leads out: campaigns, enrichment, Clay, client portal (spends credit)
  | "import" //        the Import page, CSV upload
  | "clients" //       the Clients page: create and edit clients, run syncs
  | "admin"; //        the Admin page: users, API keys, MLS settings, backups

const ALL: readonly Permission[] = [
  "search",
  "views",
  "agents.edit",
  "export",
  "campaign.send",
  "import",
  "clients",
  "admin",
];

// Mirrors what the sidebar already showed each role (Import and Export from manager up, Clients
// and Admin from admin up), so no one's visible access changes — the server now agrees with it.
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  owner: ALL,
  admin: ALL,
  manager: ["search", "views", "agents.edit", "export", "campaign.send", "import"],
  // Contractor salespeople (CO-69): work the database and pull lists, but no sending, no
  // importing, no agent edits, and no client names (none of the CLIENT_LIST permissions).
  salesperson: ["search", "views", "export"],
  viewer: ["search", "views"],
};

// Fails closed: an unknown or missing role has no permissions.
export function can(role: UserRole | null | undefined, p: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(p) ?? false;
}

// True when the role holds at least one of the permissions.
export function canAny(role: UserRole | null | undefined, ps: readonly Permission[]): boolean {
  return ps.some((p) => can(role, p));
}

// Client names and campaign pickers are needed by more than one kind of work: the Clients page,
// choosing where to send leads, and choosing which client an import belongs to.
export const CLIENT_LIST: readonly Permission[] = ["clients", "campaign.send", "import"];

// CO-69: "They can export out of the DB up to 1000." Per-export row cap by role; null = no cap.
// Enforced server-side in /api/export/csv (requests over the cap are clamped, and the audit log
// records that they were), and roles WITH a cap are also refused the stored-exports download
// endpoint, since a stored file can be any size.
export const EXPORT_ROW_CAP: Partial<Record<UserRole, number>> = {
  salesperson: 1000,
};

export function exportCapFor(role: UserRole | null | undefined): number | null {
  if (!role) return null;
  return EXPORT_ROW_CAP[role] ?? null;
}
