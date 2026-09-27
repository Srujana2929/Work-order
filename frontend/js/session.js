// The logged-in user (held in memory only) and a mirror of the server's
// permission table (backend/auth/rbac.py). This only decides what the UI
// shows - the API enforces every rule itself.

export const session = { user: null };

const PERMISSIONS = {
  "users:manage":            [],
  "users:list_technicians":  ["Supervisor"],
  "work_orders:view":        ["Supervisor", "Technician"],
  "work_orders:create":      ["Supervisor"],
  "work_orders:edit":        ["Supervisor"],
  "work_orders:assign":      ["Supervisor"],
  "work_orders:update_work": ["Technician"],
  "work_orders:log_costs":   ["Supervisor", "Technician"],
  "work_orders:verify":      ["Supervisor"],
  "work_orders:close":       ["Supervisor"],
  "work_orders:delete":      [],
  "machines:view":           ["Supervisor", "Technician"],
  "machines:manage":         ["Supervisor"],
  "machines:log_notes":      ["Supervisor", "Technician"],
  "dashboard:view":          ["Supervisor", "Technician"],
  "audit:view":              [],
};

export function can(permission) {
  const role = session.user && session.user.role;
  if (!role) return false;
  if (role === "Admin") return true;
  return (PERMISSIONS[permission] || []).includes(role);
}

export const isTechnician = () => session.user && session.user.role === "Technician";
export const isAdmin = () => session.user && session.user.role === "Admin";
