const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "..", "..", "CRM-FRONTEND-NEW", "src", "pages", "Purchases.tsx");
let content = fs.readFileSync(filePath, "utf8");

content = content.replace(
  /vendor:\s*vendorFilter\.length\s*\?\s*vendorFilter\.join\(","\)\s*:\s*undefined,\s*\n\s*\}\);/,
  `vendor: vendorFilter.length ? vendorFilter.join(",") : undefined,
        type: isKiran && procurementTypeFilter !== "ALL" ? procurementTypeFilter : undefined,
        locationId: isKiran && factoryLocationFilter !== "all" ? factoryLocationFilter : undefined,
      });`
);

fs.writeFileSync(filePath, content, "utf8");
console.log("Regex replacement done");
