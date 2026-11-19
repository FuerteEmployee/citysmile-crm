const express = require("express");
const router = express.Router();
const { login, verify2FA, getMe, logout, refresh } = require("../controllers/auth_controller");
const { protect } = require("../middleware/auth");

router.post("/login", login);
router.post("/verify-2fa", verify2FA);
router.post("/logout", logout);
router.post("/refresh", refresh);
router.get("/me", protect, getMe);

module.exports = router;
