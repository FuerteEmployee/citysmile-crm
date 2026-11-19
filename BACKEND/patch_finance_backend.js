const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');

function patchController(file, modelName, funcName, isTax, isCurrency) {
  const filePath = path.join(srcDir, 'controllers', file);
  if (!fs.existsSync(filePath)) {
    console.log(`Controller ${file} not found`);
    return;
  }
  let content = fs.readFileSync(filePath, 'utf8');
  
  if (content.includes(funcName)) {
    console.log(`${funcName} already exists in ${file}`);
    return;
  }
  
  const moduleExportsIdx = content.indexOf('module.exports = {');
  
  let mapLogic = `validItems.map(name => ({ name }))`;
  if (isTax) {
    mapLogic = `validItems.map(item => { const parts = item.split('|'); return { name: parts[0].trim(), taxrate: parseFloat(parts[1]) || 0 } })`;
  } else if (isCurrency) {
    mapLogic = `validItems.map(item => { const parts = item.split('|'); return { name: parts[0].trim(), symbol: parts[1] ? parts[1].trim() : '$' } })`;
  }
  
  const bulkCode = `
const ${funcName} = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ message: "Invalid items data" });
    const validItems = items.map(g => g.trim()).filter(g => g);
    if (validItems.length === 0) return res.status(400).json({ message: "No valid item names provided" });
    const createdItems = await ${modelName}.insertMany(${mapLogic});
    res.status(201).json(createdItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

`;

  content = content.slice(0, moduleExportsIdx) + bulkCode + content.slice(moduleExportsIdx);
  content = content.replace('module.exports = {', `module.exports = {\n  ${funcName},`);
  fs.writeFileSync(filePath, content);
  console.log(`Patched ${file}`);
}

function patchRoute(file, funcName, middleware) {
  const filePath = path.join(srcDir, 'routes', file);
  if (!fs.existsSync(filePath)) {
    console.log(`Route ${file} not found`);
    return;
  }
  let content = fs.readFileSync(filePath, 'utf8');
  
  if (content.includes(`/${funcName}`) || content.includes('/bulk')) {
    console.log(`/bulk route already exists in ${file}`);
    return;
  }
  
  content = content.replace('} = require("../controllers/', `  ${funcName},\n} = require("../controllers/`);
  
  const insertPos = content.indexOf('router\n  .route("/")');
  if (insertPos !== -1) {
    const routeCode = `router.post("/bulk", ${middleware}, ${funcName});\n\n`;
    content = content.slice(0, insertPos) + routeCode + content.slice(insertPos);
    fs.writeFileSync(filePath, content);
    console.log(`Patched ${file}`);
  } else {
    // If it uses router.get("/", ...), insert before the first get
    const getPos = content.indexOf('router.get(');
    if (getPos !== -1) {
      const routeCode = `router.post("/bulk", ${middleware}, ${funcName});\n`;
      content = content.slice(0, getPos) + routeCode + content.slice(getPos);
      fs.writeFileSync(filePath, content);
      console.log(`Patched ${file}`);
    } else {
       console.log(`Could not find mount point in ${file}`);
    }
  }
}

patchController('tax_controller.js', 'Tax', 'bulkCreateTax', true, false);
patchRoute('tax_routes.js', 'bulkCreateTax', 'checkPermission("settings", "create")');

patchController('currency_controller.js', 'Currency', 'bulkCreateCurrency', false, true);
patchRoute('currency_routes.js', 'bulkCreateCurrency', 'checkPermission("settings", "create")');

patchController('payment_mode_controller.js', 'PaymentMode', 'bulkCreatePaymentMode', false, false);
patchRoute('payment_mode_routes.js', 'bulkCreatePaymentMode', 'checkPermission("settings", "create")');

patchController('expense_category_controller.js', 'ExpenseCategory', 'bulkCreateExpenseCategory', false, false);
patchRoute('expense_category_routes.js', 'bulkCreateExpenseCategory', 'checkPermission("settings", "create")');
