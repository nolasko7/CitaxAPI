const pool = require("../config/db");

const NOTIFICATION_TYPES = {
  NEW_BOOKING: "new_booking",
  SYSTEM_ERROR: "system_error",
  BOOKING_CANCELLED: "booking_cancelled",
  BOOKING_CONFIRMED: "booking_confirmed",
  MANUAL_BOOKING: "manual_booking",
};

const CALENDAR_AFFECTING_TYPES = new Set([
  NOTIFICATION_TYPES.NEW_BOOKING,
  NOTIFICATION_TYPES.BOOKING_CANCELLED,
  NOTIFICATION_TYPES.BOOKING_CONFIRMED,
  NOTIFICATION_TYPES.MANUAL_BOOKING,
]);

const NOTIFICATION_TITLES = {
  [NOTIFICATION_TYPES.NEW_BOOKING]: "Nueva reserva",
  [NOTIFICATION_TYPES.SYSTEM_ERROR]: "Error de sistema",
  [NOTIFICATION_TYPES.BOOKING_CANCELLED]: "Reserva cancelada",
  [NOTIFICATION_TYPES.BOOKING_CONFIRMED]: "Reserva confirmada",
  [NOTIFICATION_TYPES.MANUAL_BOOKING]: "Reserva manual cargada",
};

const clampLimit = (value, fallback = 30) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 100);
};

const parseMetadata = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const formatDateLabel = (date) => {
  const raw = String(date || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;
  return `${match[3]}/${match[2]}/${match[1]}`;
};

const formatTimeLabel = (time) => String(time || "").slice(0, 5);

const buildBookingDescription = ({
  clientName,
  serviceName,
  professionalName,
  date,
  time,
}) => {
  const parts = [];
  const safeClient = String(clientName || "Cliente").trim();
  const safeService = String(serviceName || "Turno").trim();
  const safeProfessional = String(professionalName || "").trim();
  const safeDate = formatDateLabel(date);
  const safeTime = formatTimeLabel(time);

  parts.push(`${safeClient} - ${safeService}`);

  const schedule = [safeDate, safeTime].filter(Boolean).join(" ");
  if (schedule) {
    parts.push(schedule);
  }

  if (safeProfessional) {
    parts.push(`con ${safeProfessional}`);
  }

  return parts.join(" · ");
};

const buildBookingNotificationContent = (type, details = {}) => ({
  title: NOTIFICATION_TITLES[type] || "Notificacion",
  description: buildBookingDescription(details),
});

const mapNotificationRow = (row) => ({
  id: row.id_notificacion,
  type: row.tipo,
  title: row.titulo,
  description: row.descripcion || "",
  createdAt:
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString(),
  readAt: row.read_at
    ? row.read_at instanceof Date
      ? row.read_at.toISOString()
      : new Date(row.read_at).toISOString()
    : null,
  affectsCalendar: CALENDAR_AFFECTING_TYPES.has(row.tipo),
  appointmentId: row.appointment_id || null,
  metadata: parseMetadata(row.metadata),
});

const createNotification = async (
  {
    companyId,
    type,
    title,
    description = "",
    appointmentId = null,
    metadata = null,
  },
  options = {},
) => {
  const executor = options.connection || pool;
  const createdAt = new Date();
  const serializedMetadata =
    metadata == null ? null : JSON.stringify(metadata);

  const [result] = await executor.execute(
    `INSERT INTO NOTIFICACION (
      id_empresa,
      tipo,
      titulo,
      descripcion,
      metadata,
      appointment_id
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      companyId,
      type,
      title,
      description || null,
      serializedMetadata,
      appointmentId,
    ],
  );

  return {
    id: result.insertId,
    type,
    title,
    description: description || "",
    createdAt: createdAt.toISOString(),
    readAt: null,
    affectsCalendar: CALENDAR_AFFECTING_TYPES.has(type),
    appointmentId: appointmentId || null,
    metadata,
  };
};

const createBookingNotification = async (
  { companyId, type, appointmentId = null, metadata = null, ...details },
  options = {},
) => {
  const content = buildBookingNotificationContent(type, details);
  return createNotification(
    {
      companyId,
      type,
      title: content.title,
      description: content.description,
      appointmentId,
      metadata,
    },
    options,
  );
};

const createSystemErrorNotification = async (
  { companyId, description, metadata = null, title },
  options = {},
) =>
  createNotification(
    {
      companyId,
      type: NOTIFICATION_TYPES.SYSTEM_ERROR,
      title: title || NOTIFICATION_TITLES[NOTIFICATION_TYPES.SYSTEM_ERROR],
      description,
      metadata,
    },
    options,
  );

const listNotifications = async ({ companyId, afterId = null, limit = 30 }) => {
  const safeLimit = clampLimit(limit);
  const parsedAfterId = Number.parseInt(afterId, 10);
  const hasAfterId = Number.isFinite(parsedAfterId) && parsedAfterId > 0;

  const query = hasAfterId
    ? `SELECT *
       FROM NOTIFICACION
       WHERE id_empresa = ? AND id_notificacion > ?
       ORDER BY id_notificacion ASC
       LIMIT ${safeLimit}`
    : `SELECT *
       FROM NOTIFICACION
       WHERE id_empresa = ?
       ORDER BY id_notificacion DESC
       LIMIT ${safeLimit}`;

  const params = hasAfterId ? [companyId, parsedAfterId] : [companyId];

  const [rows] = await pool.execute(query, params);
  const [unreadRows] = await pool.execute(
    `SELECT COUNT(*) AS unreadCount
     FROM NOTIFICACION
     WHERE id_empresa = ? AND read_at IS NULL`,
    [companyId],
  );

  return {
    items: rows.map(mapNotificationRow),
    unreadCount: Number(unreadRows[0]?.unreadCount || 0),
  };
};

const markAllNotificationsRead = async ({ companyId }) => {
  const readAt = new Date();
  await pool.execute(
    `UPDATE NOTIFICACION
     SET read_at = ?
     WHERE id_empresa = ? AND read_at IS NULL`,
    [readAt, companyId],
  );

  return {
    success: true,
    readAt: readAt.toISOString(),
    unreadCount: 0,
  };
};

module.exports = {
  NOTIFICATION_TYPES,
  buildBookingDescription,
  buildBookingNotificationContent,
  createBookingNotification,
  createNotification,
  createSystemErrorNotification,
  listNotifications,
  markAllNotificationsRead,
  mapNotificationRow,
};
