const {
  AIMessage,
  HumanMessage,
  SystemMessage,
  isAIMessage,
} = require("@langchain/core/messages");
const { tool } = require("@langchain/core/tools");
const {
  StateGraph,
  MessagesAnnotation,
  END,
  START,
} = require("@langchain/langgraph");
const { ToolNode, toolsCondition } = require("@langchain/langgraph/prebuilt");
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { z } = require("zod");

const {
  cancelAppointmentFromAssistant,
  cancelAppointmentByCompanyFromAssistant,
  createAppointmentFromAssistant,
  getCompanyContextByCompanyId,
  getCompanyContextByInstanceName,
  listAvailableSlots,
  listAppointmentsByDay,
} = require("./companyContextService");
const { authenticateCompanyUser } = require("../authCompany.service");
const {
  getSupportSessionDb,
  setSupportSessionDb,
} = require("../supportAuthSession.service");
const {
  buildAssistantPrompt,
  DEFAULT_WELCOME_MESSAGE,
} = require("./assistantPrompt");
const {
  formatNaturalDate,
  summarizeAvailableSlotsForAssistant,
} = require("./slotPresentation");

const AI_ENABLED = (process.env.WHATSAPP_AI_ENABLED || "true") === "true";
const GOOGLE_API_KEY = String(process.env.GOOGLE_API_KEY || "").trim();
const GEMINI_MODEL = String(
  process.env.GEMINI_MODEL || "gemini-3-flash-preview",
).trim();
const GEMINI_MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 2);
const GEMINI_HIGH_DEMAND_RETRY_DELAY_MS = Number(
  process.env.GEMINI_HIGH_DEMAND_RETRY_DELAY_MS || 10_000,
);
const GEMINI_HIGH_DEMAND_MAX_RETRIES = Number(
  process.env.GEMINI_HIGH_DEMAND_MAX_RETRIES || 4,
);
const GEMINI_PROVIDER_CONFIG = {
  name: "google-genai",
  label: `google-${GEMINI_MODEL}`,
  model: GEMINI_MODEL,
  apiKey: GOOGLE_API_KEY,
};
const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE || 0);
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 1200);
const conversationMemory = new Map();
const MAX_CONVERSATION_MESSAGES = 24;
const whatsappSessionState = new Map();
const WHATSAPP_CHAT_CONTEXT_TTL_MS =
  Number(
    process.env.WHATSAPP_CHAT_CONTEXT_TTL_MINUTES ||
      process.env.WHATSAPP_SESSION_TTL_MINUTES ||
      30,
  ) *
  60 *
  1000;
const SUPPORT_INSTANCE_NAME = String(
  process.env.SUPPORT_WHATSAPP_INSTANCE || "citax-support-whatsapp",
)
  .trim()
  .toLowerCase();
const SUPPORT_SESSION_TTL_MS =
  Number(process.env.SUPPORT_SESSION_TTL_HOURS || 24) * 60 * 60 * 1000;
const supportLoginSessions = new Map();
const supportLastCancelledByOperator = new Map();
const SUPPORT_NOTIFY_PHONE = String(
  process.env.SUPPORT_NOTIFY_PHONE || process.env.MATI_WHATSAPP_NUMBER || "",
).replace(/[^\d]/g, "");
const SUPPORT_NOTIFY_LABEL = String(
  process.env.SUPPORT_NOTIFY_LABEL || "el contacto responsable",
).trim();
const EVOLUTION_API_URL =
  process.env.EVOLUTION_API_URL || "http://localhost:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";
const LAST_CANCELLED_TTL_MS = 2 * 60 * 60 * 1000;

const getConversationKey = ({ instanceName, customerPhone }) =>
  `${instanceName}:${customerPhone}`;

const getWhatsappSessionState = ({ instanceName, customerPhone }) => {
  const key = getConversationKey({ instanceName, customerPhone });
  const current = whatsappSessionState.get(key);

  if (!current) {
    return null;
  }

  if (Date.now() > current.expiresAt) {
    whatsappSessionState.delete(key);
    return null;
  }

  return current;
};

const setWhatsappSessionState = ({
  instanceName,
  customerPhone,
  lastAssistantReply = "",
}) => {
  const key = getConversationKey({ instanceName, customerPhone });
  const payload = {
    lastAssistantReply: String(lastAssistantReply || "").trim(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + WHATSAPP_CHAT_CONTEXT_TTL_MS,
  };

  whatsappSessionState.set(key, payload);
  return payload;
};

const clearWhatsappSessionState = ({ instanceName, customerPhone }) => {
  whatsappSessionState.delete(getConversationKey({ instanceName, customerPhone }));
};

const getActiveWhatsappHistory = ({ instanceName, customerPhone }) => {
  const sessionState = getWhatsappSessionState({ instanceName, customerPhone });
  if (!sessionState) {
    clearConversationHistory({ instanceName, customerPhone });
    return {
      sessionState: {
        lastAssistantReply: "",
      },
      history: [],
    };
  }

  return {
    sessionState,
    history: getConversationHistory({ instanceName, customerPhone }),
  };
};

const getConversationHistory = ({ instanceName, customerPhone }) => {
  return (
    conversationMemory.get(
      getConversationKey({ instanceName, customerPhone }),
    ) || []
  );
};

const setConversationHistory = ({ instanceName, customerPhone, messages }) => {
  const filtered = messages
    .filter((m) => m._getType?.() !== "system")
    .slice(-MAX_CONVERSATION_MESSAGES);
  conversationMemory.set(
    getConversationKey({ instanceName, customerPhone }),
    filtered,
  );
};

const clearConversationHistory = ({ instanceName, customerPhone }) => {
  conversationMemory.delete(
    getConversationKey({ instanceName, customerPhone }),
  );
};

const getGeminiConfig = () => ({
  ...GEMINI_PROVIDER_CONFIG,
});

const isAssistantConfigured = () =>
  AI_ENABLED && Boolean(getGeminiConfig().apiKey);

const buildRealtimeTemporalContext = (
  timezone = "America/Argentina/Buenos_Aires",
) => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const isoUtc = now.toISOString();
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const localTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  const localDayName = new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    weekday: "long",
  }).format(now).toLowerCase();
  const localDateLong = new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now).toLowerCase();
  const tomorrowDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(tomorrow);
  const tomorrowDateLong = new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(tomorrow).toLowerCase();
  const yesterdayDateLong = new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(yesterday).toLowerCase();

  return {
    isoUtc,
    localDate,
    localTime,
    localDayName,
    localDateLong,
    timezone,
    tomorrowDate,
    tomorrowDateLong,
    yesterdayDateLong,
  };
};

const buildTemporalReferenceText = (realtimeContext) => {
  return `Referencia temporal obligatoria:
- Ahora exacto: ${realtimeContext.localDate} ${realtimeContext.localTime} (${realtimeContext.timezone})
- Hoy exacto: ${realtimeContext.localDateLong}
- MaÃ±ana exacto: ${realtimeContext.tomorrowDateLong}
- Ayer exacto: ${realtimeContext.yesterdayDateLong}
Usa esta referencia como fuente de verdad para interpretar "hoy", "maÃ±ana" y fechas relativas.
Nunca arrastres dÃ­a, fecha u hora desde mensajes anteriores del chat.`;
};

const getSupportSession = async (customerPhone) => {
  const key = String(customerPhone || "").trim();
  if (!key) return null;
  const current = supportLoginSessions.get(key);
  if (current && Date.now() <= current.expiresAt) {
    return current;
  }
  if (current && Date.now() > current.expiresAt) {
    supportLoginSessions.delete(key);
  }
  const dbSession = await getSupportSessionDb(key);
  if (!dbSession) return null;
  const merged = {
    companyId: dbSession.companyId,
    companyName: dbSession.companyName,
    userEmail: dbSession.userEmail,
    createdAt: Date.now(),
    expiresAt: dbSession.expiresAt,
  };
  supportLoginSessions.set(key, merged);
  return merged;
};

const setSupportSession = async ({
  customerPhone,
  companyId,
  companyName,
  userEmail,
}) => {
  const key = String(customerPhone || "").trim();
  if (!key) return;
  const payload = {
    companyId,
    companyName,
    userEmail,
    createdAt: Date.now(),
    expiresAt: Date.now() + SUPPORT_SESSION_TTL_MS,
  };
  supportLoginSessions.set(key, payload);
  await setSupportSessionDb({
    phone: key,
    companyId,
    companyName,
    userEmail,
  });
};

const setLastCancelledContext = ({ operatorPhone, payload }) => {
  const key = String(operatorPhone || "").trim();
  if (!key || !payload) return;
  supportLastCancelledByOperator.set(key, {
    ...payload,
    expiresAt: Date.now() + LAST_CANCELLED_TTL_MS,
  });
};

const getLastCancelledContext = (operatorPhone) => {
  const key = String(operatorPhone || "").trim();
  if (!key) return null;
  const saved = supportLastCancelledByOperator.get(key);
  if (!saved) return null;
  if (Date.now() > saved.expiresAt) {
    supportLastCancelledByOperator.delete(key);
    return null;
  }
  return saved;
};

const stringifyMessageContent = (content) => {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.text) return String(part.text);
        return "";
      })
      .join("\n")
      .trim();
  }

  if (content == null) {
    return "";
  }

  if (typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }

  return String(content);
};

const safeParseToolArgs = (rawArgs) => {
  if (!rawArgs) return {};
  try {
    return JSON.parse(rawArgs);
  } catch (error) {
    return {
      __raw: rawArgs,
      __parseError: error.message,
    };
  }
};

const INLINE_TOOLCALL_REGEX = /TOOLCALL>\s*([\s\S]*?)\s*<CALL>/gi;

const parseInlineToolCallsFromContent = (content) => {
  const rawContent = String(content || "");
  const toolCalls = [];
  const invalidToolCalls = [];
  let cleanContent = rawContent;
  let sequence = 0;

  cleanContent = cleanContent.replace(INLINE_TOOLCALL_REGEX, (_, payload) => {
    sequence += 1;

    try {
      const parsed = JSON.parse(String(payload || "").trim());
      const calls = Array.isArray(parsed) ? parsed : [parsed];

      for (const call of calls) {
        const name = String(call?.name || "").trim();
        if (!name) {
          invalidToolCalls.push({
            id: `inline_tool_call_${sequence}`,
            args: JSON.stringify(call || {}),
            error: "Tool call inline sin nombre.",
          });
          continue;
        }

        const args =
          typeof call?.arguments === "string"
            ? safeParseToolArgs(call.arguments)
            : call?.arguments && typeof call.arguments === "object"
              ? call.arguments
              : {};

        if (args?.__parseError) {
          invalidToolCalls.push({
            id: `inline_tool_call_${sequence}`,
            name,
            args: call.arguments,
            error: args.__parseError,
          });
          continue;
        }

        toolCalls.push({
          id: `inline_tool_call_${sequence}_${toolCalls.length + 1}`,
          name,
          args,
        });
      }
    } catch (error) {
      invalidToolCalls.push({
        id: `inline_tool_call_${sequence}`,
        args: String(payload || "").trim(),
        error: error.message,
      });
    }

    return "";
  });

  return {
    content: cleanContent.trim(),
    toolCalls,
    invalidToolCalls,
  };
};

const sanitizeAssistantReply = (content) => {
  const raw = String(content || "");
  if (!raw) return "";

  return raw
    .replace(INLINE_TOOLCALL_REGEX, "")
    .replace(/TOOLCALL>\s*/gi, "")
    .replace(/\s*<CALL>/gi, "")
    .trim();
};

const extractAssistantReplyFromMessages = (messages = []) => {
  const lastAI = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => isAIMessage(message) && !message.tool_calls?.length);

  if (!lastAI) {
    return {
      lastAI: null,
      rawReply: "",
      reply: "",
    };
  }

  const rawReply =
    typeof lastAI.content === "string"
      ? lastAI.content.trim()
      : Array.isArray(lastAI.content)
        ? lastAI.content
            .map((part) => (typeof part === "string" ? part : part?.text || ""))
            .join("\n")
            .trim()
        : "";

  return {
    lastAI,
    rawReply,
    reply: sanitizeAssistantReply(rawReply),
  };
};

const normalizeAssistantText = (value) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[!?.,;:()[\]{}"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const renderWelcomeMessageTemplate = ({
  template = "",
  contactName = "",
}) => {
  const rendered = String(template || "")
    .trim()
    .replace(/\{nombre_cliente\}/gi, String(contactName || "").trim())
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,.;:!?-]+\s*/g, "")
    .trim();

  return rendered;
};

const pickConfiguredSaludo = (ownPhrases = {}) => {
  const raw = String(ownPhrases?.saludos || "").trim();
  if (!raw) return "";

  return raw
    .split(/\r?\n|[;|]+/)
    .map((item) => String(item || "").trim())
    .filter(Boolean)[0] || "";
};

const buildFriendlyGreetingPrefix = (companyContext = {}, contactName = "") => {
  const configuredSaludo = renderWelcomeMessageTemplate({
    template: pickConfiguredSaludo(companyContext?.ownPhrases),
    contactName,
  });

  if (configuredSaludo) {
    const normalizedSaludo = normalizeAssistantText(configuredSaludo);
    if (
      normalizedSaludo.startsWith("hola") ||
      normalizedSaludo.startsWith("buen dia") ||
      normalizedSaludo.startsWith("buenas")
    ) {
      return configuredSaludo.replace(/[.!?]+$/g, "").trim();
    }

    return `Hola, ${configuredSaludo.replace(/[.!?]+$/g, "").trim()}`;
  }

  return "Hola";
};

const getConfiguredWelcomeMessage = (
  companyContext = {},
  contactName = "",
) => {
  const configuredMessage = renderWelcomeMessageTemplate({
    template: companyContext?.welcomeMessage,
    contactName,
  });

  if (configuredMessage) {
    return configuredMessage;
  }

  return (
    renderWelcomeMessageTemplate({
      template: DEFAULT_WELCOME_MESSAGE,
      contactName,
    }) || DEFAULT_WELCOME_MESSAGE
  );
};

const LAUGHTER_OPENING_REGEX =
  /^\s*((?:ja){2,}|jaja(?:ja+)?|jeje(?:je+)?|jojo(?:jo+)?|ajaj(?:a+)?)\s*[,;:.!-]*\s*/i;

const sanitizeAssistantOpening = ({
  reply = "",
  incomingText = "",
}) => {
  const originalReply = String(reply || "").trim();
  if (!originalReply) return "";

  const normalizedIncoming = normalizeAssistantText(incomingText);
  const incomingHasLaughter =
    /\b(?:ja){2,}\b/.test(normalizedIncoming) ||
    normalizedIncoming.includes("jaja") ||
    normalizedIncoming.includes("jeje");

  if (incomingHasLaughter) {
    return originalReply;
  }

  const sanitizedReply = originalReply.replace(LAUGHTER_OPENING_REGEX, "").trim();
  return sanitizedReply || originalReply;
};

const ensureFriendlyFirstReply = ({
  reply = "",
  companyContext = {},
  contactName = "",
  shouldPrefixGreeting = false,
}) => {
  const normalizedReply = normalizeAssistantText(reply);
  if (!reply || !shouldPrefixGreeting) {
    return String(reply || "").trim();
  }

  if (
    normalizedReply.startsWith("hola") ||
    normalizedReply.startsWith("buen dia") ||
    normalizedReply.startsWith("buenas")
  ) {
    return String(reply || "").trim();
  }

  const greetingPrefix = buildFriendlyGreetingPrefix(companyContext, contactName);
  if (!greetingPrefix) {
    return String(reply || "").trim();
  }

  return `${greetingPrefix}. ${String(reply || "").trim()}`.trim();
};

const isGreetingOnlyMessage = (value) => {
  const normalized = normalizeAssistantText(value);
  if (!normalized) return false;

  const blockingKeywords = [
    "turno",
    "reserv",
    "sacar",
    "agenda",
    "horario",
    "hora",
    "fecha",
    "manana",
    "hoy",
    "pasado",
    "viernes",
    "lunes",
    "martes",
    "miercoles",
    "jueves",
    "sabado",
    "domingo",
    "cancel",
    "reprogram",
    "cambiar",
    "consulta",
    "pregunta",
    "precio",
    "cuanto",
    "servicio",
    "promo",
    "promocion",
  ];

  if (blockingKeywords.some((keyword) => normalized.includes(keyword))) {
    return false;
  }

  const words = normalized.split(" ").filter(Boolean);
  if (!words.length || words.length > 8) return false;

  const greetingPhrases = [
    "hola",
    "holi",
    "buen dia",
    "buenas",
    "buenas tardes",
    "buenas noches",
    "que onda",
    "como estas",
    "como andas",
    "como va",
    "todo bien",
    "buen dia como va",
  ];

  return greetingPhrases.some((phrase) => normalized.includes(phrase));
};

const shouldUseConfiguredWelcomeReply = ({
  history = [],
  hasPriorReply,
  incomingText = "",
  welcomeMessage = "",
}) => {
  if (!String(welcomeMessage || "").trim()) {
    return false;
  }

  const alreadyStartedConversation =
    typeof hasPriorReply === "boolean" ? hasPriorReply : history.length > 0;

  return !alreadyStartedConversation && isGreetingOnlyMessage(incomingText);
};

const isClosingOnlyMessage = (value) => {
  const normalized = normalizeAssistantText(value);
  if (!normalized) return false;

  const blockingKeywords = [
    "turno",
    "reserv",
    "cancel",
    "reprogram",
    "cambiar",
    "mover",
    "horario",
    "fecha",
    "manana",
    "hoy",
    "pasado",
    "viernes",
    "lunes",
    "martes",
    "miercoles",
    "jueves",
    "sabado",
    "domingo",
    "quiero",
    "necesito",
    "puedo",
    "consulta",
    "pregunta",
  ];

  if (blockingKeywords.some((keyword) => normalized.includes(keyword))) {
    return false;
  }

  const words = normalized.split(" ").filter(Boolean);
  if (!words.length || words.length > 8) return false;

  const closingPhrases = [
    "gracias",
    "muchas gracias",
    "genial",
    "perfecto",
    "perfecta",
    "ok",
    "oka",
    "okey",
    "oki",
    "dale",
    "joya",
    "buenisimo",
    "buenisima",
    "hola",
    "holi",
    "buen dia",
    "buenas",
    "saludos",
    "saludo",
    "listo",
    "lista",
    "barbaro",
    "barbara",
    "excelente",
    "nos vemos",
    "chau",
    "hasta luego",
    "hasta manana",
    "abrazo",
  ];

  return closingPhrases.some((phrase) => normalized.includes(phrase));
};

const looksLikeAppointmentConfirmation = (value) => {
  const normalized = normalizeAssistantText(value);
  if (!normalized) return false;

  const confirmationPhrases = [
    "turno confirmado",
    "turno reservado",
    "te reserve el turno",
    "te reservamos el turno",
    "quedo confirmado",
    "quedo reservado",
    "reserva confirmada",
    "listo te reserve",
    "listo te agende",
    "agende el turno",
    "reserve el turno",
  ];

  return confirmationPhrases.some((phrase) => normalized.includes(phrase));
};

const APPOINTMENT_CONFIRMATION_CLOSING =
  "Cualquier consulta, no dudes en llamarme";
const NON_REPLY_MARKERS = new Set(["no response", "sin respuesta", "no_reply"]);

const ensureAppointmentConfirmationClosing = (value) => {
  const reply = String(value || "").trim();
  if (!reply || !looksLikeAppointmentConfirmation(reply)) {
    return reply;
  }

  const normalizedReply = normalizeAssistantText(reply);
  const normalizedClosing = normalizeAssistantText(
    APPOINTMENT_CONFIRMATION_CLOSING,
  );
  if (normalizedReply.includes(normalizedClosing)) {
    return reply;
  }

  const separator = /[.!?]$/.test(reply) ? " " : ". ";
  return `${reply}${separator}${APPOINTMENT_CONFIRMATION_CLOSING}`;
};

const sanitizeNonReplyOutput = (value) => {
  const reply = String(value || "").trim();
  if (!reply) return "";

  return NON_REPLY_MARKERS.has(normalizeAssistantText(reply)) ? "" : reply;
};

const FINAL_REPLY_RECOVERY_PROMPT =
  "Con toda la informacion y resultados de herramientas anteriores, responde ahora al cliente con un mensaje final breve en español rioplatense. No llames herramientas, no expliques pasos internos y no dejes la respuesta vacia.";

const shouldSilenceClosingReply = ({
  history = [],
  lastAssistantReply = "",
  incomingText = "",
}) => {
  if (!isClosingOnlyMessage(incomingText)) {
    return false;
  }

  const reply =
    String(lastAssistantReply || "").trim() ||
    extractAssistantReplyFromMessages(history).reply;
  return looksLikeAppointmentConfirmation(reply);
};

const isAvailabilityLookupIntent = (value) => {
  const normalized = normalizeAssistantText(value);
  if (!normalized) return false;

  const directKeywords = [
    "turno",
    "turnos",
    "horario",
    "horarios",
    "disponibilidad",
    "disponible",
    "agenda",
    "reserv",
    "sacar",
  ];

  if (directKeywords.some((keyword) => normalized.includes(keyword))) {
    return true;
  }

  return (
    normalized.includes("tenes para") ||
    normalized.includes("tienes para") ||
    normalized.includes("hay lugar") ||
    normalized.includes("hay algun") ||
    normalized.includes("que tenes para") ||
    normalized.includes("que me ofreces para")
  );
};

const createGeminiModel = () => {
  const config = getGeminiConfig();
  const modelOptions = {
    apiKey: config.apiKey,
    model: config.model,
    temperature: LLM_TEMPERATURE,
    maxRetries: GEMINI_MAX_RETRIES,
  };

  if (Number.isFinite(LLM_MAX_TOKENS) && LLM_MAX_TOKENS > 0) {
    modelOptions.maxOutputTokens = LLM_MAX_TOKENS;
  }

  return new ChatGoogleGenerativeAI(modelOptions);
};

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });

const isGeminiHighDemandError = (error) => {
  const status = error?.response?.status || error?.status;
  const message = String(error?.message || "").toLowerCase();

  return (
    status === 503 &&
    (message.includes("currently experiencing high demand") ||
      message.includes("experiencing high demand"))
  );
};

const invokeWithGeminiHighDemandRetry = async (
  operation,
  {
    provider = getGeminiConfig(),
    operationLabel = "invocacion Gemini",
    retryDelayMs = GEMINI_HIGH_DEMAND_RETRY_DELAY_MS,
    maxRetries = GEMINI_HIGH_DEMAND_MAX_RETRIES,
    sleep = wait,
  } = {},
) => {
  let retryCount = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isGeminiHighDemandError(error) || retryCount >= maxRetries) {
        throw error;
      }

      retryCount += 1;
      console.warn(
        `⚠️ Gemini con alta demanda (${provider.label}) durante ${operationLabel}. Reintentando en ${Math.round(
          retryDelayMs / 1000,
        )} segundos (${retryCount}/${maxRetries}).`,
      );
      await sleep(retryDelayMs);
    }
  }
};

const buildFinalReplyRecoveryMessages = (messages = []) => {
  return [
    ...(Array.isArray(messages) ? messages : []),
    new HumanMessage(FINAL_REPLY_RECOVERY_PROMPT),
  ];
};

const synthesizeFinalReplyFromMessages = async ({ messages }) => {
  const recoveryModel = createGeminiModel();
  const recoveryMessages = buildFinalReplyRecoveryMessages(messages);
  const recoveryResponse = await invokeWithGeminiHighDemandRetry(
    () => recoveryModel.invoke(recoveryMessages),
    {
      operationLabel: "la recuperacion de respuesta final",
    },
  );
  const { reply } = extractAssistantReplyFromMessages([recoveryResponse]);
  return sanitizeNonReplyOutput(reply);
};

const resolvePreferredContactName = (rawName) => {
  const first = String(rawName || "")
    .replace(/[^\p{L}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0];
  if (!first) return "";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
};

const createTools = ({ companyContext, customerPhone }) => {
  return [
    tool(
      async () => {
        return JSON.stringify({
          companyName: companyContext.companyName,
          timezone: companyContext.timezone,
          professionals: companyContext.professionals.map((p) => ({
            id: p.id,
            name: p.name,
            services: p.services,
            // Solo proveemos metadata principal.
            // Para conocer la disponibilidad real, Gemini DEBE llamar a find_available_slots.
            requisito:
              "Para saber si este prestador atiende un dÃƒÆ’Ã‚Â­a u horario, DEBES usar obligatoriamente la herramienta find_available_slots. NO asumas ningÃƒÆ’Ã‚Âºn horario comercial.",
          })),
          services: companyContext.services,
        });
      },
      {
        name: "get_company_context",
        description:
          "Devuelve el contexto del negocio: prestadores, servicios y datos.",
        schema: z.object({}),
      },
    ),
    tool(
      async ({ professionalName, serviceId, startDate, endDate, limit }) => {
        const slots = await listAvailableSlots({
          companyId: companyContext.companyId,
          professionalName,
          serviceId: serviceId || null,
          startDate,
          endDate,
          referenceDate: companyContext.currentDate,
          limit: limit || 30,
        });
        const groupedSlots = summarizeAvailableSlotsForAssistant({
          slots,
          referenceDate: companyContext.currentDate,
          timezone: companyContext.timezone,
        });
        return JSON.stringify({
          groupedSlots,
          rules:
            "Usa solamente estos prestadores y estos horarios. Si displayMode es 'range', resumilo como una sola franja continua. Si displayMode es 'multi_range', debes mencionar cada franja por separado y nunca unirlas como si fueran continuas. Si displayMode es 'list', podes enumerar los horarios. Los horarios reservables son SOLO los valores exactos de times: no ofrezcas ni confirmes horas intermedias que no aparezcan ahi. Si un prestador no aparece aca, no lo ofrezcas.",
        });
      },
      {
        name: "find_available_slots",
        description:
          "Busca horarios disponibles para un prestador en un rango de fechas.",
        schema: z.object({
          professionalName: z
            .string()
            .optional()
            .describe("Nombre del prestador."),
          serviceId: z
            .number()
            .optional()
            .describe("ID del servicio para respetar la duracion real."),
          startDate: z
            .string()
            .optional()
            .describe("Fecha desde (YYYY-MM-DD)."),
          endDate: z.string().optional().describe("Fecha hasta (YYYY-MM-DD)."),
          limit: z
            .number()
            .optional()
            .default(30)
            .describe("MÃƒÆ’Ã‚Â¡ximo de resultados (1-40)."),
        }),
      },
    ),
    tool(
      async ({
        clientName,
        clientPhone,
        professionalId,
        serviceId,
        date,
        time,
      }) => {
        const appointment = await createAppointmentFromAssistant({
          companyId: companyContext.companyId,
          professionalId,
          clientName,
          clientPhone: customerPhone,
          serviceId: serviceId || null,
          date,
          time,
          referenceDate: companyContext.currentDate,
        });
        return JSON.stringify({
          appointment: {
            ...appointment,
            humanDate: formatNaturalDate({
              date: appointment.date,
              referenceDate: companyContext.currentDate,
              timezone: companyContext.timezone,
            }),
          },
        });
      },
      {
        name: "create_appointment",
        description:
          "Crea un turno confirmado. Solo usar cuando el cliente ya confirmÃƒÆ’Ã‚Â³.",
        schema: z.object({
          clientName: z
            .string()
            .describe("Nombre del cliente (mÃƒÆ’Ã‚Â­nimo 3 caracteres)."),
          professionalId: z.number().describe("ID del prestador."),
          serviceId: z
            .number()
            .optional()
            .describe(
              "ID del servicio (si se omite se usa el primero disponible).",
            ),
          date: z.string().describe("Fecha del turno (YYYY-MM-DD)."),
          time: z.string().describe("Hora de inicio (HH:mm)."),
        }),
      },
    ),
    tool(
      async ({ date }) => {
        const appointments = await listAppointmentsByDay({
          companyId: companyContext.companyId,
          date,
          referenceDate: companyContext.currentDate,
        });
        return JSON.stringify({ appointments });
      },
      {
        name: "get_appointments_by_day",
        description: "Lista los turnos reservados para un dÃƒÆ’Ã‚Â­a especÃƒÆ’Ã‚Â­fico.",
        schema: z.object({
          date: z
            .string()
            .optional()
            .describe("Fecha a consultar (YYYY-MM-DD)."),
        }),
      },
    ),
    tool(
      async ({ date, time }) => {
        const result = await cancelAppointmentFromAssistant({
          companyId: companyContext.companyId,
          clientPhone: customerPhone,
          date,
          time,
          referenceDate: companyContext.currentDate,
        });

        if (result.status === "multiple_found") {
          return `EncontrÃƒÆ’Ã‚Â© varios turnos. Ãƒâ€šÃ‚Â¿CuÃƒÆ’Ã‚Â¡l querÃƒÆ’Ã‚Â©s cancelar?\n${result.appointments.map((a) => `- ${a.date} a las ${a.time}`).join("\n")}`;
        }
        return `Turno del ${result.date} a las ${result.time} cancelado exitosamente.`;
      },
      {
        name: "cancel_appointment",
        description: "Cancela un turno existente del cliente actual.",
        schema: z.object({
          date: z.string().optional().describe("Fecha del turno (YYYY-MM-DD)."),
          time: z.string().optional().describe("Hora del turno (HH:mm)."),
        }),
      },
    ),
  ];
};

const createSupportTools = ({
  customerPhone,
  supportState,
  referenceDate,
  timezone = "America/Argentina/Buenos_Aires",
}) => {
  return [
    tool(
      async ({ email, password }) => {
        const authResult = await authenticateCompanyUser({ email, password });
        if (!authResult) {
          return JSON.stringify({
            success: false,
            error: "Credenciales invÃƒÆ’Ã‚Â¡lidas.",
          });
        }
        await setSupportSession({
          customerPhone,
          companyId: authResult.companyId,
          companyName:
            authResult.user.nombre_comercial ||
            `Empresa ${authResult.companyId}`,
          userEmail: authResult.user.email,
        });
        supportState.companyId = authResult.companyId;
        supportState.companyName =
          authResult.user.nombre_comercial || `Empresa ${authResult.companyId}`;
        const companyContext = await getCompanyContextByCompanyId(
          authResult.companyId,
          customerPhone,
        ).catch(() => null);
        return JSON.stringify({
          success: true,
          companyId: authResult.companyId,
          companyName: supportState.companyName,
          professionals:
            companyContext?.professionals?.map((professional) => ({
              id: professional.id,
              name: professional.name,
              services:
                professional.services?.map((service) => service.name) || [],
            })) || [],
          singleProviderMode: companyContext?.professionals?.length === 1,
        });
      },
      {
        name: "login_empresa",
        description:
          "Valida email y contraseÃƒÆ’Ã‚Â±a de empresa para asociar esta conversaciÃƒÆ’Ã‚Â³n.",
        schema: z.object({
          email: z.string().describe("Email de acceso de la empresa."),
          password: z.string().describe("ContraseÃƒÆ’Ã‚Â±a de acceso de la empresa."),
        }),
      },
    ),
    tool(
      async ({ professionalName, serviceId, startDate, endDate, limit }) => {
        if (!supportState.companyId) {
          throw new Error("Primero ejecutÃƒÆ’Ã‚Â¡ login_empresa.");
        }
        const slots = await listAvailableSlots({
          companyId: supportState.companyId,
          professionalName,
          serviceId: serviceId || null,
          startDate,
          endDate,
          referenceDate,
          limit: limit || 30,
        });
        const groupedSlots = summarizeAvailableSlotsForAssistant({
          slots,
          referenceDate,
          timezone,
        });
        return JSON.stringify({
          groupedSlots,
          rules:
            "Usa solamente estos prestadores y estos horarios. Si displayMode es 'range', resumilo como una sola franja continua. Si displayMode es 'multi_range', debes mencionar cada franja por separado y nunca unirlas como si fueran continuas. Si displayMode es 'list', podes enumerar los horarios. Los horarios reservables son SOLO los valores exactos de times: no ofrezcas ni confirmes horas intermedias que no aparezcan ahi. Si un prestador no aparece aca, no lo ofrezcas.",
        });
      },
      {
        name: "find_available_slots",
        description: "Busca horarios disponibles de la empresa autenticada.",
        schema: z.object({
          professionalName: z.string().optional(),
          serviceId: z.number().optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
          limit: z.number().optional().default(30),
        }),
      },
    ),
    tool(
      async ({
        clientName,
        clientPhone,
        professionalId,
        serviceId,
        date,
        time,
      }) => {
        if (!supportState.companyId) {
          throw new Error("Primero ejecutÃƒÆ’Ã‚Â¡ login_empresa.");
        }
        const normalizedClientPhone = String(clientPhone || "")
          .replace(/[^\d]/g, "")
          .trim();
        const appointment = await createAppointmentFromAssistant({
          companyId: supportState.companyId,
          professionalId,
          clientName,
          clientPhone: normalizedClientPhone || null,
          serviceId: serviceId || null,
          date,
          time,
          referenceDate,
        });
        return JSON.stringify({
          appointment: {
            ...appointment,
            humanDate: formatNaturalDate({
              date: appointment.date,
              referenceDate,
              timezone,
            }),
          },
        });
      },
      {
        name: "create_appointment",
        description: "Crea un turno para la empresa autenticada.",
        schema: z.object({
          clientName: z.string(),
          clientPhone: z
            .string()
            .optional()
            .describe(
              "Telefono real del cliente en formato internacional, si lo tenes.",
            ),
          professionalId: z.number(),
          serviceId: z.number().optional(),
          date: z.string(),
          time: z.string(),
        }),
      },
    ),
    tool(
      async ({ date }) => {
        if (!supportState.companyId) {
          throw new Error("Primero ejecutÃƒÆ’Ã‚Â¡ login_empresa.");
        }
        const appointments = await listAppointmentsByDay({
          companyId: supportState.companyId,
          date,
          referenceDate,
        });
        return JSON.stringify({ appointments });
      },
      {
        name: "get_appointments_by_day",
        description: "Lista turnos del dÃƒÆ’Ã‚Â­a de la empresa autenticada.",
        schema: z.object({ date: z.string().optional() }),
      },
    ),
    tool(
      async ({ date, time, professionalName, clientName }) => {
        if (!supportState.companyId) {
          throw new Error("Primero ejecutÃƒÆ’Ã‚Â¡ login_empresa.");
        }
        const result = await cancelAppointmentByCompanyFromAssistant({
          companyId: supportState.companyId,
          date,
          time,
          professionalName,
          clientName,
          referenceDate,
        });
        if (result?.status === "cancelled") {
          const cancelledPayload = {
            date: result.date,
            time: result.time,
            professionalName: result.professional || professionalName || "",
            clientName: result.client || clientName || "",
            clientPhone: result.clientPhone || "",
          };
          supportState.lastCancelled = cancelledPayload;
          setLastCancelledContext({
            operatorPhone: customerPhone,
            payload: cancelledPayload,
          });
        }
        return JSON.stringify(result);
      },
      {
        name: "cancel_appointment",
        description: "Cancela un turno de la empresa autenticada.",
        schema: z.object({
          date: z.string().optional(),
          time: z.string().optional(),
          serviceId: z.number().optional(),
          clientName: z.string().optional(),
        }),
      },
    ),
    tool(
      async ({ date, time, professionalName, clientName, phone }) => {
        const last =
          supportState.lastCancelled ||
          getLastCancelledContext(customerPhone) ||
          {};
        const targetPhone = String(
          phone || last.clientPhone || SUPPORT_NOTIFY_PHONE || "",
        ).replace(/[^\d]/g, "");

        if (!targetPhone) {
          return JSON.stringify({
            success: false,
            error:
              "No encontrÃƒÆ’Ã‚Â© un telÃƒÆ’Ã‚Â©fono destino para avisar (cliente cancelado o SUPPORT_NOTIFY_PHONE).",
          });
        }
        const resolvedDate = date || last.date || "sin fecha";
        const resolvedTime = time || last.time || "";
        const resolvedProfessional =
          professionalName || last.professionalName || "";
        const resolvedClient = clientName || last.clientName || "";

        const text = `Aviso de cancelacion: ${supportState.companyName || "Empresa"} cancela un turno (${resolvedDate} ${resolvedTime})${resolvedProfessional ? `, profesional: ${resolvedProfessional}` : ""}${resolvedClient ? `, cliente: ${resolvedClient}` : ""}.`;

        if (!supportState.companyId) {
          throw new Error(
            "No hay una cuenta de empresa autenticada para enviar el aviso.",
          );
        }

        const {
          buildInstanceName,
          sendTextMessage,
        } = require("../evolution.service");
        const companyInstanceName = buildInstanceName({
          companyId: supportState.companyId,
        });

        try {
          const res = await sendTextMessage(
            targetPhone,
            text,
            companyInstanceName,
          );
          console.log("Aviso de cancelacion enviado", {
            to: targetPhone,
            company: supportState.companyName || supportState.companyId,
            viaInstance: companyInstanceName,
          });
          return JSON.stringify({ success: true, targetPhone, response: res });
        } catch (error) {
          const details = error.response?.data || null;
          console.error(`\n==============================================`);
          console.error(
            "ÃƒÂ¢Ã‚ÂÃ…â€™ ERROR CRÃƒÆ’Ã‚ÂTICO - enviando aviso de cancelaciÃƒÆ’Ã‚Â³n al cliente",
          );
          console.error(
            "  Desde instancia de la empresa:",
            companyInstanceName,
          );
          console.error("  TelÃƒÆ’Ã‚Â©fono destino:", targetPhone);
          console.error("  Texto:", text);
          console.error("  Status HTTP:", error.response?.status || "N/A");
          console.error("  Mensaje error NATIVO:", error.message);
          if (details) {
            console.error("  Detalles Evolution API:");
            console.error(JSON.stringify(details, null, 2));
          }
          console.error(`==============================================\n`);
          return JSON.stringify({
            success: false,
            targetPhone,
            error: error.message || "No se pudo enviar el aviso.",
            details,
          });
        }
      },
      {
        name: "notify_cancellation_contact",
        description:
          "EnvÃƒÆ’Ã‚Â­a aviso al contacto de notificaciÃƒÆ’Ã‚Â³n cuando se confirma una cancelaciÃƒÆ’Ã‚Â³n.",
        schema: z.object({
          date: z.string().optional(),
          time: z.string().optional(),
          serviceId: z.number().optional(),
          clientName: z.string().optional(),
          phone: z
            .string()
            .optional()
            .describe(
              "TelÃƒÆ’Ã‚Â©fono destino opcional; si no se envÃƒÆ’Ã‚Â­a, usa el cliente cancelado.",
            ),
        }),
      },
    ),
  ];
};

const createGraph = ({ tools }) => {
  const modelWithTools = createGeminiModel().bindTools(tools || []);
  const toolNode = new ToolNode(tools);

  const callModel = async (state) => {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  };

  return new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition, ["tools", END])
    .addEdge("tools", "agent")
    .compile();
};

const invokeGeminiGraph = async ({ tools, messages }) => {
  const provider = getGeminiConfig();

  try {
    const graph = createGraph({ tools });
    const result = await invokeWithGeminiHighDemandRetry(
      () => graph.invoke({ messages }),
      {
        provider,
        operationLabel: "la ejecucion del grafo",
      },
    );
    const { reply } = extractAssistantReplyFromMessages(result.messages);

    if (!reply) {
      const recoveredReply = await synthesizeFinalReplyFromMessages({
        messages: result.messages,
      });

      if (recoveredReply) {
        return {
          result: {
            ...result,
            messages: [...result.messages, new AIMessage(recoveredReply)],
          },
          provider,
        };
      }

      const emptyReplyError = new Error(
        "Gemini termino el flujo sin respuesta final.",
      );
      emptyReplyError.code = "empty_final_reply";
      throw emptyReplyError;
    }

    return { result, provider };
  } catch (error) {
    console.error(`❌ Error ejecutando LLM Gemini (${provider.label}):`, {
      message: error.message,
      status: error.response?.status || error.status,
      data: error.response?.data || error.errorDetails || null,
    });
    throw error;
  }
};

const runWhatsappAssistant = async ({
  instanceName,
  incomingMessage,
  companyContext: providedContext = null,
}) => {
  if (!isAssistantConfigured()) {
    return {
      enabled: false,
      reason:
        "Gemini no configurado. Defini GOOGLE_API_KEY en el .env o deshabilita la IA.",
    };
  }

  const customerPhone =
    incomingMessage?.phoneNumber ||
    String(incomingMessage?.from || "")
      .split("@")[0]
      .split(":")[0]
      .replace(/[^\d]/g, "")
      .trim();
  const messageText = String(incomingMessage?.text || "").trim();

  if (!messageText) {
    return {
      enabled: false,
      reason: "Mensaje sin contenido procesable.",
    };
  }

  let companyContext = providedContext;
  if (!companyContext) {
    try {
      companyContext = await getCompanyContextByInstanceName(
        instanceName,
        customerPhone,
      );
    } catch (error) {
      console.error("ÃƒÂ¢Ã‚ÂÃ…â€™ Error cargando contexto:", error.message);
      return {
        enabled: false,
        reason: "Error cargando contexto de la empresa.",
      };
    }
  }

  if (!companyContext) {
    return {
      enabled: false,
      reason: "No hay una empresa asociada a esta instancia.",
    };
  }

  const { sessionState, history } = getActiveWhatsappHistory({
    instanceName,
    customerPhone,
  });
  const preferredName = resolvePreferredContactName(incomingMessage?.pushName);
  const welcomeReply = getConfiguredWelcomeMessage(companyContext, preferredName);
  const realtimeContext = buildRealtimeTemporalContext(companyContext.timezone);
  const effectiveCompanyContext = {
    ...companyContext,
    currentDate: realtimeContext.localDate,
    currentDayName: realtimeContext.localDayName,
    currentTime: realtimeContext.localTime,
  };
  const tools = createTools({
    companyContext: effectiveCompanyContext,
    customerPhone,
  });
  const systemPrompt = buildAssistantPrompt({
    ...effectiveCompanyContext,
    welcomeMessage: welcomeReply,
    currentDate: realtimeContext.localDate,
    currentTime: realtimeContext.localTime,
  });
  const temporalRef = buildTemporalReferenceText(realtimeContext);
  const contactRef = preferredName
    ? `Este cliente figura como '${preferredName}' en WhatsApp.`
    : "No hay nombre de contacto disponible, usa trato neutro.";
  const phoneRef = `Telefono del cliente (no lo pidas): ${customerPhone}.`;
  const availabilityGuardRef = isAvailabilityLookupIntent(messageText)
    ? 'En este mensaje el cliente esta pidiendo turnos, horarios o disponibilidad. Antes de responder, debes ejecutar find_available_slots en esta misma interaccion y responder solo con ese resultado actualizado.'
    : "";

  if (
    shouldSilenceClosingReply({
      lastAssistantReply: sessionState.lastAssistantReply,
      incomingText: messageText,
    })
  ) {
    clearWhatsappSessionState({ instanceName, customerPhone });
    clearConversationHistory({ instanceName, customerPhone });
    return {
      enabled: false,
      reason: "Cierre conversacional tras confirmacion del turno.",
      companyContext: effectiveCompanyContext,
    };
  }

  if (
    shouldUseConfiguredWelcomeReply({
      hasPriorReply: Boolean(sessionState.lastAssistantReply),
      incomingText: messageText,
      welcomeMessage: welcomeReply,
    })
  ) {
    const updatedHistory = [
      ...history,
      new HumanMessage(messageText),
      new AIMessage(welcomeReply),
    ];

    setWhatsappSessionState({
      instanceName,
      customerPhone,
      lastAssistantReply: welcomeReply,
    });
    setConversationHistory({
      instanceName,
      customerPhone,
      messages: updatedHistory,
    });

    return {
      enabled: true,
      text: welcomeReply,
      companyContext: effectiveCompanyContext,
    };
  }

  const { result, provider } = await invokeGeminiGraph({
    tools,
    messages: [
      new SystemMessage(
        `${systemPrompt}\n\n${temporalRef}\n\n${contactRef}\n\n${phoneRef}${availabilityGuardRef ? `\n\n${availabilityGuardRef}` : ""}`,
      ),
      ...history,
      new HumanMessage(messageText),
    ],
  });

  console.log("Graph invoke:", {
    instanceName,
    customerPhone,
    provider: provider.label,
    model: provider.model,
    historyLen: history.length,
    stateless: false,
    resultMessages: result.messages?.length || 0,
  });

  const { reply } = extractAssistantReplyFromMessages(result.messages);
  const hadPriorReply = Boolean(sessionState.lastAssistantReply);
  const finalReply = sanitizeNonReplyOutput(
    ensureFriendlyFirstReply({
      reply: sanitizeAssistantOpening({
        reply: ensureAppointmentConfirmationClosing(reply),
        incomingText: messageText,
      }),
      companyContext: effectiveCompanyContext,
      contactName: preferredName,
      shouldPrefixGreeting: !hadPriorReply,
    }),
  );

  if (!finalReply) {
    return {
      enabled: false,
      reason: "El asistente decidio no responder.",
      companyContext: effectiveCompanyContext,
    };
  }

  setWhatsappSessionState({
    instanceName,
    customerPhone,
    lastAssistantReply: finalReply,
  });
  setConversationHistory({
    instanceName,
    customerPhone,
    messages: result.messages,
  });

  return {
    enabled: true,
    text: finalReply,
    companyContext: effectiveCompanyContext,
  };
};

const runSupportAssistant = async ({ incomingMessage }) => {
  if (!isAssistantConfigured()) {
    return { enabled: false, reason: "Asistente IA no configurado." };
  }

  const customerPhone =
    incomingMessage?.phoneNumber ||
    String(incomingMessage?.from || "")
      .split("@")[0]
      .split(":")[0]
      .replace(/[^\d]/g, "")
      .trim();
  const messageText = String(incomingMessage?.text || "").trim();
  if (!customerPhone || !messageText) {
    return { enabled: false, reason: "Mensaje sin contenido." };
  }

  const persistedSession = await getSupportSession(customerPhone);
  const supportState = {
    companyId: persistedSession?.companyId || null,
    companyName: persistedSession?.companyName || null,
  };
  const supportCompanyContext = supportState.companyId
    ? await getCompanyContextByCompanyId(
        supportState.companyId,
        customerPhone,
      ).catch(() => null)
    : null;

  const realtimeContext = buildRealtimeTemporalContext(
    "America/Argentina/Buenos_Aires",
  );
  const tools = createSupportTools({
    customerPhone,
    supportState,
    referenceDate: realtimeContext.localDate,
    timezone: realtimeContext.timezone,
  });
  const history = getConversationHistory({
    instanceName: SUPPORT_INSTANCE_NAME,
    customerPhone,
  });
  const supportProfessionalsRef = supportCompanyContext?.professionals?.length
    ? `Prestadores activos de la empresa autenticada: ${supportCompanyContext.professionals
        .map((professional) => {
          const services = professional.services
            ?.map((service) => service.name)
            .filter(Boolean)
            .join(", ");
          return `${professional.name} (ID ${professional.id}${services ? `, servicios: ${services}` : ""})`;
        })
        .join(" | ")}.`
    : "Prestadores activos de la empresa autenticada: sin datos cargados.";
  const singleSupportProviderRule =
    supportCompanyContext?.professionals?.length === 1
      ? `Hay exactamente un solo prestador activo en esta empresa: ${supportCompanyContext.professionals[0].name} (ID ${supportCompanyContext.professionals[0].id}). Si te piden agendar un turno, NO preguntes con que profesional. Asumi ese prestador automaticamente para buscar disponibilidad y para crear el turno.`
      : "Si hay mas de un prestador activo y el cliente no especifico cual quiere, ahi si pedi o inferi el prestador correcto antes de crear el turno.";
  const supportPrompt = `Sos el bot de soporte de Citax por WhatsApp.
Si la conversaciÃƒÆ’Ã‚Â³n no tiene empresa autenticada, pedÃƒÆ’Ã‚Â­ email y contraseÃƒÆ’Ã‚Â±a de forma clara.
Cuando tengas email y contraseÃƒÆ’Ã‚Â±a, ejecutÃƒÆ’Ã‚Â¡ la tool login_empresa.
No digas que el login fue exitoso sin ejecutar la tool.
DespuÃƒÆ’Ã‚Â©s del login, podÃƒÆ’Ã‚Â©s ayudar con: agendar turno, cancelar turno y ver agenda del dÃƒÆ’Ã‚Â­a usando tools.
${singleSupportProviderRule}
Si vas a agendar un turno para un cliente de la empresa, con el nombre del cliente alcanza para crear el turno.
Solo pedÃƒÆ’Ã‚Â­ telefono del cliente si realmente hace falta como dato adicional o si la empresa quiere dejarlo asociado.
Nunca uses el numero de WhatsApp del operador que estÃƒÆ’Ã‚Â¡ hablando con soporte como telefono del cliente, salvo que te digan explÃƒÆ’Ã‚Â­citamente que el turno es para ese mismo numero.
Cuando canceles un turno y la cancelaciÃƒÆ’Ã‚Â³n sea exitosa, preguntÃƒÆ’Ã‚Â¡ explÃƒÆ’Ã‚Â­citamente: "Ãƒâ€šÃ‚Â¿QuerÃƒÆ’Ã‚Â©s que le avise al cliente?".
Si te responden que sÃƒÆ’Ã‚Â­, ejecutÃƒÆ’Ã‚Â¡ notify_cancellation_contact.
Primero intentÃƒÆ’Ã‚Â¡ avisar al cliente del turno cancelado; si no hay telÃƒÆ’Ã‚Â©fono de cliente, usÃƒÆ’Ã‚Â¡ el contacto general (${SUPPORT_NOTIFY_LABEL}) si estÃƒÆ’Ã‚Â¡ configurado.
Nunca confirmes que se enviÃƒÆ’Ã‚Â³ un aviso si la tool devuelve success=false.
RespondÃƒÆ’Ã‚Â© en espaÃƒÆ’Ã‚Â±ol, corto y claro, estilo WhatsApp.
Empresa autenticada actual: ${supportState.companyName || "ninguna"}.
${supportProfessionalsRef}
${buildTemporalReferenceText(realtimeContext)}`;

  const { result, provider } = await invokeGeminiGraph({
    tools,
    messages: [
      new SystemMessage(supportPrompt),
      ...history,
      new HumanMessage(messageText),
    ],
  });

  console.log("ÃƒÂ°Ã…Â¸Ã‚Â¤Ã¢â‚¬â€œ Support graph invoke:", {
    customerPhone,
    provider: provider.label,
    model: provider.model,
    historyLen: history.length,
    resultMessages: result.messages?.length || 0,
  });

  const { reply } = extractAssistantReplyFromMessages(result.messages);

  if (!reply) return { enabled: false, reason: "Sin respuesta generada." };

  if (supportState.companyId && supportState.companyName) {
    await setSupportSession({
      customerPhone,
      companyId: supportState.companyId,
      companyName: supportState.companyName,
      userEmail: persistedSession?.userEmail || "",
    });
  }

  setConversationHistory({
    instanceName: SUPPORT_INSTANCE_NAME,
    customerPhone,
    messages: result.messages,
  });
  return { enabled: true, text: reply };
};

module.exports = {
  isAssistantConfigured,
  runWhatsappAssistant,
  runSupportAssistant,
  __testables: {
    getGeminiConfig,
    isGeminiHighDemandError,
    invokeWithGeminiHighDemandRetry,
    getConfiguredWelcomeMessage,
    extractAssistantReplyFromMessages,
    isClosingOnlyMessage,
    isGreetingOnlyMessage,
    looksLikeAppointmentConfirmation,
    ensureAppointmentConfirmationClosing,
    sanitizeNonReplyOutput,
    shouldSilenceClosingReply,
    shouldUseConfiguredWelcomeReply,
    isAvailabilityLookupIntent,
    buildFriendlyGreetingPrefix,
    ensureFriendlyFirstReply,
    buildRealtimeTemporalContext,
    buildTemporalReferenceText,
    buildFinalReplyRecoveryMessages,
    sanitizeAssistantOpening,
    parseInlineToolCallsFromContent,
    sanitizeAssistantReply,
    stringifyMessageContent,
  },
};
