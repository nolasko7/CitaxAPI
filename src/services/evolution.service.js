const axios = require("axios");
const {
  processAudioMessage,
  AUDIO_DOWNLOAD_ERROR,
  AUDIO_TRANSCRIPTION_FAILED,
  AUDIO_TRANSCRIPTION_NOT_CONFIGURED,
} = require("./ai/audioTranscriptionGroqService");
const pool = require("../config/db");
const {
  getEvolutionApiConfig,
  getEvolutionRequestHeaders,
} = require("./evolutionConfig.service");
const {
  buildPhoneVariants,
  getConfiguredSupportPhones,
  getIgnoredInternalPhonesForInstance,
  normalizeWhatsappPhone,
} = require("./internalWhatsapp.service");

const { baseUrl: EVOLUTION_API_URL, apiKey: EVOLUTION_API_KEY } =
  getEvolutionApiConfig();
const EVOLUTION_WEBHOOK_ENABLED =
  (process.env.EVOLUTION_WEBHOOK_ENABLED || "true") === "true";
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "";
const WHATSAPP_INSTANCE_PREFIX =
  process.env.WHATSAPP_INSTANCE_PREFIX || "citax";
const SUPPORT_INSTANCE_NAME = String(
  process.env.SUPPORT_WHATSAPP_INSTANCE || "citax-support-whatsapp",
)
  .trim()
  .toLowerCase();

const parseIgnoredPhonesFromBotConfig = (rawConfig) => {
  try {
    const parsed =
      typeof rawConfig === "string"
        ? JSON.parse(rawConfig || "{}")
        : rawConfig || {};
    const phones = Array.isArray(parsed?.telefonos_ignorados)
      ? parsed.telefonos_ignorados
      : [];
    return new Set(phones.flatMap((phone) => buildPhoneVariants(phone)));
  } catch (_) {
    return new Set();
  }
};

const COMPANY_INTERNAL_PHONES_CACHE_TTL_MS = 60 * 1000;
let companyInternalPhonesCache = {
  expiresAt: 0,
  phones: new Set(),
};

const invalidateCompanyInternalPhonesCache = () => {
  companyInternalPhonesCache = {
    expiresAt: 0,
    phones: new Set(),
  };
};

const getCompanyInternalPhones = async () => {
  if (Date.now() <= companyInternalPhonesCache.expiresAt) {
    return new Set(companyInternalPhonesCache.phones);
  }

  try {
    const [rows] = await pool.execute(
      `SELECT whatsapp_number
       FROM CONFIG_WHATSAPP
       WHERE whatsapp_number IS NOT NULL
         AND TRIM(whatsapp_number) <> ''`,
    );

    const phones = new Set();
    for (const row of rows) {
      for (const variant of buildPhoneVariants(row?.whatsapp_number)) {
        phones.add(variant);
      }
    }

    companyInternalPhonesCache = {
      expiresAt: Date.now() + COMPANY_INTERNAL_PHONES_CACHE_TTL_MS,
      phones,
    };

    return new Set(phones);
  } catch (error) {
    console.error(
      "Error obteniendo telefonos internos de empresas:",
      error.message,
    );
    return new Set();
  }
};

const shouldIgnoreInternalPlatformPhone = async ({
  instanceName,
  phoneNumber,
}) => {
  const normalizedPhone = normalizeWhatsappPhone(phoneNumber);
  if (!normalizedPhone) return false;

  const ignoredInternalPhones = getIgnoredInternalPhonesForInstance({
    currentInstanceName: instanceName,
    supportInstanceName: SUPPORT_INSTANCE_NAME,
    supportPhones: getConfiguredSupportPhones(),
    companyPhones: await getCompanyInternalPhones(),
  });

  const internalPhones = new Set(
    [...ignoredInternalPhones].flatMap((value) => buildPhoneVariants(value)),
  );

  return internalPhones.has(normalizedPhone);
};

const getIgnoredPhonesForInstance = async (instanceName) => {
  try {
    const [rows] = await pool.execute(
      `SELECT e.bot_config
       FROM CONFIG_WHATSAPP cw
       JOIN EMPRESA e ON e.id_empresa = cw.id_empresa
       WHERE cw.instance_name = ?
       LIMIT 1`,
      [instanceName],
    );

    if (!rows.length) return new Set();
    return parseIgnoredPhonesFromBotConfig(rows[0].bot_config);
  } catch (error) {
    console.error("Error obteniendo telefonos ignorados:", error.message);
    return new Set();
  }
};

const isBotActiveForInstance = async (instanceName) => {
  try {
    const [rows] = await pool.execute(
      `SELECT bot_activo
       FROM CONFIG_WHATSAPP
       WHERE instance_name = ?
       LIMIT 1`,
      [instanceName],
    );

    if (!rows.length) return true;
    return Number(rows[0]?.bot_activo) !== 0;
  } catch (error) {
    console.error("Error obteniendo estado bot_activo:", error.message);
    return true;
  }
};

const evolutionClient = axios.create({
  baseURL: EVOLUTION_API_URL,
  headers: getEvolutionRequestHeaders(),
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
    `${WHATSAPP_INSTANCE_PREFIX}-empresa-${companyId}-whatsapp`,
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
      if (
        !normalized.pairingCode &&
        typeof candidate.pairingCode === "string"
      ) {
        normalized.pairingCode = candidate.pairingCode.trim();
      }
      if (!normalized.imageDataUrl && typeof candidate.base64 === "string") {
        normalized.imageDataUrl = ensureImageDataUrl(candidate.base64);
        if (normalized.imageDataUrl) normalized.source = "image";
      }
      if (
        !normalized.imageDataUrl &&
        typeof candidate.imageDataUrl === "string"
      ) {
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
    `/instance/connectionState/${normalizedInstanceName}`,
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
  return (
    qrStore.get(key) || {
      code: "",
      pairingCode: "",
      imageDataUrl: "",
      source: "none",
    }
  );
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
      },
    );
    return { configured: true, webhookUrl, response: response.data };
  } catch (error) {
    return {
      configured: false,
      webhookUrl,
      reason: error.response?.data || error.message,
    };
  }
};

const createInstanceWithQr = async ({
  instanceName,
  number = null,
  companyId,
}) => {
  const resolvedInstanceName = normalizeInstanceName(
    instanceName || buildInstanceName({ companyId }),
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

  const response = await evolutionOpenClient.post(
    "/instance/create-qr",
    payload,
  );

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
      `/instance/logout/${normalizedInstanceName}`,
    );
    clearLatestQr(normalizedInstanceName);
    return {
      success: true,
      instanceName: normalizedInstanceName,
      response: response.data,
    };
  } catch (error) {
    const status = error.response?.status;
    const code = error.code;

    // Instance already gone or Evolution API not reachable â€” treat as success
    if (
      status === 404 ||
      status === 400 ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ECONNABORTED"
    ) {
      return {
        success: true,
        instanceName: normalizedInstanceName,
        response: error.response?.data || {
          message: "Instancia desconectada (o Evolution API no disponible)",
        },
      };
    }
    throw error;
  }
};

// â”€â”€â”€ Send text message via Evolution API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const sendTextMessage = async (phoneNumber, text, instanceName) => {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const number = String(phoneNumber).replace(/[^\d]/g, "");
  const response = await evolutionClient.post(
    `/message/sendText/${normalizedInstanceName}`,
    { number, text },
  );
  return response.data;
};

// â”€â”€â”€ Extract messages from webhook payload â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    Array.isArray(item) ? item : [item],
  );

  if (webhookData?.data) {
    flattenedCandidates.unshift(webhookData.data);
  }

  return flattenedCandidates.filter(
    (item) =>
      item && (item.key || item.message || item.messageType || item.type),
  );
};

// â”€â”€â”€ Help identify the actual message content (skipping wrappers) â”€â”€â”€â”€â”€â”€â”€â”€
const unwrapMessage = (msg) => {
  if (!msg) return { type: "unknown", content: {} };

  if (msg.ephemeralMessage) return unwrapMessage(msg.ephemeralMessage.message);
  if (msg.viewOnceMessage) return unwrapMessage(msg.viewOnceMessage.message);
  if (msg.viewOnceMessageV2)
    return unwrapMessage(msg.viewOnceMessageV2.message);
  if (msg.documentWithCaptionMessage)
    return unwrapMessage(msg.documentWithCaptionMessage.message);

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
    content?.waveform,
  );
};

const normalizeComparableText = (value) => {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s\[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const isAudioTranscriptionPlaceholder = (value) => {
  const normalized = normalizeComparableText(value);
  if (!normalized) return true;

  const placeholders = [
    AUDIO_DOWNLOAD_ERROR,
    AUDIO_TRANSCRIPTION_FAILED,
    AUDIO_TRANSCRIPTION_NOT_CONFIGURED,
    "[Audio recibido, pero falló la transcripción]",
    "[Audio recibido, pero la transcripcion por IA no esta configurada]",
    "[Audio recibido, pero fallo la transcripcion]",
  ].map(normalizeComparableText);

  if (placeholders.includes(normalized)) {
    return true;
  }

  return (
    normalized.includes("descargar el audio") ||
    (normalized.includes("audio recibido") &&
      normalized.includes("transcrip")) ||
    normalized.includes("transcripcion por ia no esta configurada")
  );
};

const hasProcessableText = (value) => {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  return !isAudioTranscriptionPlaceholder(normalized);
};

// â”€â”€â”€ Normalize an incoming message â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ In-memory recent messages store (for frontend) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const recentMessagesStore = new Map();
const MAX_RECENT = 100;
const pendingIncomingMessageBatches = new Map();
const resolveMessageBatchWindowMs = () => {
  const configuredValue =
    process.env.WHATSAPP_MESSAGE_BUFFER_MS ||
    process.env.WHATSAPP_MESSAGE_BATCH_WINDOW_MS ||
    "30000";

  const parsedValue = Number(configuredValue);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : 30000;
};
const WHATSAPP_MESSAGE_BATCH_WINDOW_MS = Number(resolveMessageBatchWindowMs());

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

const getIncomingMessageBatchKey = ({ instanceName, phoneNumber }) =>
  `${normalizeInstanceName(instanceName)}:${normalizeWhatsappPhone(phoneNumber)}`;

const mergeBufferedIncomingMessages = (messages = []) => {
  const normalizedMessages = [...messages]
    .filter((message) => message && hasProcessableText(message.text))
    .sort(
      (left, right) =>
        Number(left?.timestamp || 0) - Number(right?.timestamp || 0),
    );

  if (!normalizedMessages.length) {
    return null;
  }

  const firstMessage = normalizedMessages[0];
  const lastMessage = normalizedMessages[normalizedMessages.length - 1];
  const mergedText = normalizedMessages
    .map((message) => String(message.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  return {
    ...lastMessage,
    pushName: lastMessage.pushName || firstMessage.pushName || "",
    text: mergedText,
    mergedCount: normalizedMessages.length,
    mergedMessageIds: normalizedMessages
      .map((message) => message.messageId)
      .filter(Boolean),
  };
};

const flushIncomingMessageBatch = async (batchKey) => {
  const batch = pendingIncomingMessageBatches.get(batchKey);
  if (!batch) return;

  pendingIncomingMessageBatches.delete(batchKey);
  const mergedMessage = mergeBufferedIncomingMessages(batch.messages);
  if (!mergedMessage) {
    return;
  }

  const instanceName = normalizeInstanceName(batch.instanceName);
  const {
    runSupportAssistant,
    runWhatsappAssistant,
  } = require("./ai/geminiService");

  console.log("🧩 Procesando lote de mensajes:", {
    instanceName,
    from: mergedMessage.phoneNumber,
    count: mergedMessage.mergedCount,
    textPreview: String(mergedMessage.text || "").slice(0, 150),
  });

  try {
    const aiResponse =
      instanceName === normalizeInstanceName(SUPPORT_INSTANCE_NAME)
        ? await runSupportAssistant({ incomingMessage: mergedMessage })
        : await runWhatsappAssistant({
            instanceName,
            incomingMessage: mergedMessage,
          });

    console.log("🤖 Resultado IA:", {
      enabled: aiResponse?.enabled,
      hasText: Boolean(aiResponse?.text),
      reason: aiResponse?.reason || null,
      textPreview: (aiResponse?.text || "").slice(0, 150),
    });

    if (aiResponse?.enabled && aiResponse?.text) {
      await sendTextMessage(
        mergedMessage.phoneNumber,
        aiResponse.text,
        instanceName,
      );
      console.log("✅ Respuesta IA enviada a:", mergedMessage.phoneNumber);
    } else {
      console.log("ℹ️ IA no respondió:", aiResponse?.reason || "sin razón");
    }
  } catch (error) {
    console.error(
      "❌ Error ejecutando asistente IA:",
      error.message,
      error.stack?.slice(0, 300),
    );
  }
};

const enqueueIncomingMessageForAssistant = ({ instanceName, normalized }) => {
  const batchKey = getIncomingMessageBatchKey({
    instanceName,
    phoneNumber: normalized.phoneNumber,
  });

  const existingBatch = pendingIncomingMessageBatches.get(batchKey);
  if (existingBatch) {
    clearTimeout(existingBatch.timer);
    existingBatch.messages.push(normalized);
    existingBatch.timer = setTimeout(() => {
      flushIncomingMessageBatch(batchKey).catch((error) => {
        console.error("❌ Error procesando lote de mensajes:", error.message);
      });
    }, WHATSAPP_MESSAGE_BATCH_WINDOW_MS);
    pendingIncomingMessageBatches.set(batchKey, existingBatch);
    return;
  }

  const batch = {
    instanceName,
    phoneNumber: normalized.phoneNumber,
    messages: [normalized],
    timer: setTimeout(() => {
      flushIncomingMessageBatch(batchKey).catch((error) => {
        console.error("❌ Error procesando lote de mensajes:", error.message);
      });
    }, WHATSAPP_MESSAGE_BATCH_WINDOW_MS),
  };

  pendingIncomingMessageBatches.set(batchKey, batch);
};

// â”€â”€â”€ Process incoming messages (AI pipeline) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const processIncomingMessage = async ({ instanceName, webhookData }) => {
  const messages = extractIncomingMessages(webhookData);
  const ignoredPhones = await getIgnoredPhonesForInstance(instanceName);
  const botActive = await isBotActiveForInstance(instanceName);

  if (!messages.length) {
    console.log("ðŸ“¡ Evento de WhatsApp recibido (sin mensajes):", {
      instanceName,
      event: webhookData?.event || webhookData?.type || "unknown",
    });
    return;
  }

  if (!botActive) {
    console.log("⏭️ Bot desactivado para instancia, se ignoran mensajes:", {
      instanceName,
      count: messages.length,
    });
    return;
  }

  for (const message of messages) {
    const normalized = normalizeIncomingMessage(
      instanceName,
      message,
      webhookData,
    );
    storeRecentMessage(instanceName, normalized);

    console.log("ðŸ“© Mensaje entrante:", {
      instanceName,
      from: normalized.phoneNumber,
      pushName: normalized.pushName,
      text: String(normalized.text || "").slice(0, 100),
      fromMe: normalized.fromMe,
      isGroup: normalized.isGroup,
    });

    // Skip groups, self-messages, or messages without phone
    if (normalized.isGroup) {
      console.log("â­ï¸ Ignorado: es grupo");
      continue;
    }
    if (normalized.fromMe) {
      console.log("â­ï¸ Ignorado: fromMe=true");
      continue;
    }
    if (!normalized.phoneNumber) {
      console.log("â­ï¸ Ignorado: sin telÃ©fono");
      continue;
    }

    if (ignoredPhones.has(normalized.phoneNumber)) {
      console.log("Ã¢ÂÂ­Ã¯Â¸Â Ignorado por blacklist:", {
        instanceName,
        from: normalized.phoneNumber,
      });
      continue;
    }
    if (
      await shouldIgnoreInternalPlatformPhone({
        instanceName,
        phoneNumber: normalized.phoneNumber,
      })
    ) {
      console.log("⏭️ Ignorado: numero interno de plataforma", {
        instanceName,
        from: normalized.phoneNumber,
      });
      continue;
    }

    // Check connection state
    const connectionState = await getSafeConnectionState(instanceName);
    const staticStatus =
      connectionState?.instance?.state || connectionState?.state || "unknown";
    if (staticStatus !== "open") {
      console.log("â­ï¸ Ignorado: instancia no abierta, status:", staticStatus);
      continue;
    }

    // Audio Transcription logic
    if (normalized.isAudio) {
      console.log("ðŸŽ™ï¸ Procesando mensaje de audio...");
      const transcript = await processAudioMessage(
        instanceName,
        normalized.messageId,
      );
      normalized.text = transcript;
      console.log("ðŸ“ Audio transcrito:", transcript);
    } else {
      console.log(
        "â„¹ï¸ Tipo de mensaje:",
        normalized.rawType || normalized.messageType,
      );
    }

    if (!hasProcessableText(normalized.text)) {
      console.log("â­ï¸ Ignorado: mensaje sin contenido procesable", {
        instanceName,
        from: normalized.phoneNumber,
        messageId: normalized.messageId,
        messageType: normalized.rawType || normalized.messageType,
      });
      continue;
    }

    console.log("🧠 Encolando mensaje para IA:", normalized.phoneNumber);
    enqueueIncomingMessageForAssistant({ instanceName, normalized });
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
  invalidateCompanyInternalPhonesCache,
  mergeBufferedIncomingMessages,
  normalizeInstanceName,
  normalizeIncomingMessage,
  normalizeQrPayload,
  processIncomingMessage,
  registerWebhook,
  sendTextMessage,
  storeLatestQr,
};
