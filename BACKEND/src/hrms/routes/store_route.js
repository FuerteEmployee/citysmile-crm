const express = require("express");
const router = express.Router();
const {
  createStore,
  getStores,
  getStoreById,
  updateStore,
  deleteStore,
} = require("../controllers/store_controller");
const { protect } = require("../middleware/auth_middleware");

router.use(protect);

router.post("/", createStore);
router.get("/", getStores);
router.get("/:id", getStoreById);
router.patch("/:id", updateStore);
router.delete("/:id", deleteStore);

module.exports = router;
