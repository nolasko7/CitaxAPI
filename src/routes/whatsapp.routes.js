const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/auth.middleware");
const {
  createInstanceQr,
  getCurrentInstance,
  disconnectCurrentInstance,
  getBotStatus,
  handleWebhook,
  getMessages,
  sendMessage,
  updateBotStatus,
} = require("../controllers/whatsapp.controller");

// WEBHOOK route - MUST be public (no authMiddleware)
router.post("/webhook/:instanceName", handleWebhook);

// Protected routes
router.use(authMiddleware);

router.post("/create-instance", createInstanceQr);
router.get("/status", getCurrentInstance);
router.get("/bot-status", getBotStatus);
router.put("/bot-status", updateBotStatus);
router.get("/messages", getMessages);
router.post("/send-message", sendMessage);
router.post("/disconnect", disconnectCurrentInstance);

module.exports = router;
