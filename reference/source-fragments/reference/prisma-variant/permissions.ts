export type Role =
  | "SUPER_ADMIN" | "COMPANY_OWNER" | "GENERAL_MANAGER" | "FINANCE_MANAGER" | "ACCOUNTANT"
  | "INVENTORY_MANAGER" | "TRANSPORT_MANAGER" | "HR_MANAGER" | "DEPARTMENT_MANAGER" | "EMPLOYEE";
export type Module = "finance" | "inventory" | "fleet" | "hr" | "parties" | "reports" | "settings" | "users";
export type Action = "view" | "create" | "edit" | "delete" | "approve" | "export";

const ALL: Action[] = ["view", "create", "edit", "delete", "approve", "export"];
const RW: Action[] = ["view", "create", "edit", "export"];
const RO: Action[] = ["view"];
type Matrix = Partial<Record<Module, Action[]>>;
const EVERYTHING: Matrix = { finance: ALL, inventory: ALL, fleet: ALL, hr: ALL, parties: ALL, reports: ALL, settings: ALL, users: ALL };

export const PERMISSIONS: Record<Role, Matrix> = {
  SUPER_ADMIN: EVERYTHING,
  COMPANY_OWNER: EVERYTHING,
  GENERAL_MANAGER: { finance: [...RW, "approve"], inventory: [...RW, "approve"], fleet: [...RW, "approve"], hr: [...RW, "approve"], parties: RW, reports: ["view", "export"], users: RO },
  FINANCE_MANAGER: { finance: ALL, parties: RW, reports: ["view", "export"], inventory: RO },
  ACCOUNTANT: { finance: RW, parties: RO, reports: ["view", "export"] },
  INVENTORY_MANAGER: { inventory: ALL, parties: RW, reports: ["view", "export"] },
  TRANSPORT_MANAGER: { fleet: ALL, reports: ["view", "export"], inventory: ["view", "create"] },
  HR_MANAGER: { hr: ALL, reports: ["view", "export"] },
  DEPARTMENT_MANAGER: { inventory: ["view", "create", "approve"], finance: ["view", "approve"], hr: ["view", "approve"] },
  EMPLOYEE: { hr: ["view", "create"], inventory: ["create"] }, // own records only: enforce in queries
};

export function can(role: Role, module: Module, action: Action): boolean {
  return PERMISSIONS[role]?.[module]?.includes(action) ?? false;
}
