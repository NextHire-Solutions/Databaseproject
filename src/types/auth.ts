export type UserRole = "owner" | "admin" | "manager" | "salesperson" | "viewer";

export interface UserProfile {
  id: string;
  full_name: string | null;
  email: string | null;
  role: UserRole;
  is_active: boolean;
  invited_by: string | null;
  created_at: string;
}

export const ROLE_HIERARCHY: Record<UserRole, number> = {
  owner: 5,
  admin: 4,
  manager: 3,
  salesperson: 2, // contractor salespeople: search + views + capped export, nothing else
  viewer: 1,
};

export function hasPermission(
  userRole: UserRole,
  requiredRole: UserRole
): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}
