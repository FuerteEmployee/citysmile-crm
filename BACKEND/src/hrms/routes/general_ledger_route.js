
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
