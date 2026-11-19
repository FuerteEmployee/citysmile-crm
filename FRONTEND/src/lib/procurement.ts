// City Smile CRM: Procurement Types is a Kiran-only module and is off in this build.
export const isProcurementTypesEnabled = (_user?: any): boolean => false;

export const PROCUREMENT_TYPES = [
  { id: "ALL", label: "All Types" },
  { id: "READY", label: "Ready to Use" },
  { id: "JOBWORK", label: "Job Work" },
  { id: "MANUFACTURE", label: "Manufacturing by Self" },
] as const;

export type ProcurementType = "READY" | "JOBWORK" | "MANUFACTURE";
