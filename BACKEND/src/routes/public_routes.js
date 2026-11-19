const express = require("express");
const SaasPlan = require("../models/SaasPlan");

// No auth: read-only list of plans for the in-app Subscription / renewal page.
// Single-company server: NO self-service signup here (it would create new
// companies). Plans on this server are set by the Super Admin via /api/control.
const router = express.Router();

router.get("/plans", async (req, res) => {
  try {
    const plans = await SaasPlan.find({ active: true })
      .select("name description price billing_cycle features module_access is_popular trial_days")
      .sort({ price: 1 });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ message: "Error fetching plans", error: err.message });
  }
});

module.exports = router;
