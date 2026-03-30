const { HumanMessage, SystemMessage, isAIMessage } = require("@langchain/core/messages");
const { tool } = require("@langchain/core/tools");
const { StateGraph, MessagesAnnotation, END, START } = require("@langchain/langgraph");
const { ToolNode, toolsCondition } = require("@langchain/langgraph/prebuilt");
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { z } = require("zod");
const axios = require("axios");

const {
  cancelAppointmentFromAssistant,
  cancelAppointmentByCompanyFromAssistant,
  createAppointmentFromAssistant,
  getCompanyContextByInstanceName,
  listAvailableSlots,
  listAppointmentsByDay,
} = require("./companyContextService");
const { authenticateCompanyUser } = require("../authCompany.service");
const { getSupportSessionDb, setSupportSessionDb } = require("../supportAuthSession.service");
const { buildAssistantPrompt } = require("./assistantPrompt");

const GEMINI_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";
const AI_ENABLED = (process.env.WHATSAPP_AI_ENABLED || "true") === "true";
const conversationMemory = new Map();
const MAX_CONVERSATION_MESSAGES = 24;
const SUPPORT_INSTANCE_NAME = String(process.env.SUPPORT_WHATSAPP_INSTANCE || "citax-support-whatsapp")
  .trim()
  .toLowerCase();
const SUPPORT_SESSION_TTL_MS = Number(process.env.SUPPORT_SESSION_TTL_HOURS || 24) * 60 * 60 * 1000;
const supportLoginSessions = new Map();
const supportLastCancelledByOperator = new Map();
const SUPPORT_NOTIFY_PHONE = String(
  process.env.SUPPORT_NOTIFY_PHONE || process.env.MATI_WHATSAPP_NUMBER || ""
).replace(/[^\d]/g, "");
const SUPPORT_NOTIFY_LABEL = String(
  process.env.SUPPORT_NOTIFY_LABEL || "el contacto responsable"
).trim();
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "http://localhost:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";
const LAST_CANCELLED_TTL_MS = 2 * 60 * 60 * 1000;

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

const buildRealtimeTemporalContext = (timezone = "America/Argentina/Buenos_Aires") => {
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

const setSupportSession = async ({ customerPhone, companyId, companyName, userEmail }) => {
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
          professionals: companyContext.professionals.map(p => ({
            id: p.id,
            name: p.name,
            services: p.services,
            // Solo proveemos metadata principal.
            // Para conocer la disponibilidad real, Gemini DEBE llamar a find_available_slots.
            requisito: "Para saber si este prestador atiende un día u horario, DEBES usar obligatoriamente la herramienta find_available_slots. NO asumas ningún horario comercial."
          })),
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

const createSupportTools = ({ customerPhone, supportState }) => {
  return [
    tool(
      async ({ email, password }) => {
        const authResult = await authenticateCompanyUser({ email, password });
        if (!authResult) {
          return JSON.stringify({ success: false, error: "Credenciales inválidas." });
        }
        await setSupportSession({
          customerPhone,
          companyId: authResult.companyId,
          companyName: authResult.user.nombre_comercial || `Empresa ${authResult.companyId}`,
          userEmail: authResult.user.email,
        });
        supportState.companyId = authResult.companyId;
        supportState.companyName = authResult.user.nombre_comercial || `Empresa ${authResult.companyId}`;
        return JSON.stringify({
          success: true,
          companyId: authResult.companyId,
          companyName: supportState.companyName,
        });
      },
      {
        name: "login_empresa",
        description: "Valida email y contraseña de empresa para asociar esta conversación.",
        schema: z.object({
          email: z.string().describe("Email de acceso de la empresa."),
          password: z.string().describe("Contraseña de acceso de la empresa."),
        }),
      }
    ),
    tool(
      async ({ professionalName, startDate, endDate, limit }) => {
        if (!supportState.companyId) {
          throw new Error("Primero ejecutá login_empresa.");
        }
        const slots = await listAvailableSlots({
          companyId: supportState.companyId,
          professionalName,
          startDate,
          endDate,
          referenceDate: new Date().toISOString().slice(0, 10),
          limit: limit || 30,
        });
        return JSON.stringify({ slots });
      },
      {
        name: "find_available_slots",
        description: "Busca horarios disponibles de la empresa autenticada.",
        schema: z.object({
          professionalName: z.string().optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
          limit: z.number().optional().default(30),
        }),
      }
    ),
    tool(
      async ({ clientName, professionalId, serviceId, date, time }) => {
        if (!supportState.companyId) {
          throw new Error("Primero ejecutá login_empresa.");
        }
        const appointment = await createAppointmentFromAssistant({
          companyId: supportState.companyId,
          professionalId,
          clientName,
          clientPhone: customerPhone,
          serviceId: serviceId || null,
          date,
          time,
          referenceDate: new Date().toISOString().slice(0, 10),
        });
        return JSON.stringify({ appointment });
      },
      {
        name: "create_appointment",
        description: "Crea un turno para la empresa autenticada.",
        schema: z.object({
          clientName: z.string(),
          professionalId: z.number(),
          serviceId: z.number().optional(),
          date: z.string(),
          time: z.string(),
        }),
      }
    ),
    tool(
      async ({ date }) => {
        if (!supportState.companyId) {
          throw new Error("Primero ejecutá login_empresa.");
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
        description: "Lista turnos del día de la empresa autenticada.",
        schema: z.object({ date: z.string().optional() }),
      }
    ),
    tool(
      async ({ date, time, professionalName, clientName }) => {
        if (!supportState.companyId) {
          throw new Error("Primero ejecutá login_empresa.");
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
          setLastCancelledContext({ operatorPhone: customerPhone, payload: cancelledPayload });
        }
        return JSON.stringify(result);
      },
      {
        name: "cancel_appointment",
        description: "Cancela un turno de la empresa autenticada.",
        schema: z.object({
          date: z.string().optional(),
          time: z.string().optional(),
          professionalName: z.string().optional(),
          clientName: z.string().optional(),
        }),
      }
    ),
    tool(
      async ({ date, time, professionalName, clientName, phone }) => {
        const last = supportState.lastCancelled || getLastCancelledContext(customerPhone) || {};
        const targetPhone = String(
          phone ||
          last.clientPhone ||
          SUPPORT_NOTIFY_PHONE ||
          ""
        ).replace(/[^\d]/g, "");

        if (!targetPhone) {
          return JSON.stringify({
            success: false,
            error: "No encontré un teléfono destino para avisar (cliente cancelado o SUPPORT_NOTIFY_PHONE).",
          });
        }
        const resolvedDate = date || last.date || "sin fecha";
        const resolvedTime = time || last.time || "";
        const resolvedProfessional = professionalName || last.professionalName || "";
        const resolvedClient = clientName || last.clientName || "";

        const text = `Aviso de cancelación: ${supportState.companyName || "Empresa"} canceló un turno (${resolvedDate} ${resolvedTime})${resolvedProfessional ? `, profesional: ${resolvedProfessional}` : ""}${resolvedClient ? `, cliente: ${resolvedClient}` : ""}.`;
        try {
          const response = await axios.post(
            `${EVOLUTION_API_URL}/message/sendText/${SUPPORT_INSTANCE_NAME}`,
            { number: targetPhone, text },
            {
              headers: {
                "Content-Type": "application/json",
                apikey: EVOLUTION_API_KEY,
              },
              timeout: 15000,
            }
          );
          console.log("✅ Aviso de cancelación enviado", {
            to: targetPhone,
            company: supportState.companyName || supportState.companyId,
          });
          return JSON.stringify({ success: true, targetPhone, response: response.data });
        } catch (error) {
          const details = error.response?.data || null;
          console.error("❌ Error enviando aviso de cancelación", {
            to: targetPhone,
            message: error.message,
            status: error.response?.status || null,
            details,
          });
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
        description: "Envía aviso al contacto de notificación cuando se confirma una cancelación.",
        schema: z.object({
          date: z.string().optional(),
          time: z.string().optional(),
          professionalName: z.string().optional(),
          clientName: z.string().optional(),
          phone: z.string().optional().describe("Teléfono destino opcional; si no se envía, usa el cliente cancelado."),
        }),
      }
    ),
  ];
};

// ─── Native Gemini tool declarations (required for gemini-3.1-flash-lite-preview) ───
const getGeminiToolDeclarations = () => {
  return [
    {
      functionDeclarations: [
        {
          name: "login_empresa",
          description: "Valida email y contraseña de empresa para asociar esta conversación.",
          parameters: {
            type: "object",
            properties: {
              email: {
                type: "string",
                description: "Email de acceso de la empresa.",
              },
              password: {
                type: "string",
                description: "Contraseña de acceso de la empresa.",
              },
            },
            required: ["email", "password"],
          },
        },
        {
          name: "get_company_context",
          description: "Devuelve el contexto del negocio: prestadores, servicios y datos.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: "find_available_slots",
          description: "Busca horarios disponibles para un prestador en un rango de fechas.",
          parameters: {
            type: "object",
            properties: {
              professionalName: {
                type: "string",
                description: "Nombre del prestador.",
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
                description: "Máximo de resultados (1-40).",
              },
            },
            required: [],
          },
        },
        {
          name: "create_appointment",
          description: "Crea un turno confirmado. Solo usar cuando el cliente ya confirmó.",
          parameters: {
            type: "object",
            properties: {
              clientName: {
                type: "string",
                description: "Nombre del cliente (mínimo 3 caracteres).",
              },
              professionalId: {
                type: "number",
                description: "ID del prestador.",
              },
              serviceId: {
                type: "number",
                description: "ID del servicio (si se omite se usa el primero disponible).",
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
        {
          name: "get_appointments_by_day",
          description: "Lista los turnos reservados para un día específico.",
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
        {
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
            },
            required: [],
          },
        },
        {
          name: "notify_cancellation_contact",
          description: "Envía aviso al contacto configurado sobre una cancelación confirmada.",
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
      ],
    },
  ];
};

const createGraph = (tools) => {
  const modelWithTools = createModel().bindTools(getGeminiToolDeclarations());
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
  const realtimeContext = buildRealtimeTemporalContext(companyContext.timezone);
  const systemPrompt = buildAssistantPrompt({
    ...companyContext,
    currentDate: realtimeContext.localDate,
    currentTime: realtimeContext.localTime,
  });

  const preferredName = resolvePreferredContactName(incomingMessage?.pushName);
  const temporalRef = `Referencia temporal obligatoria: fecha local actual ${realtimeContext.localDate}, hora local ${realtimeContext.localTime}, zona ${realtimeContext.timezone}, timestamp UTC ${realtimeContext.isoUtc}. Usá esta referencia como fuente de verdad para interpretar "hoy", "mañana" y fechas relativas.`;
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

const runSupportAssistant = async ({ incomingMessage }) => {
  if (!isAssistantConfigured()) {
    return { enabled: false, reason: "Asistente IA no configurado." };
  }

  const customerPhone =
    incomingMessage?.phoneNumber ||
    String(incomingMessage?.from || "").split("@")[0].split(":")[0].replace(/[^\d]/g, "").trim();
  const messageText = String(incomingMessage?.text || "").trim();
  if (!customerPhone || !messageText) {
    return { enabled: false, reason: "Mensaje sin contenido." };
  }

  const persistedSession = await getSupportSession(customerPhone);
  const supportState = {
    companyId: persistedSession?.companyId || null,
    companyName: persistedSession?.companyName || null,
  };

  const tools = createSupportTools({ customerPhone, supportState });
  const graph = createGraph(tools);
  const history = getConversationHistory({ instanceName: SUPPORT_INSTANCE_NAME, customerPhone });

  const realtimeContext = buildRealtimeTemporalContext("America/Argentina/Buenos_Aires");
  const supportPrompt = `Sos el bot de soporte de Citax por WhatsApp.
Si la conversación no tiene empresa autenticada, pedí email y contraseña de forma clara.
Cuando tengas email y contraseña, ejecutá la tool login_empresa.
No digas que el login fue exitoso sin ejecutar la tool.
Después del login, podés ayudar con: agendar turno, cancelar turno y ver agenda del día usando tools.
Cuando canceles un turno y la cancelación sea exitosa, preguntá explícitamente: "¿Querés que le avise al cliente?".
Si te responden que sí, ejecutá notify_cancellation_contact.
Primero intentá avisar al cliente del turno cancelado; si no hay teléfono de cliente, usá el contacto general (${SUPPORT_NOTIFY_LABEL}) si está configurado.
Nunca confirmes que se envió un aviso si la tool devuelve success=false.
Respondé en español, corto y claro, estilo WhatsApp.
Empresa autenticada actual: ${supportState.companyName || "ninguna"}.
Referencia temporal obligatoria: fecha local actual ${realtimeContext.localDate}, hora local ${realtimeContext.localTime}, zona ${realtimeContext.timezone}, timestamp UTC ${realtimeContext.isoUtc}.`;

  const result = await graph.invoke({
    messages: [
      new SystemMessage(supportPrompt),
      ...history,
      new HumanMessage(messageText),
    ],
  });

  const lastAI = [...result.messages].reverse().find((m) => isAIMessage(m) && !m.tool_calls?.length);
  const reply = lastAI
    ? typeof lastAI.content === "string"
      ? lastAI.content.trim()
      : Array.isArray(lastAI.content)
        ? lastAI.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n").trim()
        : ""
    : "";

  if (!reply) return { enabled: false, reason: "Sin respuesta generada." };

  if (supportState.companyId && supportState.companyName) {
    await setSupportSession({
      customerPhone,
      companyId: supportState.companyId,
      companyName: supportState.companyName,
      userEmail: persistedSession?.userEmail || "",
    });
  }

  setConversationHistory({ instanceName: SUPPORT_INSTANCE_NAME, customerPhone, messages: result.messages });
  return { enabled: true, text: reply };
};

module.exports = {
  isAssistantConfigured,
  runWhatsappAssistant,
  runSupportAssistant,
};
