const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "..", "..", "CRM-FRONTEND-NEW", "src", "pages", "setup", "SetupSettings.tsx");
let content = fs.readFileSync(filePath, "utf8");

// 1. Import PurchaseSettingsTab
const importTabTarget = 'import { ClaudeConnectorSettingsTab } from "./ClaudeConnectorSettingsTab";';
const importTabAddition = `import { ClaudeConnectorSettingsTab } from "./ClaudeConnectorSettingsTab";
import { PurchaseSettingsTab } from "./PurchaseSettingsTab";`;

if (!content.includes('import { PurchaseSettingsTab }')) {
  content = content.replace(importTabTarget, importTabAddition);
}

// 2. Add ShoppingCart to lucide imports
const lucideTarget = "  FileText,";
const lucideAddition = "  FileText,\n  ShoppingCart,";

if (!content.includes("  ShoppingCart,")) {
  content = content.replace(lucideTarget, lucideAddition);
}

// 3. Add fin-purchases navigation item under Finance
const navTarget = `      { id: "fin-subscriptions", label: "Subscriptions", icon: RefreshCw },
      { id: "fin-gateways", label: "Payment Gateways", icon: CreditCard },
    ]`;

const navAddition = `      { id: "fin-subscriptions", label: "Subscriptions", icon: RefreshCw },
      { id: "fin-gateways", label: "Payment Gateways", icon: CreditCard },
      { id: "fin-purchases", label: "Purchases", icon: ShoppingCart },
    ]`;

if (!content.includes('{ id: "fin-purchases", label: "Purchases", icon: ShoppingCart }')) {
  content = content.replace(navTarget, navAddition);
}

// 4. Add render block for fin-purchases
const renderTarget = `{activeTab === "fin-general" && (`;
const renderAddition = `{activeTab === "fin-purchases" && <PurchaseSettingsTab />}

            {activeTab === "fin-general" && (`;

if (!content.includes('{activeTab === "fin-purchases" && <PurchaseSettingsTab />}')) {
  content = content.replace(renderTarget, renderAddition);
}

// 5. Add "fin-purchases" to excluded tabs in line 6765
const excludeTarget = '"fin-gateways",';
const excludeAddition = '"fin-gateways", "fin-purchases",';

if (content.includes(excludeTarget) && !content.includes('"fin-purchases",')) {
  content = content.replace(excludeTarget, excludeAddition);
}

fs.writeFileSync(filePath, content, "utf8");
console.log("Successfully integrated PurchaseSettingsTab into SetupSettings.tsx");

