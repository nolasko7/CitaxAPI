const prisma = require("../../config/prisma");
const {
  buildAvailabilityMap,
  isNullishAvailability,
  resolveEffectiveAvailability,
} = require("../../utils/availabilitySchedule");
const {
  getCompanyBotConfig,
  isSingleProviderModeEnabledForConfig,
  normalizeOwnPhrasesConfig,
} = require("../singleProviderMode.service");
const { getRuntimeTimeZone } = require("../../utils/runtimeTimezone");
const {
  DEFAULT_APPOINTMENT_DURATION_MINUTES,
  OCCUPYING_APPOINTMENT_STATUSES,
  addMinutes,
  isOccupyingAppointmentStatus,
  rangesOverlap,
} = require("../../utils/appointmentOccupancy");
const {
  findOverlappingAppointmentWithPrisma,
} = require("../appointmentConflict.service");
const {
  buildStoredAppointmentDate,
  buildUtcDayBoundsForTimezone,
  formatStoredDateKey,
  formatStoredTimeKey,
  toComparableAppointmentDate,
} = require("../../utils/appointmentDateInterop");

const DEFAULT_TIMEZONE = getRuntimeTimeZone();

const getCurrentDateInTimeZone = (timezone = DEFAULT_TIMEZONE) => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
};

const getCurrentDayNameInSpanish = (timezone = DEFAULT_TIMEZONE) => {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    weekday: "long",
  })
    .format(new Date())
    .toLowerCase();
};

const getCurrentTimeInTimeZone = (timezone = DEFAULT_TIMEZONE) => {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
};

const getNowInTimezone = (timezone = DEFAULT_TIMEZONE) => {
  if (!timezone || timezone === DEFAULT_TIMEZONE) {
    return new Date();
  }

  const parts = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .forEach((p) => {
      parts[p.type] = p.value;
    });
  return new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`,
  );
};

// Minutos mínimos de anticipación para poder reservar un turno
const MIN_BOOKING_LEAD_MINUTES = Number(
  process.env.MIN_BOOKING_LEAD_MINUTES || "20",
);

const isSlotStillBookable = ({
  slotStart,
  slotEnd,
  now = getNowInTimezone(),
}) => {
  if (!(slotEnd instanceof Date) || Number.isNaN(slotEnd.getTime()))
    return false;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  // El fin debe ser posterior a ahora (slot no pasado)
  if (slotEnd <= now) return false;
  // El inicio debe estar a al menos MIN_BOOKING_LEAD_MINUTES en el futuro
  const leadMs = MIN_BOOKING_LEAD_MINUTES * 60 * 1000;
  if (slotStart instanceof Date && slotStart.getTime() - now.getTime() < leadMs)
    return false;
  return true;
};

const pad = (v) => String(v).padStart(2, "0");
const formatTime = (v) => String(v || "").slice(0, 5);
const normalizePhone = (v) =>
  String(v || "")
    .replace(/@.*/, "")
    .replace(/[^\d]/g, "")
    .trim();
const normalizeClientName = (v) => String(v || "").trim();
const formatTimeInTz = (dt, timezone = DEFAULT_TIMEZONE) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(dt);
const formatStoredDate = (appointmentLike, timezone = DEFAULT_TIMEZONE) =>
  formatStoredDateKey({
    fecha_hora: appointmentLike?.fecha_hora,
    origen: appointmentLike?.origen,
    timezone,
  });
const formatStoredTime = (appointmentLike, timezone = DEFAULT_TIMEZONE) =>
  formatStoredTimeKey({
    fecha_hora: appointmentLike?.fecha_hora,
    origen: appointmentLike?.origen,
    timezone,
  });

const normalizeDate = (value, referenceDate = new Date()) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value.toISOString().slice(0, 10);
  const raw = String(value).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const getRef = () =>
    typeof referenceDate === "string"
      ? new Date(`${referenceDate}T12:00:00`)
      : new Date(referenceDate);

  if (lower === "hoy") return normalizeDate(getRef());
  if (lower === "maÃ±ana" || lower === "manana") {
    const d = getRef();
    d.setDate(d.getDate() + 1);
    return normalizeDate(d);
  }
  if (lower === "pasado maÃ±ana" || lower === "pasado manana") {
    const d = getRef();
    d.setDate(d.getDate() + 2);
    return normalizeDate(d);
  }

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const addDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const toWeekdayNumber = (dateStr) => {
  const d = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};
const combineDateTime = (dateStr, timeStr) =>
  buildStoredAppointmentDate({
    date: dateStr,
    time: timeStr,
    timezone: DEFAULT_TIMEZONE,
  });

// ─── Cache de contexto estático por empresa (TTL 5 min) ──────────────────────
const STATIC_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutos
const staticContextCache = new Map();

const getStaticCompanyContext = async (instanceName) => {
  const cached = staticContextCache.get(instanceName);
  if (cached && Date.now() - cached.timestamp < STATIC_CONTEXT_TTL_MS) {
    return cached.data;
  }

  const config = await prisma.cONFIG_WHATSAPP.findFirst({
    where: { instance_name: instanceName },
    include: {
      EMPRESA: {
        include: {
          PRESTADOR: {
            where: { activo: true },
            include: {
              USUARIO: true,
              SERVICIOS: { include: { SERVICIO: true } },
            },
          },
          SERVICIO: true,
        },
      },
    },
  });

  if (!config || !config.EMPRESA) return null;

  const empresa = config.EMPRESA;
  const horarios = empresa.horarios_disponibilidad || {};

  const professionals = empresa.PRESTADOR.map((p) => ({
    id: p.id_prestador,
    name: `${p.USUARIO.nombre} ${p.USUARIO.apellido}`,
    services: p.SERVICIOS.map((ps) => ({
      id: ps.SERVICIO.id_servicio,
      name: ps.SERVICIO.nombre,
      duration: ps.SERVICIO.duracion_minutos,
      price: Number(ps.SERVICIO.precio),
    })),
    horarios_disponibilidad: p.horarios_disponibilidad || null,
    availability: resolveEffectiveAvailability({
      ownConfig: p.horarios_disponibilidad,
      companyConfig: empresa.horarios_disponibilidad,
    }),
    usesFallbackAvailability: isNullishAvailability(p.horarios_disponibilidad),
  }));

  const services = empresa.SERVICIO.map((s) => ({
    id: s.id_servicio,
    name: s.nombre,
    description: s.descripcion,
    duration: s.duracion_minutos,
    price: Number(s.precio),
  }));

  const botConfig = await getCompanyBotConfig(empresa.id_empresa).catch(
    () => ({}),
  );
  const singleProviderMode = isSingleProviderModeEnabledForConfig(botConfig);

  const primerPersonaActiva =
    professionals.length === 1 &&
    (singleProviderMode || botConfig.primera_persona === true);
  const personaName = primerPersonaActiva
    ? professionals[0].name
    : professionals[0]?.name || empresa.nombre_comercial;

  const data = {
    companyId: empresa.id_empresa,
    companyName: empresa.nombre_comercial,
    companySlug: empresa.slug,
    companyAddress: String(empresa.direccion || "").trim(),
    instanceName,
    whatsappNumber: config.whatsapp_number,
    professionals,
    services,
    horarios,
    assistantPersonaName: personaName,
    welcomeMessage: String(botConfig?.mensaje_bienvenida || "").trim(),
    ownPhrases: normalizeOwnPhrasesConfig(botConfig?.palabras_propias),
    singleProviderMode,
    primerPersonaActiva,
  };

  staticContextCache.set(instanceName, { data, timestamp: Date.now() });
  return data;
};

// ─── Get company context by instance name ─────────────────────────────────────
const getCompanyContextByInstanceName = async (
  instanceName,
  customerPhone = null,
) => {
  const staticContext = await getStaticCompanyContext(instanceName);
  if (!staticContext) return null;

  let customerPendingAppointments = [];
  if (customerPhone) {
    const normalizedPhone = normalizePhone(customerPhone);
    const client = await prisma.cLIENTE.findFirst({
      where: {
        id_empresa: staticContext.companyId,
        whatsapp_id: { contains: normalizedPhone.slice(-8) },
      },
    });

    if (client) {
      const todayStr = getCurrentDateInTimeZone();
      const now = new Date();
      const { dayStart: todayStart } = buildUtcDayBoundsForTimezone(
        todayStr,
        DEFAULT_TIMEZONE,
      );
      const confirmedAppointments = await prisma.tURNO.findMany({
        where: {
          id_cliente: client.id_cliente,
          estado: "confirmado",
          fecha_hora: { gte: todayStart },
        },
        include: {
          SERVICIO: true,
          PRESTADOR: { include: { USUARIO: true } },
        },
        orderBy: { fecha_hora: "asc" },
      });

      const pending = [];
      const todayPast = [];

      confirmedAppointments.forEach((appointment) => {
        const comparableDate = toComparableAppointmentDate(appointment);
        if (!(comparableDate instanceof Date) || Number.isNaN(comparableDate.getTime())) {
          return;
        }

        if (comparableDate >= now) {
          pending.push(appointment);
          return;
        }

        if (
          formatStoredDate(appointment) === todayStr &&
          comparableDate >= todayStart
        ) {
          todayPast.push(appointment);
        }
      });

      const mapTurno = (t, alreadyPassed) => ({
        id: t.id_turno,
        date: formatStoredDate(t),
        time: formatStoredTime(t),
        service: t.SERVICIO.nombre,
        professional: `${t.PRESTADOR.USUARIO.nombre} ${t.PRESTADOR.USUARIO.apellido}`,
        alreadyPassed,
      });

      customerPendingAppointments = [
        ...pending.map((t) => mapTurno(t, false)),
        ...todayPast.map((t) => mapTurno(t, true)),
      ];
    }
  }

  return {
    ...staticContext,
    timezone: DEFAULT_TIMEZONE,
    currentDate: getCurrentDateInTimeZone(),
    currentDayName: getCurrentDayNameInSpanish(),
    currentTime: getCurrentTimeInTimeZone(),
    customerPendingAppointments,
  };
};

// ─── Cache companyId → instanceName (mismo TTL que el contexto estático) ──────
const companyIdToInstanceCache = new Map();

const getCompanyContextByCompanyId = async (
  companyId,
  customerPhone = null,
) => {
  const numId = Number(companyId);
  const cached = companyIdToInstanceCache.get(numId);

  if (cached && Date.now() - cached.ts < STATIC_CONTEXT_TTL_MS) {
    return getCompanyContextByInstanceName(cached.instanceName, customerPhone);
  }

  const config = await prisma.cONFIG_WHATSAPP.findFirst({
    where: { id_empresa: numId },
  });

  if (!config?.instance_name) return null;

  companyIdToInstanceCache.set(numId, { instanceName: config.instance_name, ts: Date.now() });
  return getCompanyContextByInstanceName(config.instance_name, customerPhone);
};

// â”€â”€â”€ List available slots â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const listAvailableSlots = async ({
  companyId,
  professionalId = null,
  professionalName,
  serviceId = null,
  startDate,
  endDate,
  referenceDate,
  includeOccupied = false,
  limit = 30,
}) => {
  const normalizedStart =
    normalizeDate(startDate, referenceDate) ||
    normalizeDate(referenceDate) ||
    getCurrentDateInTimeZone();
  const normalizedEnd =
    normalizeDate(endDate, referenceDate) || addDays(normalizedStart, 7);

  const empresa = await prisma.eMPRESA.findUnique({
    where: { id_empresa: companyId },
    include: {
      PRESTADOR: {
        where: { activo: true },
        include: {
          USUARIO: true,
          SERVICIOS: { include: { SERVICIO: true } },
        },
      },
    },
  });

  if (!empresa) return [];

  const companyConfig = empresa.horarios_disponibilidad;

  let prestadores = empresa.PRESTADOR;
  if (professionalId) {
    prestadores = prestadores.filter(
      (p) => Number(p.id_prestador) === Number(professionalId),
    );
  }

  if (professionalName) {
    const normalizedSearch = professionalName
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    prestadores = prestadores.filter((p) => {
      const fullName = `${p.USUARIO.nombre} ${p.USUARIO.apellido}`
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      return fullName.includes(normalizedSearch);
    });
  }

  if (serviceId) {
    prestadores = prestadores.filter((p) =>
      p.SERVICIOS.some(
        (ps) => Number(ps.SERVICIO.id_servicio) === Number(serviceId),
      ),
    );
  }

  if (!prestadores.length) return [];

  // Fetch blocked dates for the range
  const blockedDates = await prisma.bLOCKED_DATES.findMany({
    where: {
      id_empresa: companyId,
      fecha: {
        gte: new Date(`${normalizedStart}T00:00:00`),
        lte: new Date(`${normalizedEnd}T23:59:59`),
      },
    },
  });

  const { dayStart: rangeStart, dayEnd: rangeEnd } =
    buildUtcDayBoundsForTimezone(
      normalizedStart,
      DEFAULT_TIMEZONE,
      normalizedEnd,
    );

  const existingTurnos = await prisma.tURNO.findMany({
    where: {
      id_prestador: { in: prestadores.map((p) => p.id_prestador) },
      estado: { in: OCCUPYING_APPOINTMENT_STATUSES },
      fecha_hora: {
        gte: rangeStart,
        lte: rangeEnd,
      },
    },
    include: { SERVICIO: true },
  });

  const slots = [];
  const prestadoresConAgenda = prestadores.map((prestador) => {
    const availability = resolveEffectiveAvailability({
      ownConfig: prestador.horarios_disponibilidad,
      companyConfig,
    });

    return {
      ...prestador,
      availability,
      availabilityMap: buildAvailabilityMap(availability.config),
    };
  });

  for (
    let cursor = normalizedStart;
    cursor <= normalizedEnd;
    cursor = addDays(cursor, 1)
  ) {
    const weekday = toWeekdayNumber(cursor);

    // Skip if the entire date is blocked for the company
    const isDateBlockedForCompany = blockedDates.some(
      (bd) =>
        bd.id_prestador === null &&
        bd.fecha.toISOString().slice(0, 10) === cursor,
    );
    if (isDateBlockedForCompany) continue;

    for (const prestador of prestadoresConAgenda) {
      // Skip if the date is blocked for this specific professional
      const isDateBlockedForProfessional = blockedDates.some(
        (bd) =>
          bd.id_prestador === prestador.id_prestador &&
          bd.fecha.toISOString().slice(0, 10) === cursor,
      );
      if (isDateBlockedForProfessional) continue;

      const selectedService = serviceId
        ? prestador.SERVICIOS.find(
            (ps) => Number(ps.SERVICIO.id_servicio) === Number(serviceId),
          )?.SERVICIO
        : prestador.SERVICIOS[0]?.SERVICIO;
      const duration =
        selectedService?.duracion_minutos ||
        DEFAULT_APPOINTMENT_DURATION_MINUTES;
      const daySchedules = prestador.availabilityMap[weekday];
      if (!daySchedules || !daySchedules.length) continue;

      for (const daySchedule of daySchedules) {
        let slotStart = combineDateTime(cursor, daySchedule.start);
        const dayEnd = combineDateTime(cursor, daySchedule.end);

        while (slotStart < dayEnd) {
          const slotEnd = new Date(slotStart.getTime() + duration * 60000);

          if (slotEnd > dayEnd) break;

          const isBusy = existingTurnos.some((t) => {
            if (t.id_prestador !== prestador.id_prestador) return false;
            const tStart = toComparableAppointmentDate(t);
            const tEnd = addMinutes(
              tStart,
              t.SERVICIO?.duracion_minutos ||
                DEFAULT_APPOINTMENT_DURATION_MINUTES,
            );
            return rangesOverlap(slotStart, slotEnd, tStart, tEnd);
          });

          if ((!isBusy || includeOccupied) && isSlotStillBookable({ slotStart, slotEnd })) {
            slots.push({
              professionalId: prestador.id_prestador,
              professionalName: `${prestador.USUARIO.nombre} ${prestador.USUARIO.apellido}`,
              date: cursor,
              time: formatTimeInTz(slotStart),
              endTime: formatTimeInTz(slotEnd),
              duration,
              isBusy,
              scheduleSource: prestador.availability.source,
            });
          }

          slotStart = new Date(slotStart.getTime() + duration * 60000);
          if (slots.length >= limit) return slots;
        }
      }
    }
  }

  return slots;
};

// ─── Find or create client ────────────────────────────────────────────────────
const findOrCreateClient = async ({ companyId, clientName, clientPhone }) => {
  const normalizedPhone = normalizePhone(clientPhone);
  const normalizedName = normalizeClientName(clientName);

  if (!normalizedPhone) {
    if (!normalizedName) {
      throw new Error("Falta el nombre del cliente para crear el turno.");
    }

    const existingByName = await prisma.cLIENTE.findFirst({
      where: {
        id_empresa: companyId,
        nombre_wa: normalizedName,
      },
      orderBy: { id_cliente: "asc" },
    });

    if (existingByName) return existingByName;

    return await prisma.cLIENTE.create({
      data: {
        id_empresa: companyId,
        whatsapp_id: `manual-${companyId}-${Date.now()}`,
        nombre_wa: normalizedName,
      },
    });
  }

  const existing = await prisma.cLIENTE.findFirst({
    where: {
      id_empresa: companyId,
      whatsapp_id: { contains: normalizedPhone.slice(-8) },
      NOT: { whatsapp_id: { startsWith: "manual-" } },
    },
  });

  if (existing) {
    // Solo actualizar el nombre si el cliente NO tiene nombre aún.
    // NUNCA sobreescribir un nombre existente, ya que eso corrompe
    // el nombre en todos los turnos previos vinculados a ese cliente.
    const currentName = String(existing.nombre_wa || "").trim();
    if (!currentName && normalizedName) {
      return prisma.cLIENTE.update({
        where: { id_cliente: existing.id_cliente },
        data: { nombre_wa: normalizedName },
      });
    }
    return existing;
  }

  return await prisma.cLIENTE.create({
    data: {
      id_empresa: companyId,
      whatsapp_id: normalizedPhone,
      nombre_wa: normalizedName || "Cliente WhatsApp",
    },
  });
};

// â”€â”€â”€ Create appointment from assistant â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const createAppointmentFromAssistant = async ({
  companyId,
  professionalId,
  clientName,
  clientPhone,
  serviceId,
  date,
  time,
  referenceDate,
}) => {
  const normalizedDate = normalizeDate(date, referenceDate);
  const normalizedTime = formatTime(time);

  if (!normalizedDate || !normalizedTime)
    throw new Error("Fecha u hora invalidas");

  const prestador = await prisma.pRESTADOR.findUnique({
    where: { id_prestador: professionalId },
    include: { USUARIO: true },
  });
  if (!prestador) throw new Error("Prestador no encontrado");

  let resolvedServiceId = serviceId;
  if (!resolvedServiceId) {
    const defaultService = await prisma.pRESTADOR_SERVICIO.findFirst({
      where: { id_prestador: professionalId },
    });
    if (defaultService) resolvedServiceId = defaultService.id_servicio;
    else {
      const anyService = await prisma.sERVICIO.findFirst({
        where: { id_empresa: companyId },
      });
      if (anyService) resolvedServiceId = anyService.id_servicio;
      else throw new Error("No hay servicios configurados");
    }
  }

  // VALIDACION ESTRICTA: El horario DEBE existir en la disponibilidad teorica calculada por el sistema.
  const validSlotsInfo = await listAvailableSlots({
    companyId,
    professionalId,
    serviceId: resolvedServiceId,
    startDate: normalizedDate,
    endDate: normalizedDate,
    referenceDate,
    limit: 150,
  });

  const slotIsValid = validSlotsInfo.some(
    (s) =>
      Number(s.professionalId) === Number(professionalId) &&
      s.date === normalizedDate &&
      s.time === normalizedTime,
  );

  if (!slotIsValid) {
    throw new Error(
      `El horario solicitado (${normalizedDate} a las ${normalizedTime}) NO forma parte de la jornada laboral o ya caduco. Usa la herramienta find_available_slots para ver que horarios si estan disponibles y ofrecerlos.`,
    );
  }

  const servicio = await prisma.sERVICIO.findUnique({
    where: { id_servicio: resolvedServiceId },
  });
  if (!servicio) throw new Error("Servicio no encontrado");

  const duration =
    servicio.duracion_minutos || DEFAULT_APPOINTMENT_DURATION_MINUTES;
  const fechaHora = buildStoredAppointmentDate({
    date: normalizedDate,
    time: normalizedTime,
    timezone: DEFAULT_TIMEZONE,
  });

  // Validar anticipación mínima (MIN_BOOKING_LEAD_MINUTES, default 20 min)
  const nowForValidation = getNowInTimezone();
  const leadMs = MIN_BOOKING_LEAD_MINUTES * 60 * 1000;
  if (fechaHora.getTime() - nowForValidation.getTime() < leadMs) {
    throw new Error(
      `No se puede reservar el turno de las ${normalizedTime} porque falta menos de ${MIN_BOOKING_LEAD_MINUTES} minutos. Usa find_available_slots para ofrecer horarios disponibles con la anticipación suficiente.`,
    );
  }

  const endTime = addMinutes(fechaHora, duration);
  const existing = await findOverlappingAppointmentWithPrisma({
    prismaClient: prisma,
    companyId,
    professionalId,
    start: fechaHora,
    end: endTime,
  });

  if (existing)
    throw new Error("Ese horario ya no estÃ¡ disponible. ProbÃ¡ con otro.");

  const client = await findOrCreateClient({
    companyId,
    clientName,
    clientPhone,
  });

  const turno = await prisma.tURNO.create({
    data: {
      id_cliente: client.id_cliente,
      id_prestador: professionalId,
      id_servicio: resolvedServiceId,
      fecha_hora: fechaHora,
      estado: "confirmado",
      origen: "whatsapp",
    },
  });

  await prisma.tURNO.updateMany({
    where: {
      id_prestador: professionalId,
      estado: { in: ["pendiente", "pendiente_confirmacion"] },
      fecha_hora: {
        gte: fechaHora,
        lt: endTime,
      },
      NOT: {
        id_turno: turno.id_turno,
      },
    },
    data: {
      estado: "cancelado",
    },
  });

  return {
    appointmentId: turno.id_turno,
    professionalName: `${prestador.USUARIO.nombre} ${prestador.USUARIO.apellido}`,
    serviceName: servicio.nombre,
    clientName: client.nombre_wa || clientName,
    date: normalizedDate,
    time: normalizedTime,
    endTime: formatTimeInTz(endTime),
    companyId,
    professionalId,
    serviceId: resolvedServiceId,
  };
};

// â”€â”€â”€ Cancel appointment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const cancelAppointmentFromAssistant = async ({
  companyId,
  clientPhone,
  date,
  time,
  referenceDate,
}) => {
  const normalizedPhone = normalizePhone(clientPhone);
  const normalizedDate = date ? normalizeDate(date, referenceDate) : null;
  const normalizedTime = time ? formatTime(time) : null;

  const client = await prisma.cLIENTE.findFirst({
    where: {
      id_empresa: companyId,
      whatsapp_id: { contains: normalizedPhone.slice(-8) },
    },
  });

  if (!client) throw new Error("No encontrÃ© tu registro de cliente.");

  const { dayStart: cancelTodayStart } = buildUtcDayBoundsForTimezone(
    getCurrentDateInTimeZone(),
    DEFAULT_TIMEZONE,
  );

  const where = {
    id_cliente: client.id_cliente,
    estado: { in: ["pendiente", "confirmado"] },
    fecha_hora: { gte: cancelTodayStart },
  };

  const appointments = await prisma.tURNO.findMany({
    where,
    orderBy: { fecha_hora: "asc" },
  });

  const now = new Date();
  let filtered = appointments.filter((appointment) => {
    const comparableDate = toComparableAppointmentDate(appointment);
    return comparableDate instanceof Date && comparableDate >= now;
  });
  if (normalizedDate) {
    filtered = filtered.filter(
      (a) => formatStoredDate(a) === normalizedDate,
    );
  }

  if (normalizedTime) {
    filtered = filtered.filter((a) => {
      const t = formatStoredTime(a);
      return t === normalizedTime;
    });
  }

  if (!filtered.length)
    throw new Error("No encontrÃ© ningÃºn turno pendiente para cancelar.");

  if (filtered.length > 1 && (!normalizedDate || !normalizedTime)) {
    return {
      status: "multiple_found",
      appointments: filtered.map((a) => ({
        id: a.id_turno,
        date: formatStoredDate(a),
        time: formatStoredTime(a),
      })),
    };
  }

  const appointment = filtered[0];
  await prisma.tURNO.update({
    where: { id_turno: appointment.id_turno },
    data: { estado: "cancelado" },
  });

  return {
    status: "cancelled",
    appointmentId: appointment.id_turno,
    date: formatStoredDate(appointment),
    time: formatStoredTime(appointment),
  };
};

// â”€â”€â”€ List appointments by day â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const listAppointmentsByDay = async ({ companyId, date, referenceDate }) => {
  const normalizedDate =
    normalizeDate(date, referenceDate) || normalizeDate(referenceDate);
  if (!normalizedDate) return [];

  const { dayStart, dayEnd } = buildUtcDayBoundsForTimezone(
    normalizedDate,
    DEFAULT_TIMEZONE,
  );

  const turnos = await prisma.tURNO.findMany({
    where: {
      estado: { in: ["pendiente", "confirmado"] },
      fecha_hora: { gte: dayStart, lte: dayEnd },
      PRESTADOR: { id_empresa: companyId },
    },
    include: {
      SERVICIO: true,
      PRESTADOR: { include: { USUARIO: true } },
      CLIENTE: true,
    },
    orderBy: { fecha_hora: "asc" },
  });

  return turnos.map((t) => ({
    appointmentId: t.id_turno,
    date: formatStoredDate(t),
    time: formatStoredTime(t),
    status: t.estado,
    serviceName: t.SERVICIO?.nombre || "Turno",
    professionalName: `${t.PRESTADOR.USUARIO.nombre} ${t.PRESTADOR.USUARIO.apellido}`,
    clientName: t.CLIENTE?.nombre_wa || "Sin nombre",
  }));
};

// â”€â”€â”€ Cancel appointment by company slot (support bot) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const cancelAppointmentByCompanyFromAssistant = async ({
  companyId,
  date,
  time,
  referenceDate,
  professionalName,
  clientName,
}) => {
  const normalizedDate = date ? normalizeDate(date, referenceDate) : null;
  const normalizedTime = time ? formatTime(time) : null;

  const where = {
    estado: { in: ["pendiente", "confirmado"] },
    PRESTADOR: { id_empresa: companyId },
  };

  if (normalizedDate) {
    const { dayStart, dayEnd } = buildUtcDayBoundsForTimezone(
      normalizedDate,
      DEFAULT_TIMEZONE,
    );
    where.fecha_hora = {
      gte: dayStart,
      lte: dayEnd,
    };
  } else {
    const { dayStart: cancelTodayStartFallback } = buildUtcDayBoundsForTimezone(
      getCurrentDateInTimeZone(),
      DEFAULT_TIMEZONE,
    );
    where.fecha_hora = { gte: cancelTodayStartFallback };
  }

  const appointments = await prisma.tURNO.findMany({
    where,
    include: {
      SERVICIO: true,
      PRESTADOR: { include: { USUARIO: true } },
      CLIENTE: true,
    },
    orderBy: { fecha_hora: "asc" },
  });

  let filtered = appointments;
  if (!normalizedDate) {
    const now = new Date();
    filtered = filtered.filter((appointment) => {
      const comparableDate = toComparableAppointmentDate(appointment);
      return comparableDate instanceof Date && comparableDate >= now;
    });
  }
  if (normalizedTime) {
    filtered = filtered.filter((a) => {
      const t = formatStoredTime(a);
      return t === normalizedTime;
    });
  }

  if (professionalName) {
    const needle = String(professionalName)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    filtered = filtered.filter((a) => {
      const fullName =
        `${a.PRESTADOR?.USUARIO?.nombre || ""} ${a.PRESTADOR?.USUARIO?.apellido || ""}`
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");
      return fullName.includes(needle);
    });
  }

  if (clientName) {
    const needle = String(clientName)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    filtered = filtered.filter((a) => {
      const fullName = String(a.CLIENTE?.nombre_wa || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      return fullName.includes(needle);
    });
  }

  if (!filtered.length) {
    throw new Error(
      "No encontrÃ© ningÃºn turno activo con esos datos para cancelar.",
    );
  }

  if (filtered.length > 1 && (!normalizedDate || !normalizedTime)) {
    return {
      status: "multiple_found",
      appointments: filtered.slice(0, 8).map((a) => ({
        id: a.id_turno,
        date: formatStoredDate(a),
        time: formatStoredTime(a),
        professional:
          `${a.PRESTADOR?.USUARIO?.nombre || ""} ${a.PRESTADOR?.USUARIO?.apellido || ""}`.trim(),
        client: a.CLIENTE?.nombre_wa || "Sin nombre",
      })),
    };
  }

  const appointment = filtered[0];
  await prisma.tURNO.update({
    where: { id_turno: appointment.id_turno },
    data: { estado: "cancelado" },
  });

  return {
    status: "cancelled",
    appointmentId: appointment.id_turno,
    date: formatStoredDate(appointment),
    time: formatStoredTime(appointment),
    professional:
      `${appointment.PRESTADOR?.USUARIO?.nombre || ""} ${appointment.PRESTADOR?.USUARIO?.apellido || ""}`.trim(),
    client: appointment.CLIENTE?.nombre_wa || "Sin nombre",
    clientPhone: normalizePhone(appointment.CLIENTE?.whatsapp_id || ""),
    service: appointment.SERVICIO?.nombre || "Turno",
    askNotifyMati: true,
  };
};

module.exports = {
  cancelAppointmentFromAssistant,
  cancelAppointmentByCompanyFromAssistant,
  createAppointmentFromAssistant,
  getCompanyContextByCompanyId,
  getCompanyContextByInstanceName,
  isOccupyingAppointmentStatus,
  isSlotStillBookable,
  listAvailableSlots,
  listAppointmentsByDay,
  normalizeDate,
};
