const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "..", "..", "CRM-FRONTEND-NEW", "src", "pages", "setup", "SetupSettings.tsx");
let content = fs.readFileSync(filePath, "utf8");

// Fix line 142
content = content.replace(
  '{ id: "fin-gateways", "fin-purchases", label: "Payment Gateways", icon: CreditCard },',
  '      { id: "fin-gateways", label: "Payment Gateways", icon: CreditCard },\n      { id: "fin-purchases", label: "Purchases", icon: ShoppingCart },'
);

// Fix line 6770
content = content.replace(
  '"fin-subscriptions", "fin-gateways",',
  '"fin-subscriptions", "fin-gateways", "fin-purchases",'
);

fs.writeFileSync(filePath, content, "utf8");
console.log("Successfully fixed SetupSettings.tsx syntax");

