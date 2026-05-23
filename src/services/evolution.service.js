const axios = require("axios");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
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
const {
  getEffectiveInitialSurvey,
} = require("./singleProviderMode.service");
const { parseSqlDateTimeAsUtc } = require("../utils/appointmentDateInterop");

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

const looksLikeUtf8Mojibake = (value) =>
  /Ã.|Â.|â.|├|┬/.test(String(value || ""));

const normalizeOutboundText = (value) => {
  const text = String(value ?? "");
  if (!text || !looksLikeUtf8Mojibake(text)) return text;

  try {
    const repaired = Buffer.from(text, "latin1").toString("utf8");
    return repaired && !looksLikeUtf8Mojibake(repaired) ? repaired : text;
  } catch {
    return text;
  }
};

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
          events: [
            "MESSAGES_UPSERT",
            "MESSAGES_UPDATE",
            "QRCODE_UPDATED",
            "CONNECTION_UPDATE",
          ],
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

  let response;
  try {
    response = await evolutionOpenClient.post("/instance/create-qr", payload);
    // Delay de seguridad de 2 segundos para instancias nuevas
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (error) {
    // Si la instancia ya existe, Evolution devuelve 400. En ese caso simplemente nos conectamos.
    if (error.response?.status === 400 || error.response?.status === 403) {
      response = await evolutionOpenClient.get(
        `/instance/connect/${resolvedInstanceName}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else {
      throw error;
    }
  }

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

// ─── Send text message via Evolution API ──────────────────────────────
const sendTextMessage = async (
  phoneNumber,
  text,
  instanceName,
  { suppressErrorLog = false } = {},
) => {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const number = String(phoneNumber).replace(/[^\d]/g, "");
  const normalizedText = normalizeOutboundText(text);
  logger.debug(
    `sendTextMessage | instance=${normalizedInstanceName} | to=${number} | textLen=${normalizedText?.length || 0}`,
  );
  try {
    const response = await evolutionClient.post(
      `/message/sendText/${normalizedInstanceName}`,
      { number, text: normalizedText },
    );
    rememberBotOutboundMessage({
      instanceName: normalizedInstanceName,
      phoneNumber: number,
      text: normalizedText,
      responseData: response.data,
    });
    return response.data;
  } catch (error) {
    if (!suppressErrorLog) {
      console.error(
        `sendTextMessage FAILED | instance=${normalizedInstanceName} | to=${number}`,
      );
      console.error("  status:", error.response?.status);
      console.error(
        "  data:",
        JSON.stringify(error.response?.data || {}, null, 2),
      );
      console.error("  url:", error.config?.baseURL + error.config?.url);
    }
    throw error;
  }
};

const buildOutboundPhoneCandidates = ({ phoneNumber, referencePhone }) => {
  const raw = normalizeWhatsappPhone(phoneNumber);
  if (!raw) return [];

  const candidates = new Set([raw]);
  const reference = normalizeWhatsappPhone(referencePhone);

  if (reference) {
    const wants549 = reference.startsWith("549");
    const wants54 = reference.startsWith("54");

    if (wants549 || wants54) {
      if (!raw.startsWith("54")) {
        candidates.add(`54${raw}`);
      }
      if (!raw.startsWith("549")) {
        candidates.add(`549${raw}`);
      }
    }
  }

  return [...candidates];
};

const sendTextMessageWithFallback = async ({
  phoneNumber,
  referencePhone,
  text,
  instanceName,
}) => {
  const candidates = buildOutboundPhoneCandidates({
    phoneNumber,
    referencePhone,
  });
  let lastError = null;

  for (const candidate of candidates) {
    try {
      await sendTextMessage(candidate, text, instanceName, {
        suppressErrorLog: candidates.length > 1,
      });
      return { sent: true, candidate };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return { sent: false, candidate: "" };
};

const getInitialSurveyForInstance = async (instanceName) => {
  const normalizedInstanceName = normalizeInstanceName(instanceName);

  try {
    const [rows] = await pool.execute(
      `SELECT e.bot_config
       FROM CONFIG_WHATSAPP cw
       JOIN EMPRESA e ON e.id_empresa = cw.id_empresa
       WHERE cw.instance_name = ?
       LIMIT 1`,
      [normalizedInstanceName],
    );

    if (!rows.length) {
      return getEffectiveInitialSurvey({});
    }

    return getEffectiveInitialSurvey(rows[0].bot_config);
  } catch (error) {
    console.error(
      "Error resolviendo encuesta inicial para la instancia:",
      normalizedInstanceName,
      error.message,
    );
    return getEffectiveInitialSurvey({});
  }
};

const buildInitialSurveyPollPayloadCandidates = ({ number, survey }) => {
  const question = String(survey?.question || "").trim();
  const optionLabels = Array.isArray(survey?.options)
    ? survey.options.map((option) => option.label).filter(Boolean)
    : [];

  return [
    {
      number,
      name: question,
      selectableCount: 1,
      values: optionLabels,
    },
    {
      number,
      title: question,
      options: optionLabels,
      selectableCount: 1,
    },
  ];
};

const buildInitialSurveyFallbackText = (survey) => {
  const question = String(survey?.question || "").trim();
  const optionLabels = Array.isArray(survey?.options)
    ? survey.options.map((option) => option.label).filter(Boolean)
    : [];

  return `${question} Respondé: ${optionLabels.join(" / ")}`.trim();
};

const sendPollMessage = async (phoneNumber, instanceName) => {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const number = String(phoneNumber).replace(/[^\d]/g, "");
  const survey = await getInitialSurveyForInstance(normalizedInstanceName);
  const payloadCandidates = buildInitialSurveyPollPayloadCandidates({
    number,
    survey,
  });
  const surveySnapshot = {
    question: survey.question,
    options: survey.options.map((option) => ({
      action: option.action,
      label: option.label,
    })),
    personalizada: survey.personalizada === true,
    allowLegacyYesNo: survey.personalizada !== true,
  };
  let lastError = null;

  for (const payload of payloadCandidates) {
    try {
      const response = await evolutionClient.post(
        `/message/sendPoll/${normalizedInstanceName}`,
        payload,
      );
      return {
        sent: true,
        provider: "poll",
        data: response.data,
        surveySnapshot,
      };
    } catch (error) {
      lastError = error;
      console.warn("Fallo envio poll con payload, intento siguiente:", {
        instanceName: normalizedInstanceName,
        number,
        status: error.response?.status || null,
        message: error.message,
      });
    }
  }

  await sendTextMessage(
    number,
    buildInitialSurveyFallbackText(survey),
    normalizedInstanceName,
  );
  return {
    sent: true,
    provider: "text-fallback",
    fallbackReason: lastError?.message || null,
    surveySnapshot: {
      ...surveySnapshot,
      provider: "text-fallback",
    },
  };
};

const sendSupportMenuPoll = async (phoneNumber, instanceName) => {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const number = String(phoneNumber).replace(/[^\d]/g, "");

  const pollName = "Que necesitas hacer?";
  const options = [
    "📅 Ver turnos de un dia",
    "❌ Cancelar un turno",
    "🔄 Mover/Reprogramar un turno",
    "📝 Agendar un turno",
  ];

  const payloadCandidates = [
    {
      number,
      name: pollName,
      selectableCount: 1,
      values: options,
    },
    {
      number,
      title: pollName,
      options,
      selectableCount: 1,
    },
  ];

  let lastError = null;

  for (const payload of payloadCandidates) {
    try {
      const response = await evolutionClient.post(
        `/message/sendPoll/${normalizedInstanceName}`,
        payload,
      );
      return { sent: true, provider: "poll", data: response.data };
    } catch (error) {
      lastError = error;
      console.warn("⚠️ Falló envío poll soporte, intento siguiente:", {
        instanceName: normalizedInstanceName,
        number,
        status: error.response?.status || null,
        message: error.message,
      });
    }
  }

  const fallbackText =
    "Que necesitas hacer? Respondé: Ver turnos / Cancelar / Mover o reprogramar / Agendar";
  await sendTextMessage(number, fallbackText, normalizedInstanceName);
  return {
    sent: true,
    provider: "text-fallback",
    fallbackReason: lastError?.message || null,
  };
};

// ─── Pending poll confirmations tracking ──────────────────────────────
const pendingPollConfirmations = new Map();

const POLL_CONFIRM_OPTION = "✅ Confirmar turno";
const POLL_REJECT_OPTION = "❌ Rechazar turno";

const sendAppointmentConfirmationPoll = async ({
  phoneNumber,
  instanceName,
  turnoId,
  notificationText,
  companyId,
}) => {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const number = String(phoneNumber).replace(/[^\d]/g, "");

  // 1. Enviar texto con info del turno
  await sendTextMessage(number, notificationText, normalizedInstanceName);

  // 2. Enviar poll de confirmación
  const pollName = `Turno #${turnoId} - ¿Confirmar?`;
  const payloadCandidates = [
    {
      number,
      name: pollName,
      selectableCount: 1,
      values: [POLL_CONFIRM_OPTION, POLL_REJECT_OPTION],
    },
    {
      number,
      title: pollName,
      options: [POLL_CONFIRM_OPTION, POLL_REJECT_OPTION],
      selectableCount: 1,
    },
  ];

  let pollSent = false;
  for (const payload of payloadCandidates) {
    try {
      await evolutionClient.post(
        `/message/sendPoll/${normalizedInstanceName}`,
        payload,
      );
      pollSent = true;
      break;
    } catch (error) {
      console.warn(
        "⚠️ Falló envío poll confirmación, intento siguiente:",
        error.message,
      );
    }
  }

  // Registrar la poll pendiente para poder asociar la respuesta al turno
  pendingPollConfirmations.set(`${number}:${turnoId}`, {
    turnoId,
    phoneNumber: number,
    instanceName: normalizedInstanceName,
    companyId: companyId || null,
    pollName,
    createdAt: Date.now(),
  });

  // Cleanup de polls viejas (>24h)
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  for (const [key, entry] of pendingPollConfirmations) {
    if (Date.now() - entry.createdAt > ONE_DAY_MS) {
      pendingPollConfirmations.delete(key);
    }
  }

  if (!pollSent) {
    // Fallback: indicar que responda con texto
    console.warn(
      `No se pudo enviar poll para turno #${turnoId}, se envió solo texto.`,
    );
  }

  return { sent: true, pollSent, turnoId };
};

// ─── Handle appointment poll response ─────────────────────────────────
const resolveAppointmentPollResponse = (normalized) => {
  const raw = normalized?.raw || {};

  // Self-contained collectors to avoid dependency on functions defined later
  const collectValuesByKeyRegex = (obj, keyRegex, bucket = []) => {
    if (!obj || typeof obj !== "object") return bucket;

    for (const [key, value] of Object.entries(obj)) {
      if (keyRegex.test(key)) {
        bucket.push(value);
      }
      if (Array.isArray(value)) {
        value.forEach((entry) =>
          collectValuesByKeyRegex(entry, keyRegex, bucket),
        );
      } else if (value && typeof value === "object") {
        collectValuesByKeyRegex(value, keyRegex, bucket);
      }
    }

    return bucket;
  };

  const flattenedSelectionValues = collectValuesByKeyRegex(
    raw,
    /(selectedOptions?|selectedOptionName|optionName|option)/i,
    [],
  )
    .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    .filter((entry) => entry !== undefined && entry !== null);

  const selectedTextValues = flattenedSelectionValues
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const normalizedSelectedText = selectedTextValues.map((value) =>
    value.toLowerCase(),
  );

  const isReject = normalizedSelectedText.some((value) =>
    value.includes("rechazar turno"),
  );
  const isConfirm = normalizedSelectedText.some((value) =>
    value.includes("confirmar turno"),
  );

  if (isReject) return { action: "reject" };
  if (isConfirm) return { action: "confirm" };

  const selectionNumbers = flattenedSelectionValues
    .map((entry) => (typeof entry === "number" ? entry : Number(entry)))
    .filter((value) => Number.isInteger(value));

  if (selectionNumbers.includes(0) && selectionNumbers.includes(1)) {
    return null;
  }
  if (selectionNumbers.includes(0)) return { action: "confirm" };
  if (selectionNumbers.includes(1)) return { action: "reject" };

  return null;
};

const handleAppointmentPollConfirmation = async (instanceName, normalized) => {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  // NOTE: The confirmation poll is sent FROM the support instance TO the company owner's number.
  // However, the poll RESPONSE arrives on the company's own instance (the owner's phone is
  // registered there). So we allow ANY instance to process pending poll confirmations.

  // Check if this is a poll response matching our confirmation poll
  const pollResponse = resolveAppointmentPollResponse(normalized);
  if (!pollResponse) return false;

  const ownerPhone = normalized.phoneNumber;
  logger.info(
    `Poll confirmación turno | from=${ownerPhone} | action=${pollResponse.action}`,
  );

  // Find the pending poll for this phone
  let matchedEntry = null;
  for (const [key, entry] of pendingPollConfirmations) {
    if (key.startsWith(`${ownerPhone}:`)) {
      matchedEntry = entry;
      pendingPollConfirmations.delete(key);
      break;
    }
  }

  if (!matchedEntry) {
    console.warn(`No se encontró poll pendiente para ${ownerPhone}`);
    return true; // Still consumed the message
  }

  const turnoId = matchedEntry.turnoId;

  if (pollResponse.action === "confirm") {
    await handleOwnerConfirmationCommand(
      instanceName,
      ownerPhone,
      turnoId,
      matchedEntry.companyId,
    );
  } else {
    // Reject
    try {
      await pool.execute("UPDATE TURNO SET estado = ? WHERE id_turno = ?", [
        "cancelado",
        turnoId,
      ]);
      await sendTextMessage(
        ownerPhone,
        `Turno #${turnoId} rechazado. El turno fue cancelado.`,
        normalizedInstanceName,
      );
      const [rows] = await pool.execute(
        `SELECT t.fecha_hora, c.whatsapp_id, c.nombre_wa, s.nombre AS servicio_nombre,
                e.nombre_comercial, cw.whatsapp_number
         FROM TURNO t
         JOIN CLIENTE c ON c.id_cliente = t.id_cliente
         JOIN SERVICIO s ON s.id_servicio = t.id_servicio
         JOIN EMPRESA e ON e.id_empresa = c.id_empresa
         LEFT JOIN CONFIG_WHATSAPP cw ON cw.id_empresa = e.id_empresa
         WHERE t.id_turno = ?
         LIMIT 1`,
        [turnoId],
      );

      const turno = rows[0];
      if (turno?.whatsapp_id) {
        const fechaOptions = { weekday: "long", day: "numeric", month: "long", timeZone: "America/Argentina/Buenos_Aires" };
        const fechaStr = new Date(turno.fecha_hora).toLocaleDateString(
          "es-AR",
          fechaOptions,
        );
        const horaStr = new Date(turno.fecha_hora).toLocaleTimeString("es-AR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Argentina/Buenos_Aires",
        });
        const clientMessage = `Hola ${turno.nombre_wa || ""}! 👋\n\nTu turno para *${turno.servicio_nombre}* el día *${fechaStr}* a las *${horaStr}* fue rechazado por ${turno.nombre_comercial}.\n\nSi querés, podés solicitar otro turno desde la web o por WhatsApp.`;
        const companyInstanceName = matchedEntry.companyId
          ? buildInstanceName({ companyId: matchedEntry.companyId })
          : normalizedInstanceName;

        await sendTextMessageWithFallback({
          phoneNumber: turno.whatsapp_id,
          referencePhone: turno.whatsapp_number || ownerPhone,
          text: clientMessage,
          instanceName: companyInstanceName,
        });
      }
    } catch (error) {
      console.error("Error rechazando turno:", error.message);
    }
  }

  return true;
};

// ─── Extract messages from webhook payload ──────────────────────────────
const extractIncomingMessages = (webhookData) => {
  if (!webhookData) return [];
  const event = webhookData.event || webhookData.type || "";
  const allowedEvents = new Set(["messages.upsert", "messages.update"]);
  if (!allowedEvents.has(event)) return [];
  const candidateLists = [
    webhookData?.data?.messages,
    webhookData?.data?.updates,
    webhookData?.data?.message,
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
const whatsappConversationGate = new Map();
const recentBotOutboundByConversation = new Map();
const recentBotOutboundMessageIds = new Map();
const BOT_OUTBOUND_TTL_MS = 2 * 60 * 1000;
const WHATSAPP_PENDING_SURVEY_TTL_MS =
  Number(process.env.WHATSAPP_PENDING_SURVEY_TTL_HOURS || 72) * 60 * 60 * 1000;
const WHATSAPP_OPTED_IN_TTL_MS =
  Number(process.env.WHATSAPP_OPTED_IN_TTL_HOURS || 12) * 60 * 60 * 1000;
const WHATSAPP_FLOW_INACTIVITY_TTL_MS =
  Number(process.env.WHATSAPP_FLOW_INACTIVITY_TTL_MINUTES || 60) * 60 * 1000;
const WHATSAPP_NO_REPLY_MUTE_MS =
  Number(process.env.WHATSAPP_NO_REPLY_MUTE_HOURS || 12) * 60 * 60 * 1000;
const WHATSAPP_CONVERSATION_LOG_ENABLED =
  (process.env.WHATSAPP_CONVERSATION_LOG_ENABLED || "true") === "true";
const WHATSAPP_VERBOSE_LOGS =
  (process.env.WHATSAPP_VERBOSE_LOGS || "false") === "true";
const WHATSAPP_CONVERSATION_LOG_FILE =
  process.env.WHATSAPP_CONVERSATION_LOG_FILE ||
  path.join(__dirname, "../logs/whatsapp_conversations.ndjson");

const maskPhoneForLog = (value) => {
  const raw = String(value || "").replace(/[^\d]/g, "");
  if (!raw) return "unknown";
  if (raw.length <= 4) return raw;
  return `***${raw.slice(-4)}`;
};

const compactText = (value, max = 80) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const appendConversationLog = (entry = {}) => {
  if (!WHATSAPP_CONVERSATION_LOG_ENABLED) return;

  try {
    fs.mkdirSync(path.dirname(WHATSAPP_CONVERSATION_LOG_FILE), {
      recursive: true,
    });
    fs.appendFileSync(
      WHATSAPP_CONVERSATION_LOG_FILE,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch (error) {
    console.error("⚠️ No se pudo escribir log de conversacion:", error.message);
  }
};

const verboseLog = (...args) => {
  if (WHATSAPP_VERBOSE_LOGS) {
    logger.debug(args.join(" "));
  }
};

const resolveMessageBatchWindowMs = () => {
  const configuredValue =
    process.env.WHATSAPP_MESSAGE_BUFFER_MS ||
    process.env.WHATSAPP_MESSAGE_BATCH_WINDOW_MS ||
    "30000";

  const parsed = Number(configuredValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
};
const WHATSAPP_MESSAGE_BATCH_WINDOW_MS = resolveMessageBatchWindowMs();

const getConversationGateKey = ({ instanceName, phoneNumber }) =>
  `${normalizeInstanceName(instanceName)}:${normalizeWhatsappPhone(phoneNumber)}`;

const getConversationKey = ({ instanceName, phoneNumber }) =>
  `${normalizeInstanceName(instanceName)}:${normalizeWhatsappPhone(phoneNumber)}`;

const normalizeSurveyText = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const rememberBotOutboundMessage = ({
  instanceName,
  phoneNumber,
  text,
  responseData,
}) => {
  const conversationKey = getConversationKey({ instanceName, phoneNumber });
  if (!conversationKey) return;

  const now = Date.now();
  const normalizedText = normalizeComparableText(text);
  const existing = recentBotOutboundByConversation.get(conversationKey) || [];
  const retained = existing.filter(
    (entry) => now - entry.sentAt <= BOT_OUTBOUND_TTL_MS,
  );
  retained.push({ normalizedText, sentAt: now });
  recentBotOutboundByConversation.set(conversationKey, retained);

  const strings = collectStringValues(responseData || {}).filter(Boolean);
  for (const value of strings) {
    const candidate = String(value).trim();
    if (candidate.length >= 8 && /[a-z0-9]/i.test(candidate)) {
      recentBotOutboundMessageIds.set(candidate, now);
    }
  }
};

const isWebhookFromKnownBotOutbound = ({
  instanceName,
  phoneNumber,
  text,
  messageId,
}) => {
  const now = Date.now();

  for (const [id, seenAt] of recentBotOutboundMessageIds.entries()) {
    if (now - seenAt > BOT_OUTBOUND_TTL_MS) {
      recentBotOutboundMessageIds.delete(id);
    }
  }

  if (messageId && recentBotOutboundMessageIds.has(messageId)) {
    recentBotOutboundMessageIds.delete(messageId);
    return true;
  }

  const conversationKey = getConversationKey({ instanceName, phoneNumber });
  if (!conversationKey) return false;

  const entries = recentBotOutboundByConversation.get(conversationKey) || [];
  const retained = entries.filter(
    (entry) => now - entry.sentAt <= BOT_OUTBOUND_TTL_MS,
  );
  if (!retained.length) {
    recentBotOutboundByConversation.delete(conversationKey);
    return false;
  }

  const normalizedText = normalizeComparableText(text);
  if (!normalizedText) {
    recentBotOutboundByConversation.set(conversationKey, retained);
    return false;
  }

  const matchedIndex = retained.findIndex(
    (entry) => entry.normalizedText && entry.normalizedText === normalizedText,
  );

  if (matchedIndex === -1) {
    recentBotOutboundByConversation.set(conversationKey, retained);
    return false;
  }

  retained.splice(matchedIndex, 1);
  if (retained.length) {
    recentBotOutboundByConversation.set(conversationKey, retained);
  } else {
    recentBotOutboundByConversation.delete(conversationKey);
  }

  return true;
};

const isGreetingCandidate = (value) => {
  const normalized = normalizeSurveyText(value);
  if (!normalized) return false;

  const greetingPrefixes = [
    "hola",
    "holaa",
    "holaaa",
    "holi",
    "buen dia",
    "buenas",
    "buenas tardes",
    "buenas noches",
  ];

  return greetingPrefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
  );
};

const collectStringValues = (value, bucket = []) => {
  if (typeof value === "string") {
    bucket.push(value);
    return bucket;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStringValues(entry, bucket));
    return bucket;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => collectStringValues(entry, bucket));
  }
  return bucket;
};

const getNestedValue = (source, path) => {
  return path.split(".").reduce((acc, segment) => {
    if (!acc || typeof acc !== "object") return undefined;
    return acc[segment];
  }, source);
};

const collectStringsFromKeyHints = (value, keyRegex, bucket = []) => {
  if (!value || typeof value !== "object") return bucket;

  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string" && keyRegex.test(key)) {
      bucket.push(nested);
      continue;
    }

    if (Array.isArray(nested) || (nested && typeof nested === "object")) {
      if (keyRegex.test(key)) {
        collectStringValues(nested, bucket);
      }
      collectStringsFromKeyHints(nested, keyRegex, bucket);
    }
  }

  return bucket;
};

const SURVEY_SELECTION_PATHS = [
  "pollUpdateMessage.vote.selectedOptions",
  "message.pollUpdateMessage.vote.selectedOptions",
  "data.pollUpdateMessage.vote.selectedOptions",
  "pollResponseMessage.vote.selectedOptions",
  "message.pollResponseMessage.vote.selectedOptions",
  "data.pollResponseMessage.vote.selectedOptions",
  "pollUpdateMessage.selectedOptions",
  "pollUpdateMessage.votes",
  "pollUpdateMessage.options",
  "pollUpdateMessage.selectedOption",
  "pollUpdateMessage.selectedOptionName",
  "pollUpdateMessage.optionName",
  "pollResponseMessage.selectedOptions",
  "pollResponseMessage.votes",
  "pollResponseMessage.options",
  "pollResponseMessage.selectedOption",
  "pollResponseMessage.selectedOptionName",
  "pollResponseMessage.optionName",
  "message.pollUpdateMessage.selectedOptions",
  "message.pollUpdateMessage.votes",
  "message.pollUpdateMessage.options",
  "message.pollUpdateMessage.selectedOption",
  "message.pollUpdateMessage.selectedOptionName",
  "message.pollUpdateMessage.optionName",
  "message.pollResponseMessage.selectedOptions",
  "message.pollResponseMessage.votes",
  "message.pollResponseMessage.options",
  "message.pollResponseMessage.selectedOption",
  "message.pollResponseMessage.selectedOptionName",
  "message.pollResponseMessage.optionName",
  "data.pollUpdateMessage.selectedOptions",
  "data.pollUpdateMessage.votes",
  "data.pollUpdateMessage.options",
  "data.pollUpdateMessage.selectedOption",
  "data.pollUpdateMessage.selectedOptionName",
  "data.pollUpdateMessage.optionName",
  "data.pollResponseMessage.selectedOptions",
  "data.pollResponseMessage.votes",
  "data.pollResponseMessage.options",
  "data.pollResponseMessage.selectedOption",
  "data.pollResponseMessage.selectedOptionName",
  "data.pollResponseMessage.optionName",
];

const POLL_UPDATES_PATHS = [
  "pollUpdates",
  "data.pollUpdates",
  "message.pollUpdates",
  "pollUpdateMessage.pollUpdates",
  "message.pollUpdateMessage.pollUpdates",
  "data.pollUpdateMessage.pollUpdates",
  "pollResponseMessage.pollUpdates",
  "message.pollResponseMessage.pollUpdates",
  "data.pollResponseMessage.pollUpdates",
];

const extractSelectedOptionsFromPollUpdates = (raw = {}) => {
  const updates = POLL_UPDATES_PATHS.map((path) =>
    getNestedValue(raw, path),
  ).flatMap((value) => (Array.isArray(value) ? value : []));

  return updates
    .filter((entry) => entry && typeof entry === "object")
    .filter((entry) => Array.isArray(entry.voters) && entry.voters.length > 0)
    .map((entry) =>
      String(
        entry.name || entry.optionName || entry.selectedOption || "",
      ).trim(),
    )
    .filter(Boolean);
};

const resolveYesNoFromValues = (values = []) => {
  const normalizedValues = values
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .map((entry) => ({
      raw: entry,
      normalized: normalizeSurveyText(entry),
    }))
    .filter(({ raw, normalized }) => {
      if (!normalized) return false;
      const rawLower = raw.toLowerCase();
      if (rawLower.includes("@s.whatsapp.net")) return false;
      if (rawLower.includes("@g.us")) return false;
      if (/^\d{8,}$/.test(raw.replace(/\D/g, ""))) return false;
      return true;
    });

  const hasYes = normalizedValues.some(
    ({ normalized }) =>
      normalized.includes("quiero sacar un turno") ||
      normalized.includes("sacar un turno") ||
      normalized.includes("necesito cancelar un turno") ||
      normalized.includes("cancelar un turno") ||
      normalized.includes("quiero cambiar el horario") ||
      normalized.includes("cambiar el horario") ||
      normalized.includes("cambiar un turno") ||
      /\b(si|yes)\b/.test(normalized),
  );
  const hasNo = normalizedValues.some(
    ({ normalized }) =>
      normalized.includes("no quiero") ||
      normalized.includes("ninguna de estas opciones") ||
      normalized === "ninguna" ||
      normalized.includes("ninguna opcion") ||
      normalized.includes("no por ahora") ||
      /\b(no|nop|nope)\b/.test(normalized),
  );

  if (hasYes && !hasNo) return "yes";
  if (hasNo && !hasYes) return "no";
  return null;
};

const findBestSurveySelectedText = (values = []) => {
  const candidates = values
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .filter((entry) => {
      const lower = entry.toLowerCase();
      if (lower.includes("@s.whatsapp.net")) return false;
      if (lower.includes("@g.us")) return false;
      return true;
    });

  const preferred = candidates.find((entry) => {
    const normalized = normalizeSurveyText(entry);
    return (
      normalized.includes("quiero sacar un turno") ||
      normalized.includes("sacar un turno") ||
      normalized.includes("necesito cancelar un turno") ||
      normalized.includes("cancelar un turno") ||
      normalized.includes("quiero cambiar el horario") ||
      normalized.includes("cambiar el horario") ||
      normalized.includes("cambiar un turno") ||
      normalized.includes("no quiero") ||
      normalized.includes("ninguna de estas opciones")
    );
  });

  return preferred || candidates[0] || "";
};

const resolveSurveyOutcome = (normalized) => {
  const raw = normalized?.raw || {};

  const selectedFromPollUpdates = extractSelectedOptionsFromPollUpdates(raw);

  const explicitSelectionValues = SURVEY_SELECTION_PATHS.map((path) =>
    getNestedValue(raw, path),
  )
    .filter(Boolean)
    .flatMap((entry) => collectStringValues(entry, []));

  const selectedCandidates = [
    ...selectedFromPollUpdates,
    ...explicitSelectionValues,
  ];

  const explicitDecision = resolveYesNoFromValues(selectedCandidates);
  if (explicitDecision) {
    return {
      decision: explicitDecision,
      selectedText: findBestSurveySelectedText(selectedCandidates),
    };
  }

  const textRaw = String(normalized?.text || "").trim();
  const textNormalized = normalizeSurveyText(textRaw);
  if (["si", "s", "yes", "dale", "ok"].includes(textNormalized)) {
    return { decision: "yes", selectedText: textRaw };
  }
  if (
    ["no", "nop", "n", "nope", "no quiero", "no por ahora"].includes(
      textNormalized,
    )
  ) {
    return { decision: "no", selectedText: textRaw };
  }

  const hasPollEnvelope =
    Boolean(raw?.pollUpdateMessage) ||
    Boolean(raw?.pollResponseMessage) ||
    Boolean(raw?.message?.pollUpdateMessage) ||
    Boolean(raw?.message?.pollResponseMessage) ||
    Boolean(raw?.data?.pollUpdateMessage) ||
    Boolean(raw?.data?.pollResponseMessage) ||
    POLL_UPDATES_PATHS.some((pollPath) =>
      Array.isArray(getNestedValue(raw, pollPath)),
    );

  if (hasPollEnvelope) {
    return { decision: null, selectedText: "" };
  }

  const hintedSelectionValues = collectStringsFromKeyHints(
    raw,
    /(selected|vote|choice|chosen|answer|option)/i,
    [],
  );
  const hintedDecision = resolveYesNoFromValues(hintedSelectionValues);
  if (hintedDecision) {
    return {
      decision: hintedDecision,
      selectedText: findBestSurveySelectedText(hintedSelectionValues),
    };
  }

  const deepStringValues = collectStringValues(raw, []);
  const deepDecision = resolveYesNoFromValues(deepStringValues);
  if (deepDecision) {
    return {
      decision: deepDecision,
      selectedText: findBestSurveySelectedText(deepStringValues),
    };
  }

  return { decision: null, selectedText: "" };
};

const resolveSurveyActionFromSnapshot = ({
  surveySnapshot,
  text = "",
}) => {
  const normalizedText = normalizeSurveyText(text);
  if (!normalizedText || !Array.isArray(surveySnapshot?.options)) {
    return null;
  }

  return surveySnapshot.options
    .map((option) => ({
      action: option.action,
      label: String(option.label || "").trim(),
      normalizedLabel: normalizeSurveyText(option.label),
    }))
    .filter((option) => option.normalizedLabel)
    .sort(
      (left, right) => right.normalizedLabel.length - left.normalizedLabel.length,
    )
    .find((option) => option.normalizedLabel === normalizedText) || null;
};

const mapSurveySelectionToIntentText = ({
  selectedSurveyAction = "",
  selectedSurveyText,
  extraText = "",
}) => {
  const extra = String(extraText || "").trim();

  if (selectedSurveyAction === "reschedule") {
    return [
      "Quiero cambiar un turno.",
      "Mostrame mis turnos pendientes de este numero para elegir cual cambiar.",
      extra,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  if (selectedSurveyAction === "cancel") {
    return [
      "Quiero cancelar un turno.",
      "Mostrame mis turnos pendientes de este numero para elegir cual cancelar.",
      extra,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  if (selectedSurveyAction === "book") {
    return ["Quiero sacar un turno.", extra].filter(Boolean).join(" ").trim();
  }

  if (selectedSurveyAction === "appointment_info") {
    return [
      "Quiero informacion sobre mis turnos pendientes de este numero.",
      "Mostramelos para revisarlos.",
      extra,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  if (selectedSurveyAction === "none") {
    return "";
  }

  return [selectedSurveyText, extra].filter(Boolean).join(" ").trim();
};

const resolveSurveyDecision = (normalized) => {
  return resolveSurveyOutcome(normalized).decision;
};

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

  logger.info(
    `Lote | from=${maskPhoneForLog(mergedMessage.phoneNumber)} | msgs=${mergedMessage.mergedCount} | "${compactText(mergedMessage.text)}"`,
  );

  appendConversationLog({
    event: "batch_received",
    instanceName,
    phone: mergedMessage.phoneNumber,
    mergedCount: mergedMessage.mergedCount,
    text: String(mergedMessage.text || ""),
  });

  try {
    const aiResponse =
      instanceName === normalizeInstanceName(SUPPORT_INSTANCE_NAME)
        ? await runSupportAssistant({ incomingMessage: mergedMessage })
        : await runWhatsappAssistant({
            instanceName,
            incomingMessage: mergedMessage,
          });

    const aiLogText = aiResponse?.text
      ? String(aiResponse.text).replace(/\r?\n/g, "\\n")
      : "";

    logger.info(
      `IA | from=${maskPhoneForLog(mergedMessage.phoneNumber)} | enabled=${Boolean(aiResponse?.enabled)} | hasText=${Boolean(aiResponse?.text)}${aiResponse?.reason ? ` | reason=${aiResponse.reason}` : ""}${aiLogText ? ` | text="${aiLogText}"` : ""}`,
    );

    if (Array.isArray(aiResponse?.usedTools) && aiResponse.usedTools.length) {
      logger.info(`TOOLS | ${aiResponse.usedTools.join(", ")}`);
    }

    appendConversationLog({
      event: "ai_result",
      instanceName,
      phone: mergedMessage.phoneNumber,
      enabled: Boolean(aiResponse?.enabled),
      hasText: Boolean(aiResponse?.text),
      reason: aiResponse?.reason || null,
      usedTools: Array.isArray(aiResponse?.usedTools)
        ? aiResponse.usedTools
        : [],
      text: aiResponse?.text || "",
    });

    if (aiResponse?.poll?.type === "support_menu") {
      const pollResult = await sendSupportMenuPoll(
        mergedMessage.phoneNumber,
        instanceName,
      );
      logger.info(
        `Encuesta soporte | to=${maskPhoneForLog(mergedMessage.phoneNumber)} | provider=${pollResult?.provider || "unknown"}`,
      );
      appendConversationLog({
        event: "outbound_sent",
        instanceName,
        phone: mergedMessage.phoneNumber,
        text: "[support_menu_poll]",
      });
    } else if (aiResponse?.enabled && aiResponse?.text) {
      await sendTextMessage(
        mergedMessage.phoneNumber,
        aiResponse.text,
        instanceName,
      );
      logger.info(`OUT | to=${maskPhoneForLog(mergedMessage.phoneNumber)}`);
      appendConversationLog({
        event: "outbound_sent",
        instanceName,
        phone: mergedMessage.phoneNumber,
        text: aiResponse.text,
      });
    } else {
      logger.info(`OUT | reason=${aiResponse?.reason || "n/a"}`);
      appendConversationLog({
        event: "outbound_skipped",
        instanceName,
        phone: mergedMessage.phoneNumber,
        reason: aiResponse?.reason || "sin razon",
      });
    }

    const createdAppointment =
      instanceName !== normalizeInstanceName(SUPPORT_INSTANCE_NAME) &&
      Array.isArray(aiResponse?.usedTools) &&
      aiResponse.usedTools.includes("create_appointment") &&
      mergedMessage.phoneNumber;

    if (createdAppointment) {
      const gateKey = getConversationGateKey({
        instanceName,
        phoneNumber: mergedMessage.phoneNumber,
      });
      // Mute corto (10 min) para que el intercambio de despedida ocurra en silencio.
      // Cuando el mute expire, el siguiente mensaje del usuario dispara la encuesta.
      const POST_APPOINTMENT_GRACE_MS = 10 * 60 * 1000;
      whatsappConversationGate.set(gateKey, {
        status: "muted",
        muteUntil: Date.now() + POST_APPOINTMENT_GRACE_MS,
        updatedAt: Date.now(),
        reason: "post_appointment_grace",
        transitionToNeedsSurveyAfterMute: true,
      });
      logger.info(
        `Flujo post-turno | from=${maskPhoneForLog(mergedMessage.phoneNumber)} | grace=10min → needs_survey`,
      );
    }
  } catch (error) {
    logger.error({ err: error }, `Error ejecutando asistente IA: ${error.message}`);
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

const handleOwnerConfirmationCommand = async (
  instanceName,
  ownerPhone,
  turnoId,
  companyId = null,
) => {
  try {
    const ownerInstanceName = normalizeInstanceName(instanceName);
    const companyInstanceName = companyId
      ? buildInstanceName({ companyId })
      : ownerInstanceName;

    const [empresaRows] = companyId
      ? await pool.execute(
          `SELECT id_empresa, nombre_comercial
           FROM EMPRESA
           WHERE id_empresa = ?
           LIMIT 1`,
          [companyId],
        )
      : await pool.execute(
          `SELECT e.id_empresa, e.nombre_comercial 
           FROM EMPRESA e
           JOIN CONFIG_WHATSAPP cw ON cw.id_empresa = e.id_empresa
           WHERE cw.instance_name = ?
           LIMIT 1`,
          [ownerInstanceName],
        );

    if (!empresaRows.length) return;
    const company = empresaRows[0];

    // Obtenemos el turno
    const [turnoRows] = await pool.execute(
      `SELECT t.id_turno, t.estado, t.fecha_hora, 
              c.whatsapp_id, c.nombre_wa, 
              s.nombre AS servicio_nombre
       FROM TURNO t
       JOIN CLIENTE c ON c.id_cliente = t.id_cliente
       JOIN SERVICIO s ON s.id_servicio = t.id_servicio
       WHERE t.id_turno = ? AND c.id_empresa = ?
       LIMIT 1`,
      [turnoId, company.id_empresa],
    );

    if (!turnoRows.length) {
      await sendTextMessage(
        ownerPhone,
        `No se encontró el turno #${turnoId} para tu empresa.`,
        ownerInstanceName,
      );
      return;
    }

    const turno = turnoRows[0];
    if (turno.estado === "confirmado") {
      await sendTextMessage(
        ownerPhone,
        `El turno #${turnoId} ya se encontraba confirmado.`,
        ownerInstanceName,
      );
      return;
    }

    if (
      turno.estado !== "pendiente_confirmacion" &&
      turno.estado !== "pendiente"
    ) {
      await sendTextMessage(
        ownerPhone,
        `No se puede confirmar el turno #${turnoId} porque su estado actual es '${turno.estado}'.`,
        ownerInstanceName,
      );
      return;
    }

    // Actualizamos estado
    await pool.execute("UPDATE TURNO SET estado = ? WHERE id_turno = ?", [
      "confirmado",
      turnoId,
    ]);

    // Notificamos al dueño
    await sendTextMessage(
      ownerPhone,
      `Turno #${turnoId} confirmado exitosamente. Se notificará al cliente.`,
      ownerInstanceName,
    );

    // Notificamos al cliente
    if (turno.whatsapp_id) {
      const fechaOptions = { weekday: "long", day: "numeric", month: "long", timeZone: "America/Argentina/Buenos_Aires" };
      const fechaStr = new Date(turno.fecha_hora).toLocaleDateString(
        "es-AR",
        fechaOptions,
      );
      const horaStr = new Date(turno.fecha_hora).toLocaleTimeString("es-AR", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Argentina/Buenos_Aires",
      });
      const clientMessage = `Hola ${turno.nombre_wa || ""}! 👋\n\nTe confirmamos que tu turno para *${turno.servicio_nombre}* el día *${fechaStr}* a las *${horaStr}* ha sido confirmado por ${company.nombre_comercial}.\n\n¡Te esperamos!`;

      await sendTextMessageWithFallback({
        phoneNumber: turno.whatsapp_id,
        referencePhone: company.whatsapp_number || ownerPhone,
        text: clientMessage,
        instanceName: companyInstanceName,
      });
    }
  } catch (error) {
    console.error("Error confirmando turno por WA:", error.message);
  }
};

// â”€â”€â”€ Process incoming messages (AI pipeline) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ─── Direct appointment info message (bypasses LLM) ──────────────────────────
const sendAppointmentInfoMessage = async ({ instanceName, phoneNumber }) => {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const number = String(phoneNumber).replace(/[^\d]/g, '');

  try {
    // Get upcoming appointments for this phone number from this company instance
    const [rows] = await pool.execute(
      `SELECT
          t.id_turno,
          t.fecha_hora,
          t.estado,
          c.nombre_wa,
          s.nombre AS servicio_nombre,
          e.nombre_comercial,
          e.direccion
       FROM TURNO t
       JOIN CLIENTE c ON c.id_cliente = t.id_cliente
       JOIN SERVICIO s ON s.id_servicio = t.id_servicio
       JOIN EMPRESA e ON e.id_empresa = c.id_empresa
       JOIN CONFIG_WHATSAPP cw ON cw.id_empresa = e.id_empresa
       WHERE cw.instance_name = ?
         AND (c.whatsapp_id = ? OR c.whatsapp_id = ?)
         AND t.estado IN ('pendiente', 'pendiente_confirmacion', 'confirmado')
         AND t.fecha_hora >= UTC_TIMESTAMP()
       ORDER BY t.fecha_hora ASC
       LIMIT 5`,
      [normalizedInstanceName, number, `549${number}`.slice(-11)],
    );

    if (!rows.length) {
      await sendTextMessage(
        number,
        '¡Hola! 👋 No encontré turnos próximos agendados para tu número. Si querés sacar uno, ¡con gusto te ayudo!',
        normalizedInstanceName,
      );
      return true;
    }

    const clientName = rows[0].nombre_wa || '';
    const address = rows[0].direccion || '';
    const companyName = rows[0].nombre_comercial || '';

    const greeting = clientName
      ? `¡Hola, *${clientName}*! 👋`
      : '¡Hola! 👋';

    const turnosText = rows
      .map((row) => {
        const appointmentDate =
          row.fecha_hora instanceof Date
            ? new Date(row.fecha_hora.getTime())
            : parseSqlDateTimeAsUtc(row.fecha_hora);
        const fecha = appointmentDate.toLocaleDateString('es-AR', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          timeZone: 'America/Argentina/Buenos_Aires',
        });
        const hora = appointmentDate.toLocaleTimeString('es-AR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'America/Argentina/Buenos_Aires',
        });
        const estadoEmoji =
          row.estado === 'confirmado'
            ? '✅'
            : row.estado === 'pendiente_confirmacion'
            ? '⏳'
            : '📅';
        return `${estadoEmoji} *${row.servicio_nombre}* — ${fecha} a las ${hora}`;
      })
      .join('\n');

    const lines = [
      greeting,
      '',
      `Estos son tus turnos próximos en *${companyName}*:`,
      '',
      turnosText,
    ];

    if (address) {
      lines.push('');
      lines.push(`📍 *Dirección:* ${address}`);
    }

    lines.push('');
    lines.push('¡Te esperamos! 😊');

    await sendTextMessage(number, lines.join('\n'), normalizedInstanceName);
    logger.info(
      `Info turnos enviada directamente | to=${maskPhoneForLog(number)} | count=${rows.length}`,
    );
    return true;
  } catch (error) {
    console.error('❌ Error enviando info de turnos:', error.message);
    return false;
  }
};

const processIncomingMessage = async ({ instanceName, webhookData }) => {
  const messages = extractIncomingMessages(webhookData);
  const ignoredPhones = await getIgnoredPhonesForInstance(instanceName);

  if (!messages.length) {
    logger.debug(
      `Webhook sin mensajes | inst=${instanceName} | event=${webhookData?.event || webhookData?.type || "unknown"}`,
    );
    return;
  }

  // Umbral máximo de antigüedad: 5 minutos
  const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;
  const nowMs = Date.now();

  // ── Fase 1: normalizar y filtrar por antigüedad ────────────────────────────
  const freshMessages = [];
  for (const message of messages) {
    const normalized = normalizeIncomingMessage(
      instanceName,
      message,
      webhookData,
    );
    const msgTimestampMs =
      Number(normalized.timestamp) > 1e10
        ? Number(normalized.timestamp) // ya en ms
        : Number(normalized.timestamp) * 1000; // viene en segundos (formato WA)
    if (nowMs - msgTimestampMs > MAX_MESSAGE_AGE_MS) {
      verboseLog(
        `Ignorado: mensaje viejo (${Math.round((nowMs - msgTimestampMs) / 1000)}s) | from=${maskPhoneForLog(normalized.phoneNumber)}`,
      );
      continue;
    }
    storeRecentMessage(instanceName, normalized);
    freshMessages.push(normalized);
  }

  if (!freshMessages.length) return;

  // ── Fase 2: agrupar mensajes entrantes del mismo número en un solo mensaje ─
  // Esto evita que una ráfaga de mensajes (ej.: reconexión del backend) genere
  // múltiples llamadas al gate y a la LLM. Los mensajes fromMe/grupo se dejan
  // pasar individualmente para que el mute del operador siga funcionando.
  const nonInboundMessages = freshMessages.filter(
    (m) => m.isGroup || m.fromMe || !m.phoneNumber,
  );
  const inboundByPhone = new Map();
  for (const normalized of freshMessages.filter(
    (m) => !m.isGroup && !m.fromMe && m.phoneNumber,
  )) {
    const bucket = inboundByPhone.get(normalized.phoneNumber) || [];
    bucket.push(normalized);
    inboundByPhone.set(normalized.phoneNumber, bucket);
  }

  const mergedInbound = [];
  for (const [phone, bucket] of inboundByPhone.entries()) {
    if (bucket.length === 1) {
      mergedInbound.push(bucket[0]);
    } else {
      const merged = mergeBufferedIncomingMessages(bucket);
      if (merged) {
        logger.info(
          `Ráfaga agrupada | from=${maskPhoneForLog(phone)} | count=${bucket.length} | "${compactText(merged.text)}"`,
        );
        mergedInbound.push(merged);
      }
    }
  }

  // fromMe/group primero para que los mutes queden establecidos antes de
  // procesar los mensajes entrantes del mismo payload.
  const processedMessages = [...nonInboundMessages, ...mergedInbound];

  for (const normalized of processedMessages) {
    logger.info(
      `IN | from=${maskPhoneForLog(normalized.phoneNumber)} | type=${normalized.rawType || normalized.messageType} | "${compactText(normalized.text)}"`,
    );

    appendConversationLog({
      event: "incoming",
      instanceName,
      phone: normalized.phoneNumber,
      pushName: normalized.pushName,
      text: String(normalized.text || ""),
      fromMe: normalized.fromMe,
      isGroup: normalized.isGroup,
      messageType: normalized.rawType || normalized.messageType,
    });

    // ── Intercept appointment confirmation polls on support instance ────
    if (!normalized.fromMe && !normalized.isGroup) {
      const handled = await handleAppointmentPollConfirmation(
        instanceName,
        normalized,
      );
      if (handled) {
        logger.info(
          `Poll confirmación procesada | from=${maskPhoneForLog(normalized.phoneNumber)}`,
        );
        continue;
      }
    }

    // Skip groups, self-messages, or messages without phone
    if (normalized.isGroup) {
      verboseLog("⏭️ Ignorado: grupo");
      continue;
    }
    if (normalized.fromMe) {
      if (
        isWebhookFromKnownBotOutbound({
          instanceName,
          phoneNumber: normalized.phoneNumber,
          text: normalized.text,
          messageId: normalized.messageId,
        })
      ) {
        logger.debug(
          `Ignorado bot-outbound | from=${maskPhoneForLog(normalized.phoneNumber)}`,
        );
        continue;
      }

      if (normalized.phoneNumber) {
        const gateKey = getConversationGateKey({
          instanceName,
          phoneNumber: normalized.phoneNumber,
        });
        const muteUntil = Date.now() + WHATSAPP_NO_REPLY_MUTE_MS;
        whatsappConversationGate.set(gateKey, {
          status: "muted",
          muteUntil,
          updatedAt: Date.now(),
          reason: "manual_operator_message",
        });

        const batchKey = getIncomingMessageBatchKey({
          instanceName,
          phoneNumber: normalized.phoneNumber,
        });
        const pendingBatch = pendingIncomingMessageBatches.get(batchKey);
        if (pendingBatch?.timer) {
          clearTimeout(pendingBatch.timer);
        }
        pendingIncomingMessageBatches.delete(batchKey);

        logger.info(
          `Muted manual | from=${maskPhoneForLog(normalized.phoneNumber)} | until=${new Date(muteUntil).toISOString()}`,
        );
      }
      continue;
    }
    if (!normalized.phoneNumber) {
      verboseLog("⏭️ Ignorado: sin teléfono");
      continue;
    }

    if (
      normalizeInstanceName(instanceName) !==
        normalizeInstanceName(SUPPORT_INSTANCE_NAME) &&
      getConfiguredSupportPhones().has(
        normalizeWhatsappPhone(normalized.phoneNumber),
      )
    ) {
      verboseLog(
        `Ignorado soporte -> empresa | from=${maskPhoneForLog(normalized.phoneNumber)}`,
      );
      continue;
    }

    if (ignoredPhones.has(normalized.phoneNumber)) {
      verboseLog(
        `Ignorado blacklist | from=${maskPhoneForLog(normalized.phoneNumber)}`,
      );
      continue;
    }
    if (
      await shouldIgnoreInternalPlatformPhone({
        instanceName,
        phoneNumber: normalized.phoneNumber,
      })
    ) {
      const text = String(normalized.text || "").trim();
      const match = text.match(/^confirmar(?:\s+turno)?\s+#?(\d+)$/i);

      if (match) {
        const turnoId = parseInt(match[1], 10);
        verboseLog(
          `Comando de confirmación WA | owner=${normalized.phoneNumber} | turno=${turnoId}`,
        );
        await handleOwnerConfirmationCommand(
          instanceName,
          normalized.phoneNumber,
          turnoId,
        );
        continue;
      }

      verboseLog(
        `Ignorado interno | from=${maskPhoneForLog(normalized.phoneNumber)}`,
      );
      continue;
    }

    // Check connection state
    const connectionState = await getSafeConnectionState(instanceName);
    const staticStatus =
      connectionState?.instance?.state || connectionState?.state || "unknown";
    if (staticStatus !== "open") {
      verboseLog(`⏭️ Instancia no abierta | state=${staticStatus}`);
      continue;
    }

    const isSupportInstance =
      normalizeInstanceName(instanceName) ===
      normalizeInstanceName(SUPPORT_INSTANCE_NAME);

    if (isSupportInstance) {
      if (normalized.isAudio) {
        verboseLog("🎙️ Procesando audio...");
        const transcript = await processAudioMessage(
          instanceName,
          normalized.messageId,
        );
        normalized.text = transcript;
      }

      const isPollPayload = /poll/i.test(
        String(normalized.rawType || normalized.messageType || ""),
      );
      if (!hasProcessableText(normalized.text) && isPollPayload) {
        const collectValuesByKeyRegex = (obj, keyRegex, bucket = []) => {
          if (!obj || typeof obj !== "object") return bucket;
          for (const [key, value] of Object.entries(obj)) {
            if (keyRegex.test(key)) {
              bucket.push(value);
            }
            if (Array.isArray(value)) {
              value.forEach((entry) =>
                collectValuesByKeyRegex(entry, keyRegex, bucket),
              );
            } else if (value && typeof value === "object") {
              collectValuesByKeyRegex(value, keyRegex, bucket);
            }
          }
          return bucket;
        };
        const flattenedSelectionValues = collectValuesByKeyRegex(
          normalized.raw || {},
          /(selectedOptions?|selectedOptionName|optionName|option|vote)/i,
          [],
        )
          .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
          .filter((entry) => entry !== undefined && entry !== null);
        logger.debug(`Support poll raw | from=${normalized.phoneNumber} | type=${normalized.rawType || normalized.messageType} | selected=${flattenedSelectionValues.filter(v => typeof v === 'string').join(', ') || 'none'}`);
        normalized.text = "poll_update";
      }

      if (!hasProcessableText(normalized.text)) {
        verboseLog(
          `Sin contenido procesable | from=${maskPhoneForLog(normalized.phoneNumber)} | type=${normalized.rawType || normalized.messageType}`,
        );
        continue;
      }

      enqueueIncomingMessageForAssistant({ instanceName, normalized });
      continue;
    }

    const gateKey = getConversationGateKey({
      instanceName,
      phoneNumber: normalized.phoneNumber,
    });
    const gateState = whatsappConversationGate.get(gateKey);
    const now = Date.now();
    let activeGateState = gateState;

    if (
      activeGateState?.status === "muted" &&
      activeGateState?.muteUntil <= now
    ) {
      if (activeGateState?.transitionToNeedsSurveyAfterMute) {
        whatsappConversationGate.set(gateKey, {
          status: "needs_survey",
          updatedAt: now,
        });
        activeGateState = whatsappConversationGate.get(gateKey);
      } else {
        whatsappConversationGate.delete(gateKey);
        activeGateState = null;
      }
    }

    if (
      activeGateState?.status === "pending" &&
      now - Number(activeGateState.askedAt || 0) >
        WHATSAPP_PENDING_SURVEY_TTL_MS
    ) {
      whatsappConversationGate.delete(gateKey);
      activeGateState = null;
    }

    if (
      activeGateState?.status === "opted-in" &&
      now - Number(activeGateState.updatedAt || 0) > WHATSAPP_OPTED_IN_TTL_MS
    ) {
      whatsappConversationGate.delete(gateKey);
      activeGateState = null;
    }

    if (
      activeGateState &&
      activeGateState?.status !== "muted" &&
      activeGateState?.status !== "pending" &&
      now - Number(activeGateState.updatedAt || 0) >
        WHATSAPP_FLOW_INACTIVITY_TTL_MS
    ) {
      whatsappConversationGate.delete(gateKey);
      activeGateState = null;
      logger.info(
        `Flujo reiniciado por inactividad | from=${maskPhoneForLog(normalized.phoneNumber)}`,
      );
    }

    if (activeGateState?.status === "needs_survey") {
      // Reservar el gate de forma síncrona ANTES del await para evitar
      // que webhooks concurrentes del mismo usuario envíen múltiples polls.
      whatsappConversationGate.set(gateKey, {
        status: "pending",
        askedAt: now,
        updatedAt: now,
      });
      try {
        const pollResult = await sendPollMessage(
          normalized.phoneNumber,
          instanceName,
        );
        whatsappConversationGate.set(gateKey, {
          status: "pending",
          askedAt: now,
          updatedAt: now,
          surveySnapshot: pollResult?.surveySnapshot || null,
          selectedSurveyAction: "",
          selectedSurveyText: "",
          preconfirmedYesAt: null,
        });
        logger.info(
          `Encuesta | to=${maskPhoneForLog(normalized.phoneNumber)} | provider=${pollResult?.provider || "unknown"}`,
        );
      } catch (error) {
        console.error(
          "❌ No se pudo enviar encuesta reiniciada:",
          error.message,
        );
        whatsappConversationGate.delete(gateKey);
      }
      continue;
    }

    if (
      activeGateState?.status === "muted" &&
      activeGateState?.muteUntil > now
    ) {
      verboseLog(
        `Mute activo | from=${maskPhoneForLog(normalized.phoneNumber)} | until=${new Date(activeGateState.muteUntil).toISOString()}`,
      );
      continue;
    }

    if (activeGateState?.status === "pending") {
      const isPollPayload = /poll/i.test(
        String(normalized.rawType || normalized.messageType || ""),
      );

      // For company instances (non-support), extract poll selection from pollUpdates.voters
      // just like the support instance does, so the gate can resolve survey outcomes.
      if (isPollPayload && !hasProcessableText(normalized.text)) {
        const selectedFromPollUpdates = extractSelectedOptionsFromPollUpdates(
          normalized.raw || {},
        );
        if (selectedFromPollUpdates.length > 0) {
          normalized.text = selectedFromPollUpdates.join(", ");
          logger.info(
            `Poll empresa | from=${maskPhoneForLog(normalized.phoneNumber)} | selected=${normalized.text}`,
          );
        } else {
          // Poll payload but no resolved selection (e.g. WhatsApp encrypted poll)
          // Log it for debugging but skip — we cannot determine the selection.
          logger.debug(
            `Poll empresa sin selección legible | from=${maskPhoneForLog(normalized.phoneNumber)} | type=${normalized.rawType || normalized.messageType}`,
          );
          continue;
        }
      }

      const surveyOutcome = resolveSurveyOutcome(normalized);
      let decision = surveyOutcome.decision;
      let selectedSurveyText = String(
        surveyOutcome.selectedText || "",
      ).trim();
      const surveySnapshot = activeGateState?.surveySnapshot || null;

      const currentText = hasProcessableText(normalized.text)
        ? String(normalized.text || "").trim()
        : "";
      const bufferedText = String(
        activeGateState?.pendingBufferedText || "",
      ).trim();
      let selectedSurveyOption =
        resolveSurveyActionFromSnapshot({
          surveySnapshot,
          text: selectedSurveyText || currentText,
        });

      // If poll payload matched a snapshot option but decision is still null, resolve it.
      if (!decision && selectedSurveyOption && isPollPayload) {
        decision = selectedSurveyOption.action === "none" ? "no" : "yes";
        logger.info(
        `Poll resuelto por snapshot | from=${maskPhoneForLog(normalized.phoneNumber)} | action=${selectedSurveyOption.action} | label=${selectedSurveyOption.label}`,
      );
      }

      // ── Direct handler: appointment_info bypasses LLM entirely ──────────────
      if (decision === "yes" && selectedSurveyOption?.action === "appointment_info") {
        whatsappConversationGate.set(gateKey, { status: "opted-in", updatedAt: now });
        const infoSent = await sendAppointmentInfoMessage({
          instanceName,
          phoneNumber: normalized.phoneNumber,
        });
        if (infoSent) {
          appendConversationLog({
            event: "outbound_sent",
            instanceName,
            phone: normalized.phoneNumber,
            text: "[appointment_info_direct]",
          });
          continue;
        }
        // If it failed for some reason, fall through to the LLM
      }

      if (!selectedSurveyText && selectedSurveyOption?.label) {
        selectedSurveyText = selectedSurveyOption.label;
      }

      if (
        surveySnapshot?.personalizada === true &&
        !isPollPayload &&
        !activeGateState?.preconfirmedYesAt &&
        !selectedSurveyOption
      ) {
        decision = null;
      }

      // Si el usuario ya había pre-confirmado "sí" con el poll y ahora manda texto
      // con el detalle del turno, tomarlo como confirmación definitiva.
      if (activeGateState?.preconfirmedYesAt && !isPollPayload && currentText) {
        decision = "yes";
        selectedSurveyText =
          activeGateState.selectedSurveyText || selectedSurveyText;
        if (activeGateState.selectedSurveyAction) {
          selectedSurveyOption = {
            action: activeGateState.selectedSurveyAction,
            label: selectedSurveyText,
          };
        }
        normalized.text =
          mapSurveySelectionToIntentText({
            selectedSurveyAction: selectedSurveyOption?.action || "",
            selectedSurveyText,
            extraText: [bufferedText, currentText].filter(Boolean).join(" "),
          }) ||
          `Si ${[bufferedText, currentText].filter(Boolean).join(" ").trim()}`;
      } else if (!decision && selectedSurveyOption) {
        decision = selectedSurveyOption.action === "none" ? "no" : "yes";
      }

      // Mientras se espera respuesta al poll: SIEMPRE bufferizar texto, nunca clasificar.
      // Esto garantiza que mensajes en ráfaga se acumulan y el poll sólo se envía una vez.
      if (!decision && !isPollPayload && !activeGateState?.preconfirmedYesAt) {
        if (currentText) {
          const mergedPendingText = [bufferedText, currentText]
            .filter(Boolean)
            .join(" ")
            .trim();
          whatsappConversationGate.set(gateKey, {
            ...activeGateState,
            status: "pending",
            pendingBufferedText: mergedPendingText,
            updatedAt: now,
          });
          verboseLog(
            `Texto bufferizado (esperando poll) | from=${maskPhoneForLog(normalized.phoneNumber)} | acumulado="${compactText(mergedPendingText)}"`,
          );
        }
        continue;
      }

      if (!decision && isPollPayload) {
        verboseLog(
          `Encuesta sin decision | from=${maskPhoneForLog(normalized.phoneNumber)} | type=${normalized.rawType || normalized.messageType}`,
        );
      }

      if (decision === "yes" && isPollPayload) {
        const combinedWithBuffer = [
          selectedSurveyText,
          bufferedText,
          currentText,
        ]
          .filter(Boolean)
          .join(" ")
          .trim();

        if (combinedWithBuffer) {
          normalized.text =
            mapSurveySelectionToIntentText({
              selectedSurveyAction: selectedSurveyOption?.action || "",
              selectedSurveyText,
              extraText: [bufferedText, currentText].filter(Boolean).join(" "),
            }) || `Si ${combinedWithBuffer}`;
          normalized.rawType = "pollResponseSynthetic";
        } else {
          whatsappConversationGate.set(gateKey, {
            ...activeGateState,
            status: "pending",
            preconfirmedYesAt: now,
            selectedSurveyAction: selectedSurveyOption?.action || "",
            selectedSurveyText,
            updatedAt: now,
          });
          verboseLog(
            `Encuesta=SI sin texto | esperando detalle from=${maskPhoneForLog(normalized.phoneNumber)}`,
          );
          continue;
        }
      }

      if (decision === "no") {
        whatsappConversationGate.set(gateKey, {
          status: "muted",
          muteUntil: now + WHATSAPP_NO_REPLY_MUTE_MS,
          updatedAt: now,
        });
        logger.info(
          `Encuesta=NO | from=${maskPhoneForLog(normalized.phoneNumber)} | muted=12h`,
        );
        continue;
      }

      if (decision === "yes") {
        if (
          !isPollPayload &&
          !activeGateState?.preconfirmedYesAt &&
          currentText &&
          selectedSurveyOption
        ) {
          normalized.text =
            mapSurveySelectionToIntentText({
              selectedSurveyAction: selectedSurveyOption.action,
              selectedSurveyText:
                selectedSurveyText || selectedSurveyOption.label || currentText,
              extraText: bufferedText,
            }) || normalized.text;
          normalized.rawType = "pollResponseSynthetic";
        }

        whatsappConversationGate.set(gateKey, {
          status: "opted-in",
          updatedAt: now,
        });

        if (!hasProcessableText(normalized.text)) {
          normalized.text =
            mapSurveySelectionToIntentText({
              selectedSurveyAction: selectedSurveyOption?.action || "",
              selectedSurveyText,
            }) ||
            selectedSurveyText ||
            "Si";
          normalized.rawType = "pollResponseSynthetic";
        }
      } else {
        verboseLog(
          `Esperando encuesta | from=${maskPhoneForLog(normalized.phoneNumber)} | type=${normalized.rawType || normalized.messageType}`,
        );
        continue;
      }
    }

    if (!activeGateState) {
      // Reservar el gate de forma síncrona ANTES del await para evitar que
      // webhooks concurrentes del mismo usuario (ráfaga de reconexión) vean el
      // gate como null y envíen múltiples polls. El texto del mensaje se
      // bufferiza ahora; los mensajes adicionales del mismo usuario que lleguen
      // mientras se envía el poll los recibirá el bloque "pending" y los sumará.
      const firstBufferedText = hasProcessableText(normalized.text)
        ? String(normalized.text || "").trim()
        : "";
      whatsappConversationGate.set(gateKey, {
        status: "pending",
        askedAt: now,
        updatedAt: now,
        pendingBufferedText: firstBufferedText,
      });
      try {
        const pollResult = await sendPollMessage(
          normalized.phoneNumber,
          instanceName,
        );
        whatsappConversationGate.set(gateKey, {
          status: "pending",
          askedAt: now,
          updatedAt: now,
          pendingBufferedText: firstBufferedText,
          surveySnapshot: pollResult?.surveySnapshot || null,
          selectedSurveyAction: "",
          selectedSurveyText: "",
          preconfirmedYesAt: null,
        });
        logger.info(
          `Encuesta | to=${maskPhoneForLog(normalized.phoneNumber)} | provider=${pollResult?.provider || "unknown"}`,
        );
      } catch (error) {
        console.error("❌ No se pudo enviar encuesta inicial:", error.message);
        whatsappConversationGate.delete(gateKey);
      }
      continue;
    }

    // Audio Transcription logic
    if (normalized.isAudio) {
      verboseLog("🎙️ Procesando audio...");
      const transcript = await processAudioMessage(
        instanceName,
        normalized.messageId,
      );
      normalized.text = transcript;
    }

    if (!hasProcessableText(normalized.text)) {
      verboseLog(
        `Sin contenido procesable | from=${maskPhoneForLog(normalized.phoneNumber)} | type=${normalized.rawType || normalized.messageType}`,
      );
      continue;
    }

    if (activeGateState?.status === "opted-in") {
      whatsappConversationGate.set(gateKey, {
        ...activeGateState,
        status: "opted-in",
        updatedAt: now,
      });
    }

    // ── Direct handler: appointment_info bypasses LLM ──────────────────────
    if (normalized.rawType === 'pollResponseSynthetic' &&
        normalized._pollAction === 'appointment_info') {
      await sendAppointmentInfoMessage({
        instanceName,
        phoneNumber: normalized.phoneNumber,
      });
      appendConversationLog({
        event: 'outbound_sent',
        instanceName,
        phone: normalized.phoneNumber,
        text: '[appointment_info_direct]',
      });
      continue;
    }

    enqueueIncomingMessageForAssistant({ instanceName, normalized });
  }
};

module.exports = {
  buildInitialSurveyFallbackText,
  buildInitialSurveyPollPayloadCandidates,
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
  resolveSurveyDecision,
  resolveSurveyActionFromSnapshot,
  sendAppointmentConfirmationPoll,
  sendPollMessage,
  sendTextMessage,
  sendTextMessageWithFallback,
  storeLatestQr,
};
