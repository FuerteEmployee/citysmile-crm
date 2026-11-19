// Test-only shim: exposes planModuleGate as a plain middleware so crmTestApp.start()
// can mount it on "/api" (like index.js:104) via its [mount, modulePath] list.
module.exports = require("../middleware/planModules").planModuleGate;
