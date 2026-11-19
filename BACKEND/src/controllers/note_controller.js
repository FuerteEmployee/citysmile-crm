const Note = require("../models/Note");
const { withoutProtected, isObjectId, statusForError } = require("../utils/requestSafety");

const tenantScope = (req) =>
  (!req.user?.is_superadmin && req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {});

// A note on a customer must point at a customer of the caller's company.
const relOwned = async (req, rel_type, rel_id) => {
  if (rel_type !== "customer") return true;
  const { findOwnClient } = require("../utils/customerRules");
  return !!(await findOwnClient(req, rel_id));
};

const getNotes = async (req, res) => {
  try {
    const { rel_id, rel_type } = req.query;
    const query = { ...tenantScope(req) };
    if (rel_id) query.rel_id = rel_id;
    if (rel_type) query.rel_type = rel_type;

    const notes = await Note.find(query)
      .populate("addedfrom", "firstname lastname")
      .sort({ dateadded: -1 });
    res.json(notes);
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

// Returns which of the given rel_ids have at least one note, scoped to the
// caller's tenant — used to show a lightweight "has notes" indicator on a
// list of records (e.g. the Leads table) without fetching full note bodies.
const getNoteRelIdsWithNotes = async (req, res) => {
  try {
    const { rel_type, rel_ids } = req.query;
    if (!rel_type || !rel_ids) return res.json([]);

    const ids = String(rel_ids).split(",").map((id) => id.trim()).filter(Boolean);
    const query = { rel_type, rel_id: { $in: ids }, ...tenantScope(req) };

    const idsWithNotes = await Note.distinct("rel_id", query);
    res.json(idsWithNotes.map(String));
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const createNote = async (req, res) => {
  try {
    const body = withoutProtected(req.body || {});
    delete body.addedfrom;
    if (!(await relOwned(req, body.rel_type || "customer", body.rel_id))) {
      return res.status(404).json({ message: "Customer not found" });
    }
    const note = await Note.create({
      ...body,
      addedfrom: req.user._id,
      tenant_id: req.user?.tenant_id,
    });
    const populatedNote = await Note.findById(note._id).populate("addedfrom", "firstname lastname");
    res.status(201).json(populatedNote);
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

// Edit / delete only notes of the caller's own company. Only the note text and
// type can be changed (not what it's attached to, who wrote it, or its company).
const updateNote = async (req, res) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ message: "Note not found" });
    const note = await Note.findOne({ _id: req.params.id, ...tenantScope(req) });
    if (!note) return res.status(404).json({ message: "Note not found" });
    const { description, type } = req.body || {};
    if (description !== undefined) note.description = description;
    if (type !== undefined) note.type = type;
    await note.save();
    res.json(await Note.findById(note._id).populate("addedfrom", "firstname lastname"));
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const deleteNote = async (req, res) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ message: "Note not found" });
    const note = await Note.findOneAndDelete({ _id: req.params.id, ...tenantScope(req) });
    if (!note) return res.status(404).json({ message: "Note not found" });
    res.json({ message: "Note removed" });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

module.exports = {
  getNotes,
  getNoteRelIdsWithNotes,
  createNote,
  updateNote,
  deleteNote,
};
