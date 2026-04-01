const express = require("express");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const {
  clearLatestQr,
  createInstanceWithQr,
  disconnectInstance,
  getLatestQr,
  getSafeConnectionState,
  normalizeInstanceName,
  registerWebhook,
  storeLatestQr,
} = require("../services/evolution.service");
const {
  getSuperadminCredentials,
  normalizeCredentialValue,
  normalizeEmail,
} = require("../services/superadminAuth.service");

const router = express.Router();

const superadminCredentials = getSuperadminCredentials();
const SUPERADMIN_EMAIL = superadminCredentials.email;
const SUPERADMIN_PASSWORD = superadminCredentials.password;
const SUPERADMIN_SECRET = superadminCredentials.secret;
const SUPPORT_INSTANCE = normalizeInstanceName(process.env.SUPPORT_WHATSAPP_INSTANCE || "citax-support-whatsapp");

if (superadminCredentials.usingDefaults) {
  console.warn(
    "[superadmin] SUPERADMIN_EMAIL o SUPERADMIN_PASSWORD no estan configurados; usando credenciales por defecto."
  );
}

const authSuperadmin = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, SUPERADMIN_SECRET);
    if (decoded.role !== "superadmin") return res.status(403).json({ error: "Forbidden" });
    req.superadmin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = normalizeCredentialValue(password);

  if (normalizedEmail !== SUPERADMIN_EMAIL || normalizedPassword !== SUPERADMIN_PASSWORD) {
    return res.status(401).json({ error: "Credenciales inválidas" });
  }

  const token = jwt.sign(
    { role: "superadmin", email: SUPERADMIN_EMAIL },
    SUPERADMIN_SECRET,
    { expiresIn: "7d" }
  );

  return res.json({
    token,
    user: { role: "superadmin", email: SUPERADMIN_EMAIL },
    supportInstance: SUPPORT_INSTANCE,
  });
});

router.use(authSuperadmin);

router.get("/support-whatsapp/status", async (req, res) => {
  try {
    const connectionState = await getSafeConnectionState(SUPPORT_INSTANCE);
    const status = connectionState?.instance?.state || connectionState?.state || "unknown";
    const webhook = await registerWebhook(SUPPORT_INSTANCE);

    return res.json({
      instanceName: SUPPORT_INSTANCE,
      status,
      connected: status === "open",
      qr: status === "open" ? null : getLatestQr(SUPPORT_INSTANCE),
      connectionState,
      webhook,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Error al obtener estado" });
  }
});

router.post("/support-whatsapp/connect", async (req, res) => {
  try {
    const { number } = req.body || {};
    let result;
    try {
      result = await createInstanceWithQr({
        instanceName: SUPPORT_INSTANCE,
        number: number ? String(number).trim() : null,
        companyId: "support",
      });
    } catch (createError) {
      const axiosStatus = createError.response?.status || createError.status;
      if (axiosStatus !== 400 && axiosStatus !== 409) {
        throw createError;
      }

      try {
        const connectRes = await axios.get(
          `${process.env.EVOLUTION_API_URL || "http://localhost:8080"}/instance/connect/${SUPPORT_INSTANCE}`,
          { headers: { apikey: process.env.EVOLUTION_API_KEY } }
        );

        const connectionState = await getSafeConnectionState(SUPPORT_INSTANCE);
        const webhook = await registerWebhook(SUPPORT_INSTANCE);
        const qr = storeLatestQr(SUPPORT_INSTANCE, connectRes.data);

        result = {
          instanceName: SUPPORT_INSTANCE,
          qr,
          qrcode: connectRes.data?.qrcode || null,
          raw: connectRes.data,
          connectionState,
          webhook,
        };
      } catch (connectError) {
        const connectionState = await getSafeConnectionState(SUPPORT_INSTANCE);
        const webhook = await registerWebhook(SUPPORT_INSTANCE);
        const qr = getLatestQr(SUPPORT_INSTANCE);
        result = {
          instanceName: SUPPORT_INSTANCE,
          qr,
          qrcode: null,
          raw: null,
          connectionState,
          webhook,
          warning: "No se pudo forzar reconnect en Evolution, pero se devolvió estado actual.",
          debug: {
            code: connectError.code || null,
            status: connectError.response?.status || null,
            message: connectError.message || null,
          },
        };
      }
    }

    return res.json({
      message: "Instancia de soporte creada correctamente",
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Error al conectar WhatsApp soporte",
      details: error.response?.data || null,
      debug: {
        code: error.code || null,
        status: error.response?.status || null,
        message: error.message || null,
      },
    });
  }
});

router.post("/support-whatsapp/disconnect", async (req, res) => {
  try {
    const result = await disconnectInstance(SUPPORT_INSTANCE);
    clearLatestQr(SUPPORT_INSTANCE);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Error al desconectar WhatsApp soporte" });
  }
});

module.exports = router;
