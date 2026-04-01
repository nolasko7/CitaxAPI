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
const { z } = require("zod");
const axios = require("axios");

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
const DEFAULT_PROVIDER_BASE_URLS = {
  ollama: "http://localhost:11434/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};
const DEFAULT_PROVIDER_MODELS = {
  ollama: "llama3.2",
  groq: "llama-3.3-70b-versatile",
  openrouter: "openrouter/free",
};
const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE || 0);
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 1200);
const LLM_REQUEST_TIMEOUT_MS = Number(
  process.env.LLM_REQUEST_TIMEOUT_MS || 45000,
);
const conversationMemory = new Map();
const MAX_CONVERSATION_MESSAGES = 24;
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

const normalizeProviderName = (value, fallback = "") => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized || fallback;
};

const resolveOllamaOpenAiBaseUrl = (value) => {
  const normalized = String(value || "")
    .trim()
    .replace(/\/$/, "");

  if (!normalized) {
    return DEFAULT_PROVIDER_BASE_URLS.ollama;
  }

  if (normalized.endsWith("/v1")) {
    return normalized;
  }

  if (normalized.endsWith("/api")) {
    return `${normalized.slice(0, -4)}/v1`;
  }

  return `${normalized}/v1`;
};

const getProviderApiKeyFromEnv = (providerName) => {
  if (providerName === "ollama") {
    return String(process.env.OLLAMA_API_KEY || "").trim();
  }

  if (providerName === "groq") {
    return String(process.env.GROQ_API_KEY || "").trim();
  }

  if (providerName === "openrouter") {
    return String(process.env.OPENROUTER_API_KEY || "").trim();
  }

  return "";
};

const getProviderBaseUrlFromEnv = (providerName) => {
  if (providerName === "ollama") {
    return resolveOllamaOpenAiBaseUrl(
      process.env.OLLAMA_API_URL || DEFAULT_PROVIDER_BASE_URLS.ollama,
    );
  }

  if (providerName === "groq") {
    return String(
      process.env.GROQ_BASE_URL || DEFAULT_PROVIDER_BASE_URLS.groq,
    ).trim();
  }

  if (providerName === "openrouter") {
    return String(
      process.env.OPENROUTER_BASE_URL || DEFAULT_PROVIDER_BASE_URLS.openrouter,
    ).trim();
  }

  return "";
};

const getProviderModelFromEnv = (providerName) => {
  if (providerName === "ollama") {
    return String(
      process.env.OLLAMA_MODEL || DEFAULT_PROVIDER_MODELS.ollama,
    ).trim();
  }

  if (providerName === "groq") {
    return String(
      process.env.GROQ_MODEL || DEFAULT_PROVIDER_MODELS.groq,
    ).trim();
  }

  if (providerName === "openrouter") {
    return String(
      process.env.OPENROUTER_MODEL || DEFAULT_PROVIDER_MODELS.openrouter,
    ).trim();
  }

  return "";
};

const resolveSlotProviderConfig = ({ slot, defaultProvider }) => {
  const prefix = slot === "primary" ? "LLM_PRIMARY" : "LLM_FALLBACK";
  const providerName = normalizeProviderName(
    process.env[`${prefix}_PROVIDER`],
    defaultProvider,
  );
  const apiKey =
    String(process.env[`${prefix}_API_KEY`] || "").trim() ||
    getProviderApiKeyFromEnv(providerName);
  const baseUrl =
    String(process.env[`${prefix}_BASE_URL`] || "").trim() ||
    getProviderBaseUrlFromEnv(providerName) ||
    DEFAULT_PROVIDER_BASE_URLS[providerName] ||
    "";
  const model =
    String(process.env[`${prefix}_MODEL`] || "").trim() ||
    getProviderModelFromEnv(providerName) ||
    DEFAULT_PROVIDER_MODELS[providerName] ||
    "";
  const label =
    String(process.env[`${prefix}_LABEL`] || "").trim() ||
    `${providerName}-${model}`;

  return {
    name: providerName,
    label,
    apiKey,
    baseUrl,
    model,
  };
};

const PRIMARY_PROVIDER_CONFIG = resolveSlotProviderConfig({
  slot: "primary",
  defaultProvider: "groq",
});
const FALLBACK_PROVIDER_CONFIG = resolveSlotProviderConfig({
  slot: "fallback",
  defaultProvider: "openrouter",
});

const getConversationKey = ({ instanceName, customerPhone }) =>
  `${instanceName}:${customerPhone}`;

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

const isAssistantConfigured = () =>
  AI_ENABLED &&
  Boolean(PRIMARY_PROVIDER_CONFIG.apiKey || FALLBACK_PROVIDER_CONFIG.apiKey);

const buildRealtimeTemporalContext = (
  timezone = "America/Argentina/Buenos_Aires",
) => {
  const now = new Date();
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

  return {
    isoUtc,
    localDate,
    localTime,
    timezone,
  };
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

const getConfiguredProviders = () => {
  const providers = [];

  if (PRIMARY_PROVIDER_CONFIG.apiKey) {
    providers.push(PRIMARY_PROVIDER_CONFIG);
  }

  if (FALLBACK_PROVIDER_CONFIG.apiKey) {
    providers.push(FALLBACK_PROVIDER_CONFIG);
  }

  return providers;
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

const toOpenAIChatMessage = (message) => {
  const type = message?._getType?.();
  const content = stringifyMessageContent(message?.content);

  if (type === "system") {
    return { role: "system", content };
  }

  if (type === "human") {
    return { role: "user", content };
  }

  if (type === "tool") {
    return {
      role: "tool",
      tool_call_id: message.tool_call_id,
      content,
    };
  }

  if (type === "ai") {
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
          .filter((toolCall) => toolCall?.name)
          .map((toolCall, index) => ({
            id: toolCall.id || `tool_call_${index + 1}`,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.args || {}),
            },
          }))
      : undefined;

    return {
      role: "assistant",
      content,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    };
  }

  return { role: "user", content };
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
  incomingText = "",
  welcomeMessage = "",
}) => {
  if (!String(welcomeMessage || "").trim()) {
    return false;
  }

  return history.length === 0 && isGreetingOnlyMessage(incomingText);
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

const shouldSilenceClosingReply = ({ history = [], incomingText = "" }) => {
  if (!isClosingOnlyMessage(incomingText)) {
    return false;
  }

  const { reply } = extractAssistantReplyFromMessages(history);
  return looksLikeAppointmentConfirmation(reply);
};

const toLangChainAIMessage = (responseData) => {
  const choice = responseData?.choices?.[0]?.message || {};
  const toolCalls = [];
  const invalidToolCalls = [];

  for (const toolCall of choice.tool_calls || []) {
    const name = toolCall?.function?.name;
    const argsText = toolCall?.function?.arguments || "{}";

    if (!name) {
      invalidToolCalls.push({
        id: toolCall?.id,
        args: argsText,
        error: "Tool call sin nombre.",
      });
      continue;
    }

    const parsedArgs = safeParseToolArgs(argsText);
    if (parsedArgs?.__parseError) {
      invalidToolCalls.push({
        id: toolCall?.id,
        name,
        args: argsText,
        error: parsedArgs.__parseError,
      });
      continue;
    }

    toolCalls.push({
      id: toolCall?.id,
      name,
      args: parsedArgs,
    });
  }

  const inlineToolData = parseInlineToolCallsFromContent(choice.content || "");
  toolCalls.push(...inlineToolData.toolCalls);
  invalidToolCalls.push(...inlineToolData.invalidToolCalls);

  return new AIMessage({
    content: inlineToolData.content,
    tool_calls: toolCalls,
    invalid_tool_calls: invalidToolCalls,
    response_metadata: {
      provider: responseData?.provider || null,
      model: responseData?.model || null,
      finish_reason: responseData?.choices?.[0]?.finish_reason || null,
    },
    usage_metadata: responseData?.usage
      ? {
          input_tokens: responseData.usage.prompt_tokens || 0,
          output_tokens: responseData.usage.completion_tokens || 0,
          total_tokens: responseData.usage.total_tokens || 0,
        }
      : undefined,
  });
};

const buildProviderHeaders = (provider) => {
  const headers = {
    "Content-Type": "application/json",
  };

  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }

  if (provider.name === "openrouter") {
    headers["X-Title"] = process.env.OPENROUTER_APP_NAME || "CitaxAPI";
    if (process.env.OPENROUTER_HTTP_REFERER) {
      headers["HTTP-Referer"] = process.env.OPENROUTER_HTTP_REFERER;
    }
  }

  return headers;
};

const createModel = (provider) => {
  return {
    bindTools(toolDefinitions = []) {
      return {
        invoke: async (messages) => {
          const payload = {
            model: provider.model,
            messages: messages.map(toOpenAIChatMessage),
            temperature: LLM_TEMPERATURE,
            max_tokens: LLM_MAX_TOKENS,
          };

          if (toolDefinitions.length) {
            payload.tools = toolDefinitions;
            payload.tool_choice = "auto";
          }

          const response = await axios.post(
            `${String(provider.baseUrl || "").replace(/\/$/, "")}/chat/completions`,
            payload,
            {
              headers: buildProviderHeaders(provider),
              timeout: LLM_REQUEST_TIMEOUT_MS,
            },
          );

          return toLangChainAIMessage({
            ...response.data,
            provider: provider.label,
          });
        },
      };
    },
  };
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
              "Para saber si este prestador atiende un dÃ­a u horario, DEBES usar obligatoriamente la herramienta find_available_slots. NO asumas ningÃºn horario comercial.",
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
            "UsÃ¡ solamente estos prestadores y estos horarios. Si displayMode es 'range', resumÃ­ como rango. Si es 'list', podÃ©s enumerar los horarios. Si un prestador no aparece acÃ¡, no lo ofrezcas.",
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
            .describe("MÃ¡ximo de resultados (1-40)."),
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
          "Crea un turno confirmado. Solo usar cuando el cliente ya confirmÃ³.",
        schema: z.object({
          clientName: z
            .string()
            .describe("Nombre del cliente (mÃ­nimo 3 caracteres)."),
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
        description: "Lista los turnos reservados para un dÃ­a especÃ­fico.",
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
          return `EncontrÃ© varios turnos. Â¿CuÃ¡l querÃ©s cancelar?\n${result.appointments.map((a) => `- ${a.date} a las ${a.time}`).join("\n")}`;
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

const createSupportTools = ({ customerPhone, supportState }) => {
  return [
    tool(
      async ({ email, password }) => {
        const authResult = await authenticateCompanyUser({ email, password });
        if (!authResult) {
          return JSON.stringify({
            success: false,
            error: "Credenciales invÃ¡lidas.",
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
          "Valida email y contraseÃ±a de empresa para asociar esta conversaciÃ³n.",
        schema: z.object({
          email: z.string().describe("Email de acceso de la empresa."),
          password: z.string().describe("ContraseÃ±a de acceso de la empresa."),
        }),
      },
    ),
    tool(
      async ({ professionalName, serviceId, startDate, endDate, limit }) => {
        if (!supportState.companyId) {
          throw new Error("Primero ejecutÃ¡ login_empresa.");
        }
        const slots = await listAvailableSlots({
          companyId: supportState.companyId,
          professionalName,
          serviceId: serviceId || null,
          startDate,
          endDate,
          referenceDate: new Date().toISOString().slice(0, 10),
          limit: limit || 30,
        });
        const groupedSlots = summarizeAvailableSlotsForAssistant({
          slots,
          referenceDate: new Date().toISOString().slice(0, 10),
          timezone: "America/Argentina/Buenos_Aires",
        });
        return JSON.stringify({
          groupedSlots,
          rules:
            "UsÃ¡ solamente estos prestadores y estos horarios. Si displayMode es 'range', resumÃ­ como rango. Si es 'list', podÃ©s enumerar los horarios. Si un prestador no aparece acÃ¡, no lo ofrezcas.",
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
          throw new Error("Primero ejecutÃ¡ login_empresa.");
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
          referenceDate: new Date().toISOString().slice(0, 10),
        });
        return JSON.stringify({
          appointment: {
            ...appointment,
            humanDate: formatNaturalDate({
              date: appointment.date,
              referenceDate: new Date().toISOString().slice(0, 10),
              timezone: "America/Argentina/Buenos_Aires",
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
          throw new Error("Primero ejecutÃ¡ login_empresa.");
        }
        const appointments = await listAppointmentsByDay({
          companyId: supportState.companyId,
          date,
          referenceDate: new Date().toISOString().slice(0, 10),
        });
        return JSON.stringify({ appointments });
      },
      {
        name: "get_appointments_by_day",
        description: "Lista turnos del dÃ­a de la empresa autenticada.",
        schema: z.object({ date: z.string().optional() }),
      },
    ),
    tool(
      async ({ date, time, professionalName, clientName }) => {
        if (!supportState.companyId) {
          throw new Error("Primero ejecutÃ¡ login_empresa.");
        }
        const result = await cancelAppointmentByCompanyFromAssistant({
          companyId: supportState.companyId,
          date,
          time,
          professionalName,
          clientName,
          referenceDate: new Date().toISOString().slice(0, 10),
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
              "No encontrÃ© un telÃ©fono destino para avisar (cliente cancelado o SUPPORT_NOTIFY_PHONE).",
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
            "âŒ ERROR CRÃTICO - enviando aviso de cancelaciÃ³n al cliente",
          );
          console.error(
            "  Desde instancia de la empresa:",
            companyInstanceName,
          );
          console.error("  TelÃ©fono destino:", targetPhone);
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
          "EnvÃ­a aviso al contacto de notificaciÃ³n cuando se confirma una cancelaciÃ³n.",
        schema: z.object({
          date: z.string().optional(),
          time: z.string().optional(),
          serviceId: z.number().optional(),
          clientName: z.string().optional(),
          phone: z
            .string()
            .optional()
            .describe(
              "TelÃ©fono destino opcional; si no se envÃ­a, usa el cliente cancelado.",
            ),
        }),
      },
    ),
  ];
};

// â”€â”€â”€ OpenAI-compatible tool definitions for Groq / OpenRouter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const TOOL_DEFINITIONS_BY_NAME = {
  login_empresa: {
    type: "function",
    function: {
      name: "login_empresa",
      description:
        "Valida email y contraseÃ±a de empresa para asociar esta conversaciÃ³n.",
      parameters: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description: "Email de acceso de la empresa.",
          },
          password: {
            type: "string",
            description: "ContraseÃ±a de acceso de la empresa.",
          },
        },
        required: ["email", "password"],
      },
    },
  },
  get_company_context: {
    type: "function",
    function: {
      name: "get_company_context",
      description:
        "Devuelve el contexto del negocio: prestadores, servicios y datos.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  find_available_slots: {
    type: "function",
    function: {
      name: "find_available_slots",
      description:
        "Busca horarios disponibles para un prestador en un rango de fechas.",
      parameters: {
        type: "object",
        properties: {
          professionalName: {
            type: "string",
            description: "Nombre del prestador.",
          },
          serviceId: {
            type: "number",
            description: "ID del servicio para respetar la duracion real.",
          },
          startDate: {
            type: "string",
            description: "Fecha desde en formato YYYY-MM-DD.",
          },
          endDate: {
            type: "string",
            description: "Fecha hasta en formato YYYY-MM-DD.",
          },
          limit: {
            type: "number",
            description: "MÃ¡ximo de resultados (1-40).",
          },
        },
        required: [],
      },
    },
  },
  create_appointment: {
    type: "function",
    function: {
      name: "create_appointment",
      description:
        "Crea un turno confirmado. Solo usar cuando el cliente ya confirmÃ³.",
      parameters: {
        type: "object",
        properties: {
          clientName: {
            type: "string",
            description: "Nombre del cliente (mÃ­nimo 3 caracteres).",
          },
          clientPhone: {
            type: "string",
            description:
              "Telefono real del cliente en formato internacional, si lo tenes.",
          },
          professionalId: {
            type: "number",
            description: "ID del prestador.",
          },
          serviceId: {
            type: "number",
            description:
              "ID del servicio (si se omite se usa el primero disponible).",
          },
          date: {
            type: "string",
            description: "Fecha del turno (YYYY-MM-DD).",
          },
          time: {
            type: "string",
            description: "Hora de inicio (HH:mm).",
          },
        },
        required: ["clientName", "professionalId", "date", "time"],
      },
    },
  },
  get_appointments_by_day: {
    type: "function",
    function: {
      name: "get_appointments_by_day",
      description: "Lista los turnos reservados para un dÃ­a especÃ­fico.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Fecha a consultar en formato YYYY-MM-DD.",
          },
        },
        required: [],
      },
    },
  },
  cancel_appointment: {
    type: "function",
    function: {
      name: "cancel_appointment",
      description: "Cancela un turno existente.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Fecha del turno (YYYY-MM-DD).",
          },
          time: {
            type: "string",
            description: "Hora del turno (HH:mm).",
          },
          professionalName: {
            type: "string",
            description: "Nombre del profesional.",
          },
          clientName: {
            type: "string",
            description: "Nombre del cliente.",
          },
          phone: {
            type: "string",
            description: "TelÃ©fono destino opcional para avisos.",
          },
        },
        required: [],
      },
    },
  },
  notify_cancellation_contact: {
    type: "function",
    function: {
      name: "notify_cancellation_contact",
      description:
        "EnvÃ­a aviso al contacto configurado sobre una cancelaciÃ³n confirmada.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string" },
          time: { type: "string" },
          professionalName: { type: "string" },
          clientName: { type: "string" },
          phone: { type: "string" },
        },
        required: [],
      },
    },
  },
};

const getToolDefinitions = (tools) => {
  const names = new Set(
    (tools || []).map((candidate) => candidate?.name).filter(Boolean),
  );

  return [...names]
    .map((name) => TOOL_DEFINITIONS_BY_NAME[name])
    .filter(Boolean);
};

const createGraph = ({ provider, tools }) => {
  const modelWithTools = createModel(provider).bindTools(
    getToolDefinitions(tools),
  );
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

const invokeGraphWithFallback = async ({ tools, messages }) => {
  const providers = getConfiguredProviders();
  let lastError = null;

  for (const provider of providers) {
    try {
      const graph = createGraph({ provider, tools });
      const result = await graph.invoke({ messages });
      const { reply } = extractAssistantReplyFromMessages(result.messages);

      if (!reply) {
        const emptyReplyError = new Error(
          "El proveedor terminÃ³ el flujo sin respuesta final.",
        );
        emptyReplyError.code = "empty_final_reply";
        throw emptyReplyError;
      }

      return { result, provider };
    } catch (error) {
      lastError = error;
      console.error(`âŒ Error ejecutando proveedor LLM (${provider.label}):`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data || null,
      });
    }
  }

  throw lastError || new Error("No hay proveedores LLM configurados.");
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
        "LLM no configurada. DefinÃ­ la API key del proveedor primario o secundario, o deshabilitÃ¡ la IA.",
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
      console.error("âŒ Error cargando contexto:", error.message);
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

  const preferredName = resolvePreferredContactName(incomingMessage?.pushName);
  const welcomeReply = getConfiguredWelcomeMessage(companyContext, preferredName);
  const tools = createTools({ companyContext, customerPhone });
  const realtimeContext = buildRealtimeTemporalContext(companyContext.timezone);
  const systemPrompt = buildAssistantPrompt({
    ...companyContext,
    welcomeMessage: welcomeReply,
    currentDate: realtimeContext.localDate,
    currentTime: realtimeContext.localTime,
  });
  const temporalRef = `Referencia temporal obligatoria: fecha local actual ${realtimeContext.localDate}, hora local ${realtimeContext.localTime}, zona ${realtimeContext.timezone}, timestamp UTC ${realtimeContext.isoUtc}. UsÃ¡ esta referencia como fuente de verdad para interpretar "hoy", "maÃ±ana" y fechas relativas.`;
  const contactRef = preferredName
    ? `Este cliente figura como '${preferredName}' en WhatsApp.`
    : "No hay nombre de contacto disponible, usÃ¡ trato neutro.";
  const phoneRef = `TelÃ©fono del cliente (no lo pidas): ${customerPhone}.`;

  const history = getConversationHistory({ instanceName, customerPhone });
  if (shouldSilenceClosingReply({ history, incomingText: messageText })) {
    clearConversationHistory({ instanceName, customerPhone });
    return {
      enabled: false,
      reason: "Cierre conversacional tras confirmacion del turno.",
      companyContext,
    };
  }

  if (
    shouldUseConfiguredWelcomeReply({
      history,
      incomingText: messageText,
      welcomeMessage: welcomeReply,
    })
  ) {
    const updatedHistory = [
      ...history,
      new HumanMessage(messageText),
      new AIMessage(welcomeReply),
    ];

    setConversationHistory({
      instanceName,
      customerPhone,
      messages: updatedHistory,
    });

    return {
      enabled: true,
      text: welcomeReply,
      companyContext,
    };
  }
  const { result, provider } = await invokeGraphWithFallback({
    tools,
    messages: [
      new SystemMessage(
        `${systemPrompt}\n\n${temporalRef}\n\n${contactRef}\n\n${phoneRef}`,
      ),
      ...history,
      new HumanMessage(messageText),
    ],
  });

  console.log("ðŸ¤– Graph invoke:", {
    instanceName,
    customerPhone,
    provider: provider.label,
    model: provider.model,
    historyLen: history.length,
    resultMessages: result.messages?.length || 0,
  });

  const { reply } = extractAssistantReplyFromMessages(result.messages);
  const finalReply = sanitizeNonReplyOutput(
    ensureAppointmentConfirmationClosing(reply),
  );

  if (!finalReply) {
    return {
      enabled: false,
      reason: "El asistente decidiÃ³ no responder.",
      companyContext,
    };
  }

  setConversationHistory({
    instanceName,
    customerPhone,
    messages: result.messages,
  });

  return {
    enabled: true,
    text: finalReply,
    companyContext,
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

  const tools = createSupportTools({ customerPhone, supportState });
  const history = getConversationHistory({
    instanceName: SUPPORT_INSTANCE_NAME,
    customerPhone,
  });

  const realtimeContext = buildRealtimeTemporalContext(
    "America/Argentina/Buenos_Aires",
  );
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
Si la conversaciÃ³n no tiene empresa autenticada, pedÃ­ email y contraseÃ±a de forma clara.
Cuando tengas email y contraseÃ±a, ejecutÃ¡ la tool login_empresa.
No digas que el login fue exitoso sin ejecutar la tool.
DespuÃ©s del login, podÃ©s ayudar con: agendar turno, cancelar turno y ver agenda del dÃ­a usando tools.
${singleSupportProviderRule}
Si vas a agendar un turno para un cliente de la empresa, con el nombre del cliente alcanza para crear el turno.
Solo pedÃ­ telefono del cliente si realmente hace falta como dato adicional o si la empresa quiere dejarlo asociado.
Nunca uses el numero de WhatsApp del operador que estÃ¡ hablando con soporte como telefono del cliente, salvo que te digan explÃ­citamente que el turno es para ese mismo numero.
Cuando canceles un turno y la cancelaciÃ³n sea exitosa, preguntÃ¡ explÃ­citamente: "Â¿QuerÃ©s que le avise al cliente?".
Si te responden que sÃ­, ejecutÃ¡ notify_cancellation_contact.
Primero intentÃ¡ avisar al cliente del turno cancelado; si no hay telÃ©fono de cliente, usÃ¡ el contacto general (${SUPPORT_NOTIFY_LABEL}) si estÃ¡ configurado.
Nunca confirmes que se enviÃ³ un aviso si la tool devuelve success=false.
RespondÃ© en espaÃ±ol, corto y claro, estilo WhatsApp.
Empresa autenticada actual: ${supportState.companyName || "ninguna"}.
${supportProfessionalsRef}
Referencia temporal obligatoria: fecha local actual ${realtimeContext.localDate}, hora local ${realtimeContext.localTime}, zona ${realtimeContext.timezone}, timestamp UTC ${realtimeContext.isoUtc}.`;

  const { result, provider } = await invokeGraphWithFallback({
    tools,
    messages: [
      new SystemMessage(supportPrompt),
      ...history,
      new HumanMessage(messageText),
    ],
  });

  console.log("ðŸ¤– Support graph invoke:", {
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
    getConfiguredProviders,
    getConfiguredWelcomeMessage,
    getToolDefinitions,
    extractAssistantReplyFromMessages,
    isClosingOnlyMessage,
    isGreetingOnlyMessage,
    looksLikeAppointmentConfirmation,
    ensureAppointmentConfirmationClosing,
    sanitizeNonReplyOutput,
    shouldSilenceClosingReply,
    shouldUseConfiguredWelcomeReply,
    parseInlineToolCallsFromContent,
    sanitizeAssistantReply,
    stringifyMessageContent,
    toOpenAIChatMessage,
    toLangChainAIMessage,
  },
};
