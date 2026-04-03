const express = require("express");
const authMiddleware = require("../middlewares/auth.middleware");
const {
  listNotifications,
  markAllNotificationsRead,
} = require("../services/notification.service");

const router = express.Router();

router.use(authMiddleware);

router.get("/", async (req, res) => {
  try {
    const payload = await listNotifications({
      companyId: req.user.id_empresa,
      afterId: req.query.afterId,
      limit: req.query.limit,
    });

    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener notificaciones" });
  }
});

router.patch("/read-all", async (req, res) => {
  try {
    const payload = await markAllNotificationsRead({
      companyId: req.user.id_empresa,
    });

    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al marcar notificaciones como leidas" });
  }
});

module.exports = router;
