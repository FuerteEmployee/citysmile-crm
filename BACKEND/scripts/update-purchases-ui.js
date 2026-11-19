const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "..", "..", "CRM-FRONTEND-NEW", "src", "pages", "Purchases.tsx");
let content = fs.readFileSync(filePath, "utf8");

// 1. Add imports
const importTarget = 'import { defaultPageSize } from "@/lib/tablePageSize";';
const importAddition = `import { defaultPageSize } from "@/lib/tablePageSize";
import { isProcurementTypesEnabled, PROCUREMENT_TYPES } from "@/lib/procurement";
import { procurementService } from "@/api/services/procurement.service";`;

if (!content.includes('from "@/lib/procurement"')) {
  content = content.replace(importTarget, importAddition);
}

// 2. Add emptyForm fields
const formTarget = `  sales_person: "",
  note: "",
};`;
const formAddition = `  sales_person: "",
  note: "",
  procurementType: "READY",
  locationId: "",
  categoryId: "",
  subcategoryId: "",
};`;

if (!content.includes('procurementType: "READY",')) {
  content = content.replace(formTarget, formAddition);
}

// 3. Add component state and queries
const stateTarget = `  const [vendorFilter, setVendorFilter] = useState<string[]>([]);
  const [branchFilter, setBranchFilter] = useState("all");`;

const stateAddition = `  const [vendorFilter, setVendorFilter] = useState<string[]>([]);
  const [branchFilter, setBranchFilter] = useState("all");
  const isKiran = isProcurementTypesEnabled();
  const [procurementTypeFilter, setProcurementTypeFilter] = useState<string>("ALL");
  const [factoryLocationFilter, setFactoryLocationFilter] = useState<string>("all");

  const { data: factoryLocations = [] } = useQuery<any[]>({
    queryKey: ["factory-locations"],
    queryFn: () => procurementService.listLocations().then((r: any) => r.locations || []),
    enabled: isKiran,
    staleTime: 5 * 60 * 1000,
  });`;

if (!content.includes("const isKiran = isProcurementTypesEnabled();")) {
  content = content.replace(stateTarget, stateAddition);
}

// 4. Update queryKey and queryFn
const queryKeyOld = `queryKey: ["purchases", itemsPerPage, currentPage, debouncedSearch, branchFilter, vendorFilter],`;
const queryKeyNew = `queryKey: ["purchases", itemsPerPage, currentPage, debouncedSearch, branchFilter, vendorFilter, procurementTypeFilter, factoryLocationFilter],`;

if (content.includes(queryKeyOld)) {
  content = content.replace(queryKeyOld, queryKeyNew);
}

const queryFnParamsOld = `        branch: branchFilter !== "all" ? branchFilter : undefined,
        vendor: vendorFilter.length ? vendorFilter.join(",") : undefined,
      });`;
const queryFnParamsNew = `        branch: branchFilter !== "all" ? branchFilter : undefined,
        vendor: vendorFilter.length ? vendorFilter.join(",") : undefined,
        type: isKiran && procurementTypeFilter !== "ALL" ? procurementTypeFilter : undefined,
        locationId: isKiran && factoryLocationFilter !== "all" ? factoryLocationFilter : undefined,
      });`;

if (content.includes(queryFnParamsOld)) {
  content = content.replace(queryFnParamsOld, queryFnParamsNew);
}

// 5. Add tabs above summary cards
const summaryCardsTarget = `{/* Summary cards */}`;
const tabsAddition = `{/* Procurement Types Tabs (Kiran Engineering) */}
        {isKiran && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 pb-3 bg-white p-3 rounded-xl shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              {PROCUREMENT_TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setProcurementTypeFilter(t.id);
                    setCurrentPage(1);
                  }}
                  className={\`px-4 py-2 rounded-xl text-xs font-bold transition-all \${
                    procurementTypeFilter === t.id
                      ? "bg-primary text-primary-foreground shadow-md shadow-primary/20 ring-2 ring-primary/20"
                      : "bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900"
                  }\`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {factoryLocations.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-400">Factory:</span>
                <Select
                  value={factoryLocationFilter}
                  onValueChange={(val) => {
                    setFactoryLocationFilter(val);
                    setCurrentPage(1);
                  }}
                >
                  <SelectTrigger className="w-[150px] h-9 text-xs font-bold bg-slate-50 border-slate-200">
                    <SelectValue placeholder="All Factories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Factories</SelectItem>
                    {factoryLocations.map((loc: any) => (
                      <SelectItem key={loc._id} value={loc._id}>
                        {loc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        {/* Summary cards */}`;

if (content.includes(summaryCardsTarget) && !content.includes("Procurement Types Tabs (Kiran Engineering)")) {
  content = content.replace(summaryCardsTarget, tabsAddition);
}

// 6. Add Procurement fields in New Purchase Modal
const modalBranchTarget = `{/* Supplier */}`;
const modalAddition = `{/* Procurement Type & Factory Location (Kiran) */}
              {isKiran && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-50/70 p-4 rounded-xl border border-slate-100">
                  <div className="space-y-1.5">
                    <Label className={labelCls}>* Procurement Type</Label>
                    <Select
                      value={formData.procurementType || "READY"}
                      onValueChange={(val) => setField("procurementType", val)}
                    >
                      <SelectTrigger className={inputCls}>
                        <SelectValue placeholder="Select type..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="READY">Ready to Use</SelectItem>
                        <SelectItem value="JOBWORK">Job Work</SelectItem>
                        <SelectItem value="MANUFACTURE">Manufacturing by Self</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className={labelCls}>* Receiving Factory Location</Label>
                    <Select
                      value={formData.locationId || "none"}
                      onValueChange={(val) => setField("locationId", val === "none" ? "" : val)}
                    >
                      <SelectTrigger className={inputCls}>
                        <SelectValue placeholder="Select receiving factory..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Select Factory</SelectItem>
                        {factoryLocations.map((loc: any) => (
                          <SelectItem key={loc._id} value={loc._id}>
                            {loc.name} {loc.code ? \`(\${loc.code})\` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {/* Supplier */}`;

if (content.includes(modalBranchTarget) && !content.includes("Procurement Type & Factory Location (Kiran)")) {
  content = content.replace(modalBranchTarget, modalAddition);
}

fs.writeFileSync(filePath, content, "utf8");
console.log("Successfully updated Purchases.tsx with procurement tabs and factory location");

