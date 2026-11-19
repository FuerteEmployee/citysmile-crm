const fs = require("fs");
const path = require("path");

const indexPath = path.join(__dirname, "..", "index.js");
let content = fs.readFileSync(indexPath, "utf8");

const target = 'app.use("/api/purchase-orders", purchaseOrderRoutes);';
const addition = `

// Purchase Procurement Types (tenant add-on "procurement_types")
const purchaseCategoryRoutes = require("./src/routes/purchase_category_routes");
app.use("/api/purchase-categories", purchaseCategoryRoutes);

const factoryLocationRoutes = require("./src/routes/factory_location_routes");
app.use("/api/locations", factoryLocationRoutes);`;

if (!content.includes("/api/purchase-categories")) {
  content = content.replace(target, target + addition);
  fs.writeFileSync(indexPath, content, "utf8");
  console.log("Successfully mounted purchase-categories and locations in index.js");
} else {
  console.log("Already mounted");
}

