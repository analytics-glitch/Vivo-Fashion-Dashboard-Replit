// Who may SAVE the replenishment roster and trigger a redistribution.
// Everyone signed-in can still VIEW the owner columns; only admins and these
// two named operators may change/redistribute them. Mirrors the server-side
// allow-list in api_pg.py (_ROSTER_EDITOR_EMAILS / _can_manage_roster).
export const ROSTER_EDITOR_EMAILS = [
  "esthert@vivofashiongroup.com",
  "amos.kiliswa@vivofashiongroup.com",
];

export function canManageRoster(user) {
  if (!user) return false;
  if ((user.role || "").trim().toLowerCase() === "admin") return true;
  return ROSTER_EDITOR_EMAILS.includes((user.email || "").trim().toLowerCase());
}
