const pool = require("../config/db");

const CACHE_TTL_MS = 5 * 60 * 1000;

let turnoOrigenColumnCache = {
  expiresAt: 0,
  value: false,
};

const hasTurnoOrigenColumn = async (executor = pool) => {
  if (Date.now() <= turnoOrigenColumnCache.expiresAt) {
    return turnoOrigenColumnCache.value;
  }

  try {
    const [rows] = await executor.execute(
      `SELECT 1
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'TURNO'
         AND COLUMN_NAME = 'origen'
       LIMIT 1`
    );

    const value = rows.length > 0;
    turnoOrigenColumnCache = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value,
    };

    return value;
  } catch (error) {
    console.error("Error verificando columna TURNO.origen:", error.message);
    return false;
  }
};

const ORIGIN_REASON_SEPARATOR = "|";

const parseTurnoOrigin = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return {
      raw: "",
      origin: "",
      reason: "",
    };
  }

  const [origin = "", reason = ""] = raw
    .split(ORIGIN_REASON_SEPARATOR)
    .map((part) => String(part || "").trim().toLowerCase());

  return {
    raw,
    origin,
    reason,
  };
};

const buildTurnoOrigin = ({ origin, reason }) => {
  const normalizedOrigin = String(origin || "").trim().toLowerCase();
  const normalizedReason = String(reason || "").trim().toLowerCase();

  if (!normalizedOrigin) return "";
  if (!normalizedReason) return normalizedOrigin;
  return `${normalizedOrigin}${ORIGIN_REASON_SEPARATOR}${normalizedReason}`;
};

const inferAppointmentOrigin = ({ origen, estado }) => {
  const parsedOrigin = parseTurnoOrigin(origen);
  if (parsedOrigin.origin) {
    return parsedOrigin.origin;
  }

  const normalizedStatus = String(estado || "").trim().toLowerCase();
  if (normalizedStatus === "pendiente_confirmacion") {
    return "pagina";
  }

  return "whatsapp";
};

module.exports = {
  buildTurnoOrigin,
  hasTurnoOrigenColumn,
  inferAppointmentOrigin,
  parseTurnoOrigin,
};
