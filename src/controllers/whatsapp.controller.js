const prisma = require("../config/prisma");
const {
  buildInstanceName,
  clearLatestQr,
  createInstanceWithQr,
  disconnectInstance,
  getLatestQr,
  getSafeConnectionState,
  invalidateCompanyInternalPhonesCache,
  normalizeInstanceName,
  normalizeQrPayload,
  registerWebhook,
  storeLatestQr,
} = require("../services/evolution.service");

// Helper to save or update CONFIG_WHATSAPP
const persistWhatsappInstance = async ({
  companyId,
  instanceName,
  phoneNumber,
  status,
}) => {
  let config = await prisma.cONFIG_WHATSAPP.findUnique({
    where: { id_empresa: companyId },
  });

  const isConnected = status === "open";

  if (config) {
    const updated = await prisma.cONFIG_WHATSAPP.update({
      where: { id_whatsapp: config.id_whatsapp },
      data: {
        instance_name: instanceName,
        whatsapp_number: phoneNumber,
        conectado: isConnected,
      },
    });
    invalidateCompanyInternalPhonesCache();
    return updated;
  } else {
    const created = await prisma.cONFIG_WHATSAPP.create({
      data: {
        id_empresa: companyId,
        instance_name: instanceName,
        whatsapp_number: phoneNumber,
        conectado: isConnected,
      },
    });
    invalidateCompanyInternalPhonesCache();
    return created;
  }
};

const createInstanceQr = async (req, res, next) => {
  try {
    const { number } = req.body || {};
    const companyId = req.user.id_empresa;

    let result;
    try {
      result = await createInstanceWithQr({
        number: number ? String(number).trim() : null,
        companyId,
      });
    } catch (createError) {
      // If instance already exists (400), try to reconnect it instead of failing
      const axiosStatus = createError.response?.status || createError.status;
      if (axiosStatus === 400 || axiosStatus === 409) {
        const instanceName = normalizeInstanceName(
          buildInstanceName({ companyId }),
        );

        // Try to connect the existing instance to get a QR
        try {
          const connectRes = await require("axios").get(
            `${process.env.EVOLUTION_API_URL || "http://localhost:8080"}/instance/connect/${instanceName}`,
            { headers: { apikey: process.env.EVOLUTION_API_KEY } },
          );
          const connectionState = await getSafeConnectionState(instanceName);
          const webhook = await registerWebhook(instanceName);
          const qr = storeLatestQr(instanceName, connectRes.data);

          result = {
            instanceName,
            qr,
            qrcode: connectRes.data?.qrcode || null,
            raw: connectRes.data,
            connectionState,
            webhook,
          };
        } catch (connectError) {
          // If connect also fails, still try to return status
          const connectionState = await getSafeConnectionState(instanceName);
          const qr = getLatestQr(instanceName);
          const webhook = await registerWebhook(instanceName);

          result = {
            instanceName,
            qr,
            qrcode: null,
            raw: null,
            connectionState,
            webhook,
          };
        }
      } else {
        throw createError;
      }
    }

    const status =
      result.connectionState?.instance?.state ||
      result.connectionState?.state ||
      "close";

    await persistWhatsappInstance({
      companyId,
      instanceName: result.instanceName,
      phoneNumber: number ? String(number).trim() : null,
      status,
    });

    res.json({
      message: "Instancia creada correctamente",
      ...result,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error al generar QR" });
  }
};

const getCurrentInstance = async (req, res, next) => {
  try {
    const companyId = req.user.id_empresa;
    let storedInstance = await prisma.cONFIG_WHATSAPP.findUnique({
      where: { id_empresa: companyId },
    });

    if (!storedInstance || !storedInstance.instance_name) {
      return res.json({ instance: null, qr: normalizeQrPayload(null) });
    }

    const instanceName = normalizeInstanceName(storedInstance.instance_name);
    const connectionState = await getSafeConnectionState(instanceName);
    const resolvedStatus =
      connectionState.instance?.state || connectionState.state || "unknown";

    // Forzamos la actualización del Webhook siempre que se consulte el estado.
    // Esto asegura que si el ngrok cambió de URL libre, Evolution API se entere al instante.
    await registerWebhook(instanceName);

    // Mantenemos sincronizado el estado
    await persistWhatsappInstance({
      companyId,
      instanceName,
      phoneNumber: storedInstance.whatsapp_number,
      status: resolvedStatus,
    });

    res.json({
      instance: {
        id: storedInstance.id_whatsapp,
        instanceName,
        phoneNumber: storedInstance.whatsapp_number,
        status: resolvedStatus,
        conectado: resolvedStatus === "open",
      },
      qr:
        resolvedStatus === "open"
          ? normalizeQrPayload(null)
          : getLatestQr(instanceName),
      connectionState,
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: error.message || "Error al obtener la instancia" });
  }
};

const disconnectCurrentInstance = async (req, res, next) => {
  try {
    const companyId = req.user.id_empresa;
    const storedInstance = await prisma.cONFIG_WHATSAPP.findUnique({
      where: { id_empresa: companyId },
    });

    if (!storedInstance || !storedInstance.instance_name) {
      return res.status(400).json({
        message: "No hay una instancia de WhatsApp vinculada para desconectar",
      });
    }

    const instanceName = normalizeInstanceName(storedInstance.instance_name);
    const result = await disconnectInstance(instanceName);

    await persistWhatsappInstance({
      companyId,
      instanceName,
      phoneNumber: null,
      status: "close",
    });
    clearLatestQr(instanceName);

    res.json({
      message: "WhatsApp desconectado correctamente",
      ...result,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error al desconectar" });
  }
};

const handleWebhook = async (req, res, next) => {
  try {
    const instanceName = normalizeInstanceName(
      req.params.instanceName || req.body?.instance || req.body?.instanceName,
    );
    const payload = req.body;

    console.log("WEBHOOK RECIBIDO:", {
      instanceName,
      event: payload?.event || "unknown",
      hasData: Boolean(payload?.data),
    });

    res.status(200).json({ received: true });

    if (payload?.event === "qrcode.updated") {
      storeLatestQr(instanceName, payload);
      console.log("🔳 QR actualizado:", {
        instanceName,
        hasQr: getLatestQr(instanceName)?.source !== "none",
      });
    }

    if (payload?.event === "connection.update") {
      const state = payload?.data?.state || payload?.state || "unknown";
      console.log("🔌 Estado de conexión WhatsApp:", {
        instanceName,
        state,
      });
      if (state === "open") {
        clearLatestQr(instanceName);
      }
      try {
        const config = await prisma.cONFIG_WHATSAPP.findFirst({
          where: { instance_name: instanceName },
        });
        if (config) {
          await prisma.cONFIG_WHATSAPP.update({
            where: { id_whatsapp: config.id_whatsapp },
            data: { conectado: state === "open" },
          });
        }
      } catch (e) {
        console.error("Error actualizando estado en webhook:", e.message);
      }
      return;
    }

    if (
      payload?.event === "messages.upsert" ||
      payload?.event === "messages.update"
    ) {
      const {
        processIncomingMessage,
      } = require("../services/evolution.service");

      processIncomingMessage({ instanceName, webhookData: payload }).catch(
        (err) => {
          console.error("Error procesando webhook:", err.message);
        },
      );
    }
  } catch (error) {
    console.error("❌ Error en handleWebhook:", error.message);
  }
};

const getMessages = async (req, res, next) => {
  try {
    const companyId = req.user.id_empresa;
    const storedInstance = await prisma.cONFIG_WHATSAPP.findUnique({
      where: { id_empresa: companyId },
    });

    if (!storedInstance || !storedInstance.instance_name) {
      return res.json({ messages: [] });
    }

    const instanceName = normalizeInstanceName(storedInstance.instance_name);
    const { getRecentMessages } = require("../services/evolution.service");
    const messages = getRecentMessages(instanceName);

    res.json({ messages });
  } catch (error) {
    res
      .status(500)
      .json({ error: error.message || "Error al obtener mensajes" });
  }
};

const sendMessage = async (req, res, next) => {
  try {
    const { phone, message } = req.body || {};
    if (!phone || !message) {
      return res.status(400).json({ error: "Se requiere phone y message" });
    }

    const companyId = req.user.id_empresa;
    const storedInstance = await prisma.cONFIG_WHATSAPP.findUnique({
      where: { id_empresa: companyId },
    });

    if (!storedInstance || !storedInstance.instance_name) {
      return res
        .status(400)
        .json({ error: "No hay instancia de WhatsApp configurada" });
    }

    const instanceName = normalizeInstanceName(storedInstance.instance_name);
    const { sendTextMessage } = require("../services/evolution.service");
    const result = await sendTextMessage(phone, message, instanceName);

    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error al enviar mensaje" });
  }
};

module.exports = {
  createInstanceQr,
  getCurrentInstance,
  disconnectCurrentInstance,
  handleWebhook,
  getMessages,
  sendMessage,
};
