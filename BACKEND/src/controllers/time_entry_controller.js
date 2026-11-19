const TimeEntry = require("../models/TimeEntry");

const isAdmin = (user) => !!(user?.admin || user?.is_superadmin);

// Entries the logged-in user may see/change: always their own company only;
// non-admin staff are further limited to the entries they logged themselves.
// Returns null when a non-superadmin has no company (nothing is safe to show).
const scopeFilter = (user) => {
  const filter = {};
  if (!user?.is_superadmin) {
    if (!user?.tenant_id) return null;
    filter.tenant_id = user.tenant_id;
  }
  if (!isAdmin(user)) filter.created_by = user._id;
  return filter;
};

// Checks the fields present in `data` (all of them when `isNew`); trims the task
// in place. Returns an error message, or null when the entry is valid.
const validateEntry = (data, isNew) => {
  if (isNew || data.task !== undefined) {
    data.task = String(data.task ?? "").trim();
    if (!data.task) return "Task is required";
  }
  if (isNew || data.hours !== undefined) {
    const hours = Number(data.hours);
    if (data.hours === "" || data.hours === null || !Number.isFinite(hours) || hours <= 0 || hours > 24) {
      return "Hours must be more than 0 and at most 24";
    }
  }
  if (isNew || data.date !== undefined) {
    if (!data.date || Number.isNaN(new Date(data.date).getTime())) return "A valid date is required";
  }
  return null;
};

// Bad input (schema validation or a malformed id) is the client's mistake, not a server error.
const isBadInput = (error) => error.name === "ValidationError" || error.name === "CastError";

exports.createTimeEntry = async (req, res) => {
  try {
    const { tenant_id, created_by, _id, ...data } = req.body;
    const invalid = validateEntry(data, true);
    if (invalid) return res.status(400).json({ message: invalid });
    const newEntry = new TimeEntry({
      ...data,
      created_by: req.user._id,
      tenant_id: req.user?.tenant_id,
    });
    await newEntry.save();
    res.status(201).json(newEntry);
  } catch (error) {
    res.status(isBadInput(error) ? 400 : 500).json({ message: "Error creating time entry", error: error.message });
  }
};

exports.getTimeEntries = async (req, res) => {
  try {
    const filter = scopeFilter(req.user);
    if (!filter) return res.status(200).json([]);
    const entries = await TimeEntry.find(filter).sort({ createdAt: -1 });
    res.status(200).json(entries);
  } catch (error) {
    res.status(500).json({ message: "Error fetching time entries", error: error.message });
  }
};

exports.updateTimeEntry = async (req, res) => {
  try {
    const filter = scopeFilter(req.user);
    if (!filter) return res.status(404).json({ message: "Not found" });
    // Ownership/company fields are never changed through an edit.
    const { tenant_id, created_by, _id, ...updates } = req.body;
    const invalid = validateEntry(updates, false);
    if (invalid) return res.status(400).json({ message: invalid });
    const updatedEntry = await TimeEntry.findOneAndUpdate(
      { ...filter, _id: req.params.id },
      updates,
      { new: true, runValidators: true }
    );
    if (!updatedEntry) return res.status(404).json({ message: "Not found" });
    res.status(200).json(updatedEntry);
  } catch (error) {
    res.status(isBadInput(error) ? 400 : 500).json({ message: "Error updating time entry", error: error.message });
  }
};

exports.deleteTimeEntry = async (req, res) => {
  try {
    const filter = scopeFilter(req.user);
    if (!filter) return res.status(404).json({ message: "Not found" });
    const deletedEntry = await TimeEntry.findOneAndDelete({ ...filter, _id: req.params.id });
    if (!deletedEntry) return res.status(404).json({ message: "Not found" });
    res.status(200).json({ message: "Deleted successfully" });
  } catch (error) {
    res.status(isBadInput(error) ? 400 : 500).json({ message: "Error deleting time entry", error: error.message });
  }
};
