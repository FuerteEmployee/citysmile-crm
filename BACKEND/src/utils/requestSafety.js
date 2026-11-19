const mongoose = require("mongoose");

// Fields a client must never set through a create/update body: record identity,
// company ownership and audit stamps. Spreading or Object.assign-ing req.body
// without this let a request move a record into another company.
const PROTECTED_FIELDS = ["_id", "id", "__v", "tenant_id", "createdAt", "updatedAt", "created_by", "createdBy"];

const withoutProtected = (body = {}) => {
  const copy = { ...body };
  for (const key of PROTECTED_FIELDS) delete copy[key];
  return copy;
};

const isObjectId = (v) => typeof v === "string" ? mongoose.Types.ObjectId.isValid(v) && /^[0-9a-f]{24}$/i.test(v) : v instanceof mongoose.Types.ObjectId;

// Express param guard: a malformed :id is "not found", not a 500 CastError.
const validIdParam = (name = "id") => (req, res, next) =>
  (isObjectId(req.params[name]) ? next() : res.status(404).json({ message: "Not found" }));

// Mongoose validation / cast errors are the caller's input, not a server fault.
const statusForError = (err) => (err?.name === "ValidationError" || err?.name === "CastError" ? 400 : err?.code === 11000 ? 409 : 500);

module.exports = { PROTECTED_FIELDS, withoutProtected, isObjectId, validIdParam, statusForError };
