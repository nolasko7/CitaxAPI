const pool = require("../config/db");
const logger = require("../utils/logger");
const { getRuntimeTimeZone } = require("../utils/runtimeTimezone");
const {
  buildStoredAppointmentDate,
  buildStoredAppointmentDateTime,
} = require("../utils/appointmentDateInterop");
const {
  addMinutes,
  DEFAULT_APPOINTMENT_DURATION_MINUTES,
} = require("../utils/appointmentOccupancy");
const {
  findOverlappingAppointmentWithSql,
} = require("./appointmentConflict.service");
const { hasTurnoOrigenColumn } = require("./turnoSchema.service");

const APP_TIMEZONE = getRuntimeTimeZone();
const HORIZON_DAYS = 28; // 4 weeks ahead
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let intervalHandle = null;

const DAY_NAMES = ["Domingo", "Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado"];

/**
 * Pad a number to 2 digits.
 */
const pad = (n) => String(n).padStart(2, "0");

/**
 * Build a "YYYY-MM-DD" string from a Date (local calendar date).
 */
const toDateStr = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Get the JS day-of-week (0=Sunday) from a Date.
 */
const getDayOfWeek = (d) => d.getDay();

/**
 * Calculate the number of weeks between two dates (start of week aligned).
 * Both dates should be the same day-of-week for this to be meaningful.
 */
const weeksBetween = (start, current) => {
  const diffMs = current.getTime() - start.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7);
};

/**
 * Generate all future TURNO instances for a single TURNO_FIJO rule.
 */
const generateForRule = async (rule, connection, includeOrigin) => {
  const {
    id_turno_fijo,
    id_empresa,
    id_cliente,
    id_prestador,
    id_servicio,
    dia_semana,
    hora,
    frecuencia_semanas,
    fecha_inicio,
    fecha_fin,
    ultima_generacion,
  } = rule;

  // Determine start date for generation
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const fechaInicioDate = new Date(fecha_inicio);
  fechaInicioDate.setHours(0, 0, 0, 0);

  // Start from the later of: fecha_inicio, or today (no past generation)
  let searchFrom = fechaInicioDate > today ? fechaInicioDate : new Date(today);

  // If we already generated up to a date, start from the next day
  if (ultima_generacion) {
    const lastGen = new Date(ultima_generacion);
    lastGen.setHours(0, 0, 0, 0);
    const nextDay = new Date(lastGen);
    nextDay.setDate(nextDay.getDate() + 1);
    if (nextDay > searchFrom) {
      searchFrom = nextDay;
    }
  }

  // Calculate horizon date
  const horizonDate = new Date(today);
  horizonDate.setDate(horizonDate.getDate() + HORIZON_DAYS);

  // If fecha_fin is set, cap the horizon
  let effectiveHorizon = horizonDate;
  if (fecha_fin) {
    const fechaFinDate = new Date(fecha_fin);
    fechaFinDate.setHours(0, 0, 0, 0);
    if (fechaFinDate < effectiveHorizon) {
      effectiveHorizon = fechaFinDate;
    }
  }

  if (searchFrom > effectiveHorizon) return 0;

  // Get service duration
  const [serviceRows] = await connection.execute(
    "SELECT duracion_minutos FROM SERVICIO WHERE id_servicio = ? LIMIT 1",
    [id_servicio]
  );
  const durationMinutes =
    serviceRows[0]?.duracion_minutos || DEFAULT_APPOINTMENT_DURATION_MINUTES;

  // Get the client name for the "(Fijo)" prefix
  const [clientRows] = await connection.execute(
    "SELECT nombre_wa FROM CLIENTE WHERE id_cliente = ? LIMIT 1",
    [id_cliente]
  );
  const clientName = clientRows[0]?.nombre_wa || "Cliente";

  let generated = 0;
  let lastGenDate = null;

  // Iterate day by day from searchFrom to effectiveHorizon
  const cursor = new Date(searchFrom);
  while (cursor <= effectiveHorizon) {
    if (getDayOfWeek(cursor) === dia_semana) {
      // Check frequency: weeks since fecha_inicio must be divisible by frecuencia_semanas
      const weeks = weeksBetween(fechaInicioDate, cursor);
      if (weeks >= 0 && weeks % frecuencia_semanas === 0) {
        const dateStr = toDateStr(cursor);

        // Check if an instance already exists for this rule+date
        const [existing] = await connection.execute(
          `SELECT 1 FROM TURNO WHERE id_turno_fijo = ? AND DATE(fecha_hora) = ? LIMIT 1`,
          [id_turno_fijo, dateStr]
        );

        if (existing.length === 0) {
          // Check blocked dates
          const [blockedRows] = await connection.execute(
            "SELECT 1 FROM BLOCKED_DATES WHERE id_empresa = ? AND fecha = ? AND (id_prestador = ? OR id_prestador IS NULL) LIMIT 1",
            [id_empresa, dateStr, id_prestador]
          );

          if (blockedRows.length === 0) {
            // Check for time conflicts
            const requestedStart = buildStoredAppointmentDate({
              date: dateStr,
              time: hora,
              timezone: APP_TIMEZONE,
            });
            const requestedEnd = addMinutes(requestedStart, durationMinutes);
            const fullDate = buildStoredAppointmentDateTime({
              date: dateStr,
              time: hora,
              timezone: APP_TIMEZONE,
            });

            const conflict = await findOverlappingAppointmentWithSql({
              executor: connection,
              companyId: id_empresa,
              professionalId: id_prestador,
              start: requestedStart,
              end: requestedEnd,
            });

            // Determine estado based on conflict
            const estado = conflict ? "conflicto" : "confirmado";

            // Build the display name with (Fijo) prefix
            // We need a dedicated client record for the fixed appointment display
            // We'll use the real client but set the name in TURNO tracking only
            const turnoQuery = includeOrigin
              ? "INSERT INTO TURNO (id_cliente, id_prestador, id_servicio, fecha_hora, estado, origen, id_turno_fijo) VALUES (?, ?, ?, ?, ?, ?, ?)"
              : "INSERT INTO TURNO (id_cliente, id_prestador, id_servicio, fecha_hora, estado, id_turno_fijo) VALUES (?, ?, ?, ?, ?, ?)";
            const turnoParams = includeOrigin
              ? [id_cliente, id_prestador, id_servicio, fullDate, estado, "fijo", id_turno_fijo]
              : [id_cliente, id_prestador, id_servicio, fullDate, estado, id_turno_fijo];

            await connection.execute(turnoQuery, turnoParams);
            generated++;
          }
        }

        lastGenDate = new Date(cursor);
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  // Update ultima_generacion
  if (lastGenDate) {
    await connection.execute(
      "UPDATE TURNO_FIJO SET ultima_generacion = ? WHERE id_turno_fijo = ?",
      [toDateStr(lastGenDate), id_turno_fijo]
    );
  }

  return generated;
};

/**
 * Generate fixed appointments for all active rules across all companies.
 */
const generateAllFixedAppointments = async () => {
  const connection = await pool.getConnection();
  try {
    const includeOrigin = await hasTurnoOrigenColumn(connection);

    const [rules] = await connection.execute(
      `SELECT tf.*, c.nombre_wa AS cliente_nombre
       FROM TURNO_FIJO tf
       JOIN CLIENTE c ON c.id_cliente = tf.id_cliente
       WHERE tf.activo = 1
         AND (tf.fecha_fin IS NULL OR tf.fecha_fin >= CURDATE())`
    );

    let totalGenerated = 0;

    for (const rule of rules) {
      try {
        const count = await generateForRule(rule, connection, includeOrigin);
        if (count > 0) {
          logger.info(
            { id_turno_fijo: rule.id_turno_fijo, count, empresa: rule.id_empresa },
            `Turnos fijos generados | regla=${rule.id_turno_fijo} cantidad=${count}`
          );
        }
        totalGenerated += count;
      } catch (err) {
        logger.error(
          { err, id_turno_fijo: rule.id_turno_fijo },
          "Error generando turnos para regla fija"
        );
      }
    }

    if (totalGenerated > 0) {
      logger.info(`[CRON] Total turnos fijos generados: ${totalGenerated}`);
    }

    return totalGenerated;
  } finally {
    connection.release();
  }
};

/**
 * Generate fixed appointments for a specific rule (used after creating/editing a rule).
 */
const generateForSingleRule = async (ruleId) => {
  const connection = await pool.getConnection();
  try {
    const includeOrigin = await hasTurnoOrigenColumn(connection);

    const [rules] = await connection.execute(
      `SELECT tf.*, c.nombre_wa AS cliente_nombre
       FROM TURNO_FIJO tf
       JOIN CLIENTE c ON c.id_cliente = tf.id_cliente
       WHERE tf.id_turno_fijo = ? AND tf.activo = 1`,
      [ruleId]
    );

    if (rules.length === 0) return 0;

    return await generateForRule(rules[0], connection, includeOrigin);
  } finally {
    connection.release();
  }
};

/**
 * Start the daily cron-like scheduler.
 */
function start() {
  if (intervalHandle) return;

  // Calculate ms until next midnight
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  logger.info(
    `[Turnos Fijos] Scheduler iniciado. Primera ejecucion en ${Math.round(msUntilMidnight / 60000)} minutos (medianoche).`
  );

  // Run at midnight, then every 24h
  setTimeout(() => {
    generateAllFixedAppointments().catch((err) =>
      logger.error({ err }, "Error en generacion de turnos fijos (primera ejecucion)")
    );

    intervalHandle = setInterval(() => {
      generateAllFixedAppointments().catch((err) =>
        logger.error({ err }, "Error en ciclo de turnos fijos")
      );
    }, POLL_INTERVAL_MS);
  }, msUntilMidnight);

  // Also run immediately on startup to catch any missing appointments
  generateAllFixedAppointments().catch((err) =>
    logger.error({ err }, "Error en generacion inicial de turnos fijos")
  );
}

function stop() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
  logger.info("[Turnos Fijos] Scheduler detenido");
}

module.exports = {
  generateAllFixedAppointments,
  generateForSingleRule,
  start,
  stop,
  DAY_NAMES,
};
