const {
  DEFAULT_APPOINTMENT_DURATION_MINUTES,
  OCCUPYING_APPOINTMENT_STATUSES,
  addMinutes,
  rangesOverlap,
} = require("../utils/appointmentOccupancy");
const {
  toComparableAppointmentDate,
} = require("../utils/appointmentDateInterop");

const buildDayBounds = (start, end = start) => {
  const dayStart = new Date(start);
  dayStart.setHours(0, 0, 0, 0);

  const dayEnd = new Date(end);
  dayEnd.setHours(23, 59, 59, 999);

  return { dayStart, dayEnd };
};

const findOverlappingAppointmentWithPrisma = async ({
  prismaClient,
  companyId,
  professionalId,
  start,
  end,
  excludeAppointmentId = null,
}) => {
  const { dayStart, dayEnd } = buildDayBounds(start, end);

  const candidates = await prismaClient.tURNO.findMany({
    where: {
      id_prestador: Number(professionalId),
      estado: { in: OCCUPYING_APPOINTMENT_STATUSES },
      fecha_hora: {
        gte: dayStart,
        lte: dayEnd,
      },
      PRESTADOR: { id_empresa: Number(companyId) },
      ...(excludeAppointmentId
        ? { NOT: { id_turno: Number(excludeAppointmentId) } }
        : {}),
    },
    include: { SERVICIO: true },
    orderBy: { fecha_hora: "asc" },
  });

  return (
    candidates.find((appointment) => {
      const appointmentStart = toComparableAppointmentDate(appointment);
      const appointmentEnd = addMinutes(
        appointmentStart,
        appointment.SERVICIO?.duracion_minutos ||
          DEFAULT_APPOINTMENT_DURATION_MINUTES,
      );

      return rangesOverlap(start, end, appointmentStart, appointmentEnd);
    }) || null
  );
};

const findOverlappingAppointmentWithSql = async ({
  executor,
  companyId,
  professionalId,
  start,
  end,
  excludeAppointmentId = null,
}) => {
  const placeholders = OCCUPYING_APPOINTMENT_STATUSES.map(() => "?").join(", ");
  const params = [
    Number(companyId),
    Number(professionalId),
    ...OCCUPYING_APPOINTMENT_STATUSES,
    end,
    start,
  ];

  let query = `
    SELECT
      t.id_turno,
      t.estado,
      t.fecha_hora,
      COALESCE(s.duracion_minutos, ${DEFAULT_APPOINTMENT_DURATION_MINUTES}) AS duracion_minutos
    FROM TURNO t
    JOIN CLIENTE c ON c.id_cliente = t.id_cliente
    JOIN SERVICIO s ON s.id_servicio = t.id_servicio
    WHERE c.id_empresa = ?
      AND t.id_prestador = ?
      AND t.estado IN (${placeholders})
      AND t.fecha_hora < ?
      AND TIMESTAMPADD(MINUTE, COALESCE(s.duracion_minutos, ${DEFAULT_APPOINTMENT_DURATION_MINUTES}), t.fecha_hora) > ?
  `;

  if (excludeAppointmentId) {
    query += " AND t.id_turno <> ?";
    params.push(Number(excludeAppointmentId));
  }

  query += " ORDER BY t.fecha_hora ASC LIMIT 1";

  const [rows] = await executor.execute(query, params);
  return rows[0] || null;
};

module.exports = {
  findOverlappingAppointmentWithPrisma,
  findOverlappingAppointmentWithSql,
};
