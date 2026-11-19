const express = require("express");
const router = express.Router();
const { protect, staffOnly, checkPermission, requireCapability } = require("../middleware/auth");
const upload = require("../hrms/utils/cloudinary_config");
const {
  getTemplates,
  createTemplate,
  getCampaigns,
  getCampaignLogs,
  getDeliveryAnalytics,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  triggerCampaign,
  stopCampaign,
  resetCampaign,
  previewAudience,
} = require("../controllers/whatsapp_campaign_controller");

router.use(protect, staffOnly, checkPermission("WhatsApp", "View"));

// Reading needs WhatsApp View; anything that creates, sends or removes
// campaigns/templates needs the matching Create / Edit / Delete permission
// (admins always pass). Sending a campaign counts as Edit.
const canCreate = requireCapability("WhatsApp", "Create");
const canEdit = requireCapability("WhatsApp", "Edit");
const canDelete = requireCapability("WhatsApp", "Delete");

router.get("/templates", getTemplates);
router.post("/templates", canCreate, upload.uploadMemory.single("image"), createTemplate);
router.get("/analytics", getDeliveryAnalytics);
router.get("/logs", getCampaignLogs);
router.post("/audience-preview", previewAudience);
router.get("/", getCampaigns);
router.post("/", canCreate, upload.uploadMemory.single("image"), createCampaign);
router.put("/:id", canEdit, upload.uploadMemory.single("image"), updateCampaign);
router.delete("/:id", canDelete, deleteCampaign);
router.post("/:id/trigger", canEdit, triggerCampaign);
router.post("/:id/stop", canEdit, stopCampaign);
router.post("/:id/reset", canEdit, resetCampaign);

module.exports = router;
