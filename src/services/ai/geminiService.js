const { HumanMessage, SystemMessage, isAIMessage } = require("@langchain/core/messages");
const { tool } = require("@langchain/core/tools");
const { StateGraph, MessagesAnnotation, END, START } = require("@langchain/langgraph");
const { ToolNode, toolsCondition } = require("@langchain/langgraph/prebuilt");
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { z } = require("zod");

const {
  cancelAppointmentFromAssistant,
  createAppointmentFromAssistant,
  getCompanyContextByInstanceName,
  listAvailableSlots,
  listAppointmentsByDay,
} = require("./companyContextService");
const { buildAssistantPrompt } = require("./assistantPrompt");

const GEMINI_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const AI_ENABLED = (process.env.WHATSAPP_AI_ENABLED || "true") === "true";
const conversationMemory = new Map();
const MAX_CONVERSATION_MESSAGES = 24;

const getConversationKey = ({ instanceName, customerPhone }) => `${instanceName}:${customerPhone}`;

const getConversationHistory = ({ instanceName, customerPhone }) => {
  return conversationMemory.get(getConversationKey({ instanceName, customerPhone })) || [];
};

const setConversationHistory = ({ instanceName, customerPhone, messages }) => {
  const filtered = messages
    .filter((m) => m._getType?.() !== "system")
    .slice(-MAX_CONVERSATION_MESSAGES);
  conversationMemory.set(getConversationKey({ instanceName, customerPhone }), filtered);
};

const isAssistantConfigured = () => AI_ENABLED && Boolean(GEMINI_API_KEY);

const createModel = () => {
  return new ChatGoogleGenerativeAI({
    apiKey: GEMINI_API_KEY,
    model: GEMINI_MODEL,
    temperature: 0,
    maxRetries: 2,
  });
};

const resolvePreferredContactName = (rawName) => {
  const first = String(rawName || "").replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/).filter(Boolean)[0];
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
          professionals: companyContext.professionals,
          services: companyContext.services,
        });
      },
      {
        name: "get_company_context",
        description: "Devuelve el contexto del negocio: prestadores, servicios y datos.",
        schema: z.object({}),
      }
    ),
    tool(
      async ({ professionalName, startDate, endDate, limit }) => {
        const slots = await listAvailableSlots({
          companyId: companyContext.companyId,
          professionalName,
          startDate,
          endDate,
          referenceDate: companyContext.currentDate,
          limit: limit || 30,
        });
        return JSON.stringify({ slots });
      },
      {
        name: "find_available_slots",
        description: "Busca horarios disponibles para un prestador en un rango de fechas.",
        schema: z.object({
          professionalName: z.string().optional().describe("Nombre del prestador."),
          startDate: z.string().optional().describe("Fecha desde (YYYY-MM-DD)."),
          endDate: z.string().optional().describe("Fecha hasta (YYYY-MM-DD)."),
          limit: z.number().optional().default(30).describe("Máximo de resultados (1-40)."),
        }),
      }
    ),
    tool(
      async ({ clientName, professionalId, serviceId, date, time }) => {
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
        return JSON.stringify({ appointment });
      },
      {
        name: "create_appointment",
        description: "Crea un turno confirmado. Solo usar cuando el cliente ya confirmó.",
        schema: z.object({
          clientName: z.string().describe("Nombre del cliente (mínimo 3 caracteres)."),
          professionalId: z.number().describe("ID del prestador."),
          serviceId: z.number().optional().describe("ID del servicio (si se omite se usa el primero disponible)."),
          date: z.string().describe("Fecha del turno (YYYY-MM-DD)."),
          time: z.string().describe("Hora de inicio (HH:mm)."),
        }),
      }
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
        description: "Lista los turnos reservados para un día específico.",
        schema: z.object({
          date: z.string().optional().describe("Fecha a consultar (YYYY-MM-DD)."),
        }),
      }
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
          return `Encontré varios turnos. ¿Cuál querés cancelar?\n${result.appointments.map((a) => `- ${a.date} a las ${a.time}`).join("\n")}`;
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
      }
    ),
  ];
};

const createGraph = (tools) => {
  const modelWithTools = createModel().bindTools(tools);
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

const runWhatsappAssistant = async ({ instanceName, incomingMessage, companyContext: providedContext = null }) => {
  if (!isAssistantConfigured()) {
    return {
      enabled: false,
      reason: "Gemini no está configurado. Falta GOOGLE_API_KEY o AI está deshabilitado.",
    };
  }

  const customerPhone =
    incomingMessage?.phoneNumber ||
    String(incomingMessage?.from || "").split("@")[0].split(":")[0].replace(/[^\d]/g, "").trim();
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
      companyContext = await getCompanyContextByInstanceName(instanceName, customerPhone);
    } catch (error) {
      console.error("❌ Error cargando contexto:", error.message);
      return { enabled: false, reason: "Error cargando contexto de la empresa." };
    }
  }

  if (!companyContext) {
    return { enabled: false, reason: "No hay una empresa asociada a esta instancia." };
  }

  const tools = createTools({ companyContext, customerPhone });
  const graph = createGraph(tools);
  const systemPrompt = buildAssistantPrompt(companyContext);

  const preferredName = resolvePreferredContactName(incomingMessage?.pushName);
  const temporalRef = `Referencia temporal: hoy es ${companyContext.currentDayName} ${companyContext.currentDate} y la hora actual es ${companyContext.currentTime} (${companyContext.timezone}).`;
  const contactRef = preferredName
    ? `Este cliente figura como '${preferredName}' en WhatsApp.`
    : "No hay nombre de contacto disponible, usá trato neutro.";
  const phoneRef = `Teléfono del cliente (no lo pidas): ${customerPhone}.`;

  const history = getConversationHistory({ instanceName, customerPhone });

  const result = await graph.invoke({
    messages: [
      new SystemMessage(`${systemPrompt}\n\n${temporalRef}\n\n${contactRef}\n\n${phoneRef}`),
      ...history,
      new HumanMessage(messageText),
    ],
  });

  console.log("🤖 Graph invoke:", {
    instanceName,
    customerPhone,
    historyLen: history.length,
    resultMessages: result.messages?.length || 0,
  });

  const lastAI = [...result.messages].reverse().find((m) => isAIMessage(m) && !m.tool_calls?.length);

  let reply = "";
  if (lastAI) {
    reply = typeof lastAI.content === "string"
      ? lastAI.content.trim()
      : Array.isArray(lastAI.content)
        ? lastAI.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n").trim()
        : "";
  }

  if (!reply) {
    return { enabled: false, reason: "El asistente decidió no responder.", companyContext };
  }

  setConversationHistory({ instanceName, customerPhone, messages: result.messages });

  return {
    enabled: true,
    text: reply,
    companyContext,
  };
};

module.exports = {
  isAssistantConfigured,
  runWhatsappAssistant,
};
