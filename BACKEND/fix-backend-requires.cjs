const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, 'src', 'hrms');

function stubMissing(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      stubMissing(fullPath);
    } else if (file.endsWith('.js')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      
      const requires = content.match(/require\(['"]([^'"]+)['"]\)/g);
      if (requires) {
        for (const req of requires) {
          const match = req.match(/require\(['"]([^'"]+)['"]\)/);
          if (match && match[1].startsWith('.')) {
            const targetPathStr = match[1];
            const resolvedPath = path.resolve(dir, targetPathStr);
            let exists = false;
            if (fs.existsSync(resolvedPath)) exists = true;
            if (fs.existsSync(resolvedPath + '.js')) exists = true;
            if (fs.existsSync(resolvedPath + '/index.js')) exists = true;
            
            if (!exists) {
              console.log(`Stubbing missing file: ${targetPathStr} in ${file}`);
              fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
              fs.writeFileSync(resolvedPath + '.js', `
module.exports = new Proxy(function() {}, {
  get: function(target, prop) {
    if (prop === 'then') return undefined;
    return function(req, res, next) {
      if (res && res.status) {
        return res.status(501).json({ success: false, message: "Not Implemented (Stub)" });
      }
      return Promise.resolve(null);
    };
  },
  construct: function() {
    return { save: () => Promise.resolve() };
  }
});
`);
            }
          }
        }
      }
    }
  }
}

stubMissing(baseDir);
// Run a second time in case the newly created stubs need to be verified (they won't)
console.log("Missing files stubbed!");
