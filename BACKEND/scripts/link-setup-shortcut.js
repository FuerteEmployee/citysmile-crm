const fs = require("fs");
const path = require("path");

// 1. Update SetupSettings.tsx for useSearchParams
const setupFile = path.join(__dirname, "..", "..", "CRM-FRONTEND-NEW", "src", "pages", "setup", "SetupSettings.tsx");
let setupContent = fs.readFileSync(setupFile, "utf8");

const oldLinkImport = 'import { Link } from "react-router-dom";';
const newLinkImport = 'import { Link, useSearchParams } from "react-router-dom";';
if (setupContent.includes(oldLinkImport)) {
  setupContent = setupContent.replace(oldLinkImport, newLinkImport);
}

const oldActiveTab = '  const [activeTab, setActiveTab] = useState("gen-general");';
const newActiveTab = `  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(() => searchParams.get("tab") || "gen-general");`;

if (setupContent.includes(oldActiveTab)) {
  setupContent = setupContent.replace(oldActiveTab, newActiveTab);
}

fs.writeFileSync(setupFile, setupContent, "utf8");
console.log("Updated SetupSettings.tsx with useSearchParams support");

// 2. Update Purchases.tsx to add the Categories & Setup shortcut button
const purchasesFile = path.join(__dirname, "..", "..", "CRM-FRONTEND-NEW", "src", "pages", "Purchases.tsx");
let purchasesContent = fs.readFileSync(purchasesFile, "utf8");

if (!purchasesContent.includes('import { useNavigate } from "react-router-dom";')) {
  purchasesContent = 'import { useNavigate } from "react-router-dom";\n' + purchasesContent;
}

const oldNavigateHook = '  const { toast } = useToast();';
const newNavigateHook = `  const { toast } = useToast();
  const navigate = useNavigate();`;

if (purchasesContent.includes(oldNavigateHook) && !purchasesContent.includes("const navigate = useNavigate();")) {
  purchasesContent = purchasesContent.replace(oldNavigateHook, newNavigateHook);
}

const oldExportBtn = '<ExportButton data={loadAllFilteredPurchases} filename="purchases" columns={exportColumns} />';
const newExportBtn = `<ExportButton data={loadAllFilteredPurchases} filename="purchases" columns={exportColumns} />
            {isKiran && (
              <Button
                variant="outline"
                onClick={() => navigate("/admin/setup?tab=fin-purchases")}
                className="rounded-xl font-bold gap-2 shadow-sm px-4 h-11 text-xs border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
              >
                <Layers className="h-4 w-4 text-primary" />
                Categories & Setup
              </Button>
            )}`;

if (purchasesContent.includes(oldExportBtn) && !purchasesContent.includes('onClick={() => navigate("/admin/setup?tab=fin-purchases")}')) {
  purchasesContent = purchasesContent.replace(oldExportBtn, newExportBtn);
}

// Make sure Layers icon is imported in Purchases.tsx
if (!purchasesContent.includes("Layers,") && !purchasesContent.includes("Layers }")) {
  purchasesContent = purchasesContent.replace("ShoppingCart,", "ShoppingCart,\n  Layers,");
}

fs.writeFileSync(purchasesFile, purchasesContent, "utf8");
console.log("Updated Purchases.tsx with Categories & Setup button");

