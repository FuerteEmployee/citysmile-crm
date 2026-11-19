const fs = require('fs');
const path = require('path');
const routesDir = path.join(__dirname, 'src', 'hrms', 'routes');
const indexPath = path.join(routesDir, 'index.js');
let content = fs.readFileSync(indexPath, 'utf8');

content = content.replace(/router\.use\([^,]+,\s*require\(['"](\.\/[^'"]+)['"]\)\);/g, (match, reqPath) => {
  const absolutePath = path.resolve(routesDir, reqPath + '.js');
  if (!fs.existsSync(absolutePath)) {
    return `// ${match} (missing module)`;
  }
  return match;
});

fs.writeFileSync(indexPath, content);
console.log('Backend routes fixed!');
