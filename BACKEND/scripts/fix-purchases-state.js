const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "..", "..", "CRM-FRONTEND-NEW", "src", "pages", "Purchases.tsx");
let content = fs.readFileSync(filePath, "utf8");

// 1. Add state right after branchFilter
const targetState = '  const [branchFilter, setBranchFilter] = useState("all");';
const additionState = `  const [branchFilter, setBranchFilter] = useState("all");
  const isKiran = isProcurementTypesEnabled();
  const [procurementTypeFilter, setProcurementTypeFilter] = useState<string>("ALL");
  const [factoryLocationFilter, setFactoryLocationFilter] = useState<string>("all");

  const { data: factoryLocations = [] } = useQuery<any[]>({
    queryKey: ["factory-locations"],
    queryFn: () => procurementService.listLocations().then((r: any) => r.locations || []),
    enabled: isKiran,
    staleTime: 5 * 60 * 1000,
  });`;

if (content.includes(targetState) && !content.includes("const [procurementTypeFilter, setProcurementTypeFilter]")) {
  content = content.replace(targetState, additionState);
  console.log("Added procurementTypeFilter state successfully");
}

// 2. Add type and locationId in queryFn
const targetQuery = `        branch: branchFilter !== "all" ? branchFilter : undefined,
        vendor: vendorFilter.length ? vendorFilter.join(",") : undefined,
      });`;

const additionQuery = `        branch: branchFilter !== "all" ? branchFilter : undefined,
        vendor: vendorFilter.length ? vendorFilter.join(",") : undefined,
        type: isKiran && procurementTypeFilter !== "ALL" ? procurementTypeFilter : undefined,
        locationId: isKiran && factoryLocationFilter !== "all" ? factoryLocationFilter : undefined,
      });`;

if (content.includes(targetQuery) && !content.includes("type: isKiran && procurementTypeFilter !== \"ALL\"")) {
  content = content.replace(targetQuery, additionQuery);
  console.log("Added query params in queryFn successfully");
}

fs.writeFileSync(filePath, content, "utf8");
console.log("Purchases.tsx fix complete");

