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

const inferAppointmentOrigin = ({ origen, estado }) => {
  const normalizedOrigin = String(origen || "").trim().toLowerCase();
  if (normalizedOrigin) {
    return normalizedOrigin;
  }

  const normalizedStatus = String(estado || "").trim().toLowerCase();
  if (normalizedStatus === "pendiente_confirmacion") {
    return "pagina";
  }

  return "whatsapp";
};

module.exports = {
  hasTurnoOrigenColumn,
  inferAppointmentOrigin,
};
