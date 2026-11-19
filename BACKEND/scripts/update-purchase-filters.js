const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "..", "src", "controllers", "purchase_controller.js");
let content = fs.readFileSync(filePath, "utf8");

// 1. Extract query params in getPurchases
const oldParams = "const { page, limit, search, branch, vendor } = req.query;";
const newParams = "const { page, limit, search, branch, vendor, type, procurementType, categoryId, subcategoryId, locationId } = req.query;";

if (content.includes(oldParams)) {
  content = content.replace(oldParams, newParams);
}

// 2. Add filters for procurementType, categoryId, subcategoryId, locationId
const oldBranch = "if (branch) filter.branch = branch;";
const newFilters = `if (branch) filter.branch = branch;

    const pType = type || procurementType;
    if (pType && String(pType).toUpperCase() !== "ALL") {
      andConditions.push({
        $or: [
          { procurementType: String(pType).toUpperCase() },
          { "items.procurementType": String(pType).toUpperCase() },
        ],
      });
    }

    if (categoryId) {
      andConditions.push({
        $or: [
          { categoryId: categoryId },
          { "items.categoryId": categoryId },
        ],
      });
    }

    if (subcategoryId) {
      andConditions.push({
        $or: [
          { subcategoryId: subcategoryId },
          { "items.subcategoryId": subcategoryId },
        ],
      });
    }

    if (locationId) {
      andConditions.push({
        $or: [
          { locationId: locationId },
          { "items.locationId": locationId },
        ],
      });
    }`;

if (content.includes(oldBranch) && !content.includes("const pType = type || procurementType;")) {
  content = content.replace(oldBranch, newFilters);
}

fs.writeFileSync(filePath, content, "utf8");
console.log("Successfully updated purchase_controller.js with procurement filters");

