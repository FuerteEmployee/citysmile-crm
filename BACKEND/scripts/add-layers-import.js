const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "..", "..", "CRM-FRONTEND-NEW", "src", "pages", "Purchases.tsx");
let content = fs.readFileSync(filePath, "utf8");

content = content.replace(
  'import { Plus, Search, Pencil, Trash2, ShoppingCart } from "lucide-react";',
  'import { Plus, Search, Pencil, Trash2, ShoppingCart, Layers } from "lucide-react";'
);

fs.writeFileSync(filePath, content, "utf8");
console.log("Added Layers to lucide-react import in Purchases.tsx");

