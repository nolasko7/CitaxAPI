const axios = require("axios");
const { processAudioMessage } = require("./ai/audioTranscriptionGroqService");
const pool = require("../config/db");


const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "http://localhost:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "429683C4C977415CAAFCCE10F7D57E11";
const EVOLUTION_WEBHOOK_ENABLED = (process.env.EVOLUTION_WEBHOOK_ENABLED || "true") === "true";
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "";
const WHATSAPP_INSTANCE_PREFIX = process.env.WHATSAPP_INSTANCE_PREFIX || "citax";
const SUPPORT_INSTANCE_NAME = String(process.env.SUPPORT_WHATSAPP_INSTANCE || "citax-support-whatsapp")
  .trim()
  .toLowerCase();

const buildPhoneVariants = (value) => {
  const digits = String(value || "").replace(/[^\d]/g, "").trim();
  if (!digits) return [];

  const variants = new Set([digits]);

  if (digits.startsWith("549") && digits.length >= 12) {
    variants.add(`54${digits.slice(3)}`);
  }

  if (digits.startsWith("54") && !digits.startsWith("549") && digits.length >= 11) {
    variants.add(`549${digits.slice(2)}`);
  }

  return [...variants];
};

const parseIgnoredPhonesFromBotConfig = (rawConfig) => {
  try {
    const parsed = typeof rawConfig === "string" ? JSON.parse(rawConfig || "{}") : (rawConfig || {});
    const phones = Array.isArray(parsed?.telefonos_ignorados) ? parsed.telefonos_ignorados : [];
    return new Set(
      phones.flatMap((phone) => buildPhoneVariants(phone))
    );
  } catch (_) {
    return new Set();
  }
};

const getIgnoredPhonesForInstance = async (instanceName) => {
  try {
    const [rows] = await pool.execute(
      `SELECT e.bot_config
       FROM CONFIG_WHATSAPP cw
       JOIN EMPRESA e ON e.id_empresa = cw.id_empresa
       WHERE cw.instance_name = ?
       LIMIT 1`,
      [instanceName]
    );

    if (!rows.length) return new Set();
    return parseIgnoredPhonesFromBotConfig(rows[0].bot_config);
  } catch (error) {
    console.error("Error obteniendo telefonos ignorados:", error.message);
    return new Set();
  }
};

const evolutionClient = axios.create({
  baseURL: EVOLUTION_API_URL,
  headers: {
    "Content-Type": "application/json",
    apikey: EVOLUTION_API_KEY,
  },
  timeout: 15000,
});

const evolutionOpenClient = axios.create({
  baseURL: EVOLUTION_API_URL,
  headers: {
    "Content-Type": "application/json",
  },
  timeout: 15000,
});

const normalizeInstanceName = (value) => {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
};

const buildInstanceName = ({ companyId }) => {
  return normalizeInstanceName(
    `${WHATSAPP_INSTANCE_PREFIX}-empresa-${companyId}-whatsapp`
  );
};

const ensureImageDataUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:image/")) return raw;
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
    return `data:image/png;base64,${raw.replace(/\s+/g, "")}`;
  }
  return "";
};

const getQrPayloadCandidates = (payload) => {
  if (!payload) return [];
  if (typeof payload === "string") return [payload];

  return [
    payload.qr,
    payload.qrcode,
    payload.code,
    payload.base64,
    payload.imageDataUrl,
    payload.data,
    payload.data?.qr,
    payload.data?.qrcode,
    payload.data?.code,
    payload.data?.base64,
    payload.data?.imageDataUrl,
  ].filter(Boolean);
};

const normalizeQrPayload = (payload) => {
  const candidates = getQrPayloadCandidates(payload);

  const normalized = {
    code: "",
    pairingCode: "",
    imageDataUrl: "",
    source: "none",
  };

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const asImage = ensureImageDataUrl(candidate);
      if (asImage && !normalized.imageDataUrl) {
        normalized.imageDataUrl = asImage;
        normalized.source = "image";
        continue;
      }

      if (!normalized.code) {
        normalized.code = candidate.trim();
        normalized.source = "code";
      }
      continue;
    }

    if (typeof candidate === "object") {
      if (!normalized.code && typeof candidate.code === "string") {
        normalized.code = candidate.code.trim();
        normalized.source = "code";
      }
      if (!normalized.pairingCode && typeof candidate.pairingCode === "string") {
        normalized.pairingCode = candidate.pairingCode.trim();
      }
      if (!normalized.imageDataUrl && typeof candidate.base64 === "string") {
        normalized.imageDataUrl = ensureImageDataUrl(candidate.base64);
        if (normalized.imageDataUrl) normalized.source = "image";
      }
      if (!normalized.imageDataUrl && typeof candidate.imageDataUrl === "string") {
        normalized.imageDataUrl = ensureImageDataUrl(candidate.imageDataUrl);
        if (normalized.imageDataUrl) normalized.source = "image";
      }
    }
  }

  return normalized;
};


const getConnectionState = async (instanceName) => {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const response = await evolutionClient.get(
    `/instance/connectionState/${normalizedInstanceName}`
  );
  return response.data;
};

const getSafeConnectionState = async (instanceName) => {
  try {
    const stateResponse = await getConnectionState(instanceName);
    return stateResponse;
  } catch (error) {
    return {
      instanceName: normalizeInstanceName(instanceName),
      state: "unknown",
      reason: error.response?.data || error.message,
    };
  }
};

const qrStore = new Map();

const storeLatestQr = (instanceName, payload) => {
  const key = normalizeInstanceName(instanceName);
  const normalizedQr = normalizeQrPayload(payload);
  if (normalizedQr.source === "none") {
    qrStore.delete(key);
    return normalizedQr;
  }
  qrStore.set(key, normalizedQr);
  return normalizedQr;
};

const getLatestQr = (instanceName) => {
  const key = normalizeInstanceName(instanceName);
  return qrStore.get(key) || {
    code: "",
    pairingCode: "",
    imageDataUrl: "",
    source: "none",
  };
};

const clearLatestQr = (instanceName) => {
  qrStore.delete(normalizeInstanceName(instanceName));
};

const registerWebhook = async (instanceName) => {
  if (!BACKEND_PUBLIC_URL || !EVOLUTION_WEBHOOK_ENABLED) {
    return {
      configured: false,
      reason: "BACKEND_PUBLIC_URL no configurada o webhook deshabilitado",
    };
  }

  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const webhookUrl = `${BACKEND_PUBLIC_URL.replace(/\/$/, "")}/api/whatsapp/webhook/${normalizedInstanceName}`;

  try {
    const response = await evolutionClient.post(
      `/webhook/set/${normalizedInstanceName}`,
      {
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: ["MESSAGES_UPSERT", "QRCODE_UPDATED", "CONNECTION_UPDATE"],
        },
      }
    );
    return { configured: true, webhookUrl, response: response.data };
  } catch (error) {
    return { configured: false, webhookUrl, reason: error.response?.data || error.message };
  }
};

const createInstanceWithQr = async ({ instanceName, number = null, companyId }) => {
  const resolvedInstanceName = normalizeInstanceName(
    instanceName || buildInstanceName({ companyId })
  );

  const payload = {
    instanceName: resolvedInstanceName,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
    rejectCall: false,
    alwaysOnline: true,
    syncFullHistory: false,
    groupsIgnore: true,
  };

  if (number) {
    payload.number = String(number);
  }

  const response = await evolutionOpenClient.post("/instance/create-qr", payload);

  const connectionState = await getSafeConnectionState(resolvedInstanceName);
  const webhook = await registerWebhook(resolvedInstanceName);
  const qr = storeLatestQr(resolvedInstanceName, response.data);

  return {
    instanceName: resolvedInstanceName,
    qr,
    qrcode: response.data?.qrcode || null,
    raw: response.data,
    connectionState,
    webhook,
  };
};

const disconnectInstance = async (instanceName) => {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  try {
    const response = await evolutionClient.delete(
      `/instance/logout/${normalizedInstanceName}`
    );
    clearLatestQr(normalizedInstanceName);
    return { success: true, instanceName: normalizedInstanceName, response: response.data };
  } catch (error) {
    const status = error.response?.status;
    const code = error.code;

    // Instance already gone or Evolution API not reachable — treat as success
    if (status === 404 || status === 400 || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ECONNABORTED") {
      return {
        success: true,
        instanceName: normalizedInstanceName,
        response: error.response?.data || { message: "Instancia desconectada (o Evolution API no disponible)" },
      };
    }
    throw error;
  }
};

// ─── Send text message via Evolution API ──────────────────────────────
const sendTextMessage = async (phoneNumber, text, instanceName) => {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const number = String(phoneNumber).replace(/[^\d]/g, "");
  const response = await evolutionClient.post(
    `/message/sendText/${normalizedInstanceName}`,
    { number, text }
  );
  return response.data;
};

// ─── Extract messages from webhook payload ────────────────────────────
const extractIncomingMessages = (webhookData) => {
  if (!webhookData) return [];
  const event = webhookData.event || webhookData.type || "";
  if (event !== "messages.upsert") return [];
  const candidateLists = [
    webhookData?.data?.messages,
    webhookData?.messages,
    webhookData?.message,
  ].filter(Boolean);

  const flattenedCandidates = candidateLists.flatMap((item) =>
    Array.isArray(item) ? item : [item]
  );

  if (webhookData?.data) {
    flattenedCandidates.unshift(webhookData.data);
  }

  return flattenedCandidates.filter(
    (item) => item && (item.key || item.message || item.messageType || item.type)
  );
};

// ─── Help identify the actual message content (skipping wrappers) ────────
const unwrapMessage = (msg) => {
  if (!msg) return { type: "unknown", content: {} };
  
  if (msg.ephemeralMessage) return unwrapMessage(msg.ephemeralMessage.message);
  if (msg.viewOnceMessage) return unwrapMessage(msg.viewOnceMessage.message);
  if (msg.viewOnceMessageV2) return unwrapMessage(msg.viewOnceMessageV2.message);
  if (msg.documentWithCaptionMessage) return unwrapMessage(msg.documentWithCaptionMessage.message);
  
  const type = Object.keys(msg)[0] || "unknown";
  return { type, content: msg[type] || {} };
};

const extractTextFromMessage = (msg, content) => {
  return (
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption ||
    msg?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    content?.caption ||
    content?.text ||
    content?.contentText ||
    content?.description ||
    ""
  );
};

const detectAudioMessage = ({ rawType, messageType, content, msg }) => {
  const candidates = [
    rawType,
    messageType,
    content?.mimetype,
    msg?.audio?.mimetype,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  if (candidates.some((value) => value.includes("audio"))) {
    return true;
  }

  return Boolean(
    msg?.audioMessage ||
      msg?.audio ||
      content?.ptt === true ||
      content?.seconds ||
      content?.waveform
  );
};

const hasProcessableText = (value) => {
  const normalized = String(value || "").trim();
  if (!normalized) return false;

  const placeholders = new Set([
    "[error al descargar el audio]",
    "[audio recibido, pero falló la transcripción]",
    "[audio recibido, pero la transcripción por ia no está configurada]",
    "[audio recibido, pero la transcripcion por ia no esta configurada]",
    "[audio recibido, pero fallo la transcripcion]",
  ]);

  return !placeholders.has(normalized.toLowerCase());
};

const isAudioTranscriptionPlaceholder = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return new Set([
    String(AUDIO_DOWNLOAD_ERROR || "").trim().toLowerCase(),
    String(AUDIO_TRANSCRIPTION_FAILED || "").trim().toLowerCase(),
    String(AUDIO_TRANSCRIPTION_NOT_CONFIGURED || "").trim().toLowerCase(),
    "[audio recibido, pero fallã³ la transcripciã³n]",
    "[audio recibido, pero la transcripciã³n por ia no estã¡ configurada]",
  ]).has(normalized);
};

// ─── Normalize an incoming message ────────────────────────────────────
const normalizeIncomingMessage = (instanceName, raw, webhookData) => {
  const key = raw?.key || {};
  const msg = raw?.message || {};
  const fromMe = key.fromMe === true;
  const isGroup = String(key.remoteJid || "").endsWith("@g.us");
  const phoneNumber = String(key.remoteJid || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/[^\d]/g, "")
    .trim();

  // Determine message type (unwrapped)
  const { type: messageType, content } = unwrapMessage(msg);
  const rawType =
    raw?.messageType ||
    raw?.type ||
    webhookData?.data?.messageType ||
    messageType;

  const text = extractTextFromMessage(msg, content);
  const isAudio = detectAudioMessage({ rawType, messageType, content, msg });

  return {
    instanceName,
    messageId: key.id || null,
    phoneNumber,
    pushName: raw.pushName || "",
    text,
    fromMe,
    isGroup,
    messageType,
    rawType,
    isAudio,
    timestamp: raw.messageTimestamp || Date.now(),
    raw,
  };
};

// ─── In-memory recent messages store (for frontend) ───────────────────
const recentMessagesStore = new Map();
const MAX_RECENT = 100;

const storeRecentMessage = (instanceName, normalized) => {
  const key = normalizeInstanceName(instanceName);
  if (!recentMessagesStore.has(key)) recentMessagesStore.set(key, []);
  const list = recentMessagesStore.get(key);
  list.push({
    id: normalized.messageId,
    from: normalized.phoneNumber,
    pushName: normalized.pushName,
    text: normalized.text,
    fromMe: normalized.fromMe,
    isGroup: normalized.isGroup,
    timestamp: normalized.timestamp,
  });
  if (list.length > MAX_RECENT) list.splice(0, list.length - MAX_RECENT);
};

const getRecentMessages = (instanceName) => {
  return recentMessagesStore.get(normalizeInstanceName(instanceName)) || [];
};

// ─── Process incoming messages (AI pipeline) ──────────────────────────
const processIncomingMessage = async ({ instanceName, webhookData }) => {
  const messages = extractIncomingMessages(webhookData);
  const ignoredPhones = await getIgnoredPhonesForInstance(instanceName);

  if (!messages.length) {
    console.log("📡 Evento de WhatsApp recibido (sin mensajes):", {
      instanceName,
      event: webhookData?.event || webhookData?.type || "unknown",
    });
    return;
  }

  // Lazy-load AI to avoid circular deps at startup
  const { runSupportAssistant, runWhatsappAssistant } = require("./ai/geminiService");

  for (const message of messages) {
    const normalized = normalizeIncomingMessage(instanceName, message, webhookData);
    storeRecentMessage(instanceName, normalized);

    console.log("📩 Mensaje entrante:", {
      instanceName,
      from: normalized.phoneNumber,
      pushName: normalized.pushName,
      text: String(normalized.text || "").slice(0, 100),
      fromMe: normalized.fromMe,
      isGroup: normalized.isGroup,
    });

    // Skip groups, self-messages, or messages without phone
    if (normalized.isGroup) { console.log("⏭️ Ignorado: es grupo"); continue; }
    if (normalized.fromMe) { console.log("⏭️ Ignorado: fromMe=true"); continue; }
    if (!normalized.phoneNumber) { console.log("⏭️ Ignorado: sin teléfono"); continue; }

    if (ignoredPhones.has(normalized.phoneNumber)) {
      console.log("â­ï¸ Ignorado por blacklist:", {
        instanceName,
        from: normalized.phoneNumber,
      });
      continue;
    }

    // Check connection state
    const connectionState = await getSafeConnectionState(instanceName);
    const staticStatus = connectionState?.instance?.state || connectionState?.state || "unknown";
    if (staticStatus !== "open") { console.log("⏭️ Ignorado: instancia no abierta, status:", staticStatus); continue; }

    // Audio Transcription logic
    if (normalized.isAudio) {
      console.log("🎙️ Procesando mensaje de audio...");
      const transcript = await processAudioMessage(instanceName, normalized.messageId);
      normalized.text = transcript;
      console.log("📝 Audio transcrito:", transcript);
    } else {
      console.log("ℹ️ Tipo de mensaje:", normalized.rawType || normalized.messageType);
    }

    if (!hasProcessableText(normalized.text)) {
      console.log("⏭️ Ignorado: mensaje sin contenido procesable", {
        instanceName,
        from: normalized.phoneNumber,
        messageId: normalized.messageId,
        messageType: normalized.rawType || normalized.messageType,
      });
      continue;
    }

    console.log("🧠 Ejecutando asistente IA para:", normalized.phoneNumber);

    try {
      const aiResponse = normalizeInstanceName(instanceName) === normalizeInstanceName(SUPPORT_INSTANCE_NAME)
        ? await runSupportAssistant({ incomingMessage: normalized })
        : await runWhatsappAssistant({
            instanceName,
            incomingMessage: normalized,
          });

      console.log("🤖 Resultado IA:", {
        enabled: aiResponse?.enabled,
        hasText: Boolean(aiResponse?.text),
        reason: aiResponse?.reason || null,
        textPreview: (aiResponse?.text || "").slice(0, 150),
      });

      if (aiResponse?.enabled && aiResponse?.text) {
        await sendTextMessage(normalized.phoneNumber, aiResponse.text, instanceName);
        console.log("✅ Respuesta IA enviada a:", normalized.phoneNumber);
      } else {
        console.log("ℹ️ IA no respondió:", aiResponse?.reason || "sin razón");
      }
    } catch (error) {
      console.error("❌ Error ejecutando asistente IA:", error.message, error.stack?.slice(0, 300));
    }
  }
};

module.exports = {
  buildInstanceName,
  createInstanceWithQr,
  clearLatestQr,
  disconnectInstance,
  extractIncomingMessages,
  getConnectionState,
  getLatestQr,
  getRecentMessages,
  getSafeConnectionState,
  hasProcessableText,
  normalizeInstanceName,
  normalizeIncomingMessage,
  normalizeQrPayload,
  processIncomingMessage,
  registerWebhook,
  sendTextMessage,
  storeLatestQr,
};
