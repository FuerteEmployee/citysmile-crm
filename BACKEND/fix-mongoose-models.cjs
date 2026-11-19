const fs = require('fs');
const path = require('path');

function fixModels(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      fixModels(fullPath);
    } else if (file.endsWith('.js')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      
      // Replace mongoose.model("Name", schema) with (mongoose.models["Name"] || mongoose.model("Name", schema))
      let modified = false;
      
      // We look for mongoose.model('Name', schema)
      const newContent = content.replace(/mongoose\.model\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g, (match, modelName, schemaVar) => {
        modified = true;
        return `(mongoose.models["${modelName}"] || mongoose.model("${modelName}", ${schemaVar}))`;
      });
      
      if (modified) {
        fs.writeFileSync(fullPath, newContent);
      }
    }
  }
}

fixModels(path.join(__dirname, 'src', 'hrms', 'models'));
console.log("Fixed mongoose OverwriteModelError in HRMS models!");
