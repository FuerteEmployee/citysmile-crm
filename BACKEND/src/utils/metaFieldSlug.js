// CustomField.slug is unique across every entity type, not just "leads" — so
// a Meta question key (e.g. "budget") could collide with an unrelated field
// an admin already created for another module. Prefixing keeps every
// Meta-sourced column in its own namespace. Shared between metaLeadService.js
// (writes the values) and anything that needs to recognize a Meta-sourced
// column (e.g. the Leads table telling "auto" columns apart from manual ones).
const slugForQuestionKey = (key) => `meta_${String(key).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

module.exports = { slugForQuestionKey };
