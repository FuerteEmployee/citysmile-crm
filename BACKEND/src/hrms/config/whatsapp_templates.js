// ---------------------------------------------------------------------------
// Templates are fetched live from Meta (whatsapp_template_service.js).
// No static definitions — add/edit templates directly in Meta WhatsApp Manager.
// ---------------------------------------------------------------------------

const WHATSAPP_TEMPLATES = [];

// Fill a template's body placeholders for a preview, given campaign params.
function renderPreview(template, params = {}) {
  let text = template.body;
  for (const v of template.variables) {
    const val =
      v.source === "campaign"
        ? params[v.placeholder] || v.sample || `{{${v.placeholder}}}`
        : v.sample || `{{${v.placeholder}}}`;
    text = text.replace(new RegExp(`\\{\\{${v.placeholder}\\}\\}`, "g"), val);
  }
  return text;
}

function getTemplateById(id) {
  return WHATSAPP_TEMPLATES.find((t) => t.id === id) || null;
}

module.exports = { WHATSAPP_TEMPLATES, renderPreview, getTemplateById };
