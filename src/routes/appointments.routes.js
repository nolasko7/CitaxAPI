const express = require("express");
const pool = require("../config/db");
const authMiddleware = require("../middlewares/auth.middleware");
const {
  createBookingNotification,
  NOTIFICATION_TYPES,
} = require("../services/notification.service");

const router = express.Router();

const APPOINTMENT_SELECT = `
  SELECT
    t.id_turno,
    DATE_FORMAT(t.fecha_hora, '%Y-%m-%d') AS fecha,
    DATE_FORMAT(t.fecha_hora, '%H:%i') AS hora_inicio,
    t.estado,
    c.nombre_wa,
    c.whatsapp_id,
    u.nombre AS prestador_nombre,
    u.apellido AS prestador_apellido,
    s.nombre AS servicio_nombre
  FROM TURNO t
  JOIN CLIENTE c ON t.id_cliente = c.id_cliente
  JOIN PRESTADOR p ON t.id_prestador = p.id_prestador
  JOIN USUARIO u ON p.id_usuario = u.id_usuario
  JOIN SERVICIO s ON t.id_servicio = s.id_servicio
  WHERE c.id_empresa = ?
`;

router.use(authMiddleware);

const formatAppointmentRow = (appointment) => ({
  id: appointment.id_turno,
  fecha: appointment.fecha,
  hora_inicio: appointment.hora_inicio,
  estado: appointment.estado,
  cliente_nombre: appointment.nombre_wa || "Sin nombre",
  cliente_whatsapp: appointment.whatsapp_id,
  prestador_nombre: appointment.prestador_nombre,
  prestador_apellido: appointment.prestador_apellido,
  servicio_nombre: appointment.servicio_nombre,
});

const formatProfessionalName = (appointment) =>
  [appointment.prestador_nombre, appointment.prestador_apellido]
    .filter(Boolean)
    .join(" ")
    .trim();

const fetchAppointmentById = async (executor, companyId, appointmentId) => {
  const [rows] = await executor.execute(
    `${APPOINTMENT_SELECT} AND t.id_turno = ? LIMIT 1`,
    [companyId, appointmentId],
  );

  return rows[0] || null;
};

router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `${APPOINTMENT_SELECT} ORDER BY t.fecha_hora ASC`,
      [req.user.id_empresa],
    );

    res.json(rows.map(formatAppointmentRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener turnos" });
  }
});

router.post("/", async (req, res) => {
  const {
    cliente_nombre,
    cliente_telefono,
    servicio_id,
    prestador_id,
    fecha,
    hora_inicio,
  } = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const empresaId = req.user.id_empresa;

    const [checkRows] = await connection.execute(
      "SELECT id_cliente FROM CLIENTE WHERE id_empresa = ? AND whatsapp_id = ?",
      [empresaId, cliente_telefono],
    );

    let clienteId;
    if (checkRows.length > 0) {
      clienteId = checkRows[0].id_cliente;
      await connection.execute(
        "UPDATE CLIENTE SET nombre_wa = ? WHERE id_cliente = ?",
        [cliente_nombre, clienteId],
      );
    } else {
      const [insertRes] = await connection.execute(
        "INSERT INTO CLIENTE (id_empresa, whatsapp_id, nombre_wa) VALUES (?, ?, ?)",
        [empresaId, cliente_telefono, cliente_nombre],
      );
      clienteId = insertRes.insertId;
    }

    const fullDate = `${fecha} ${hora_inicio}:00`;
    const [turnoRes] = await connection.execute(
      "INSERT INTO TURNO (id_cliente, id_prestador, id_servicio, fecha_hora, estado) VALUES (?, ?, ?, ?, ?)",
      [clienteId, prestador_id, servicio_id, fullDate, "pendiente"],
    );

    const appointment = await fetchAppointmentById(
      connection,
      empresaId,
      turnoRes.insertId,
    );

    const notification = await createBookingNotification(
      {
        companyId: empresaId,
        type: NOTIFICATION_TYPES.MANUAL_BOOKING,
        appointmentId: turnoRes.insertId,
        clientName: appointment?.nombre_wa || cliente_nombre,
        serviceName: appointment?.servicio_nombre,
        professionalName: formatProfessionalName(appointment),
        date: appointment?.fecha || fecha,
        time: appointment?.hora_inicio || hora_inicio,
        metadata: {
          source: "dashboard_manual",
        },
      },
      { connection },
    );

    await connection.commit();
    res.status(201).json({
      id_turno: turnoRes.insertId,
      notification,
    });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: "Error al crear turno" });
  } finally {
    connection.release();
  }
});

router.put("/:id", async (req, res) => {
  const { estado } = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const appointment = await fetchAppointmentById(
      connection,
      req.user.id_empresa,
      req.params.id,
    );

    if (!appointment) {
      await connection.rollback();
      return res.status(404).json({ error: "Turno no encontrado" });
    }

    await connection.execute("UPDATE TURNO SET estado = ? WHERE id_turno = ?", [
      estado,
      req.params.id,
    ]);

    let notification = null;
    const normalizedEstado = String(estado || "").trim().toLowerCase();

    if (normalizedEstado === "confirmado") {
      notification = await createBookingNotification(
        {
          companyId: req.user.id_empresa,
          type: NOTIFICATION_TYPES.BOOKING_CONFIRMED,
          appointmentId: Number(req.params.id),
          clientName: appointment.nombre_wa,
          serviceName: appointment.servicio_nombre,
          professionalName: formatProfessionalName(appointment),
          date: appointment.fecha,
          time: appointment.hora_inicio,
          metadata: {
            source: "dashboard_update",
            estado: normalizedEstado,
          },
        },
        { connection },
      );
    } else if (normalizedEstado === "cancelado") {
      notification = await createBookingNotification(
        {
          companyId: req.user.id_empresa,
          type: NOTIFICATION_TYPES.BOOKING_CANCELLED,
          appointmentId: Number(req.params.id),
          clientName: appointment.nombre_wa,
          serviceName: appointment.servicio_nombre,
          professionalName: formatProfessionalName(appointment),
          date: appointment.fecha,
          time: appointment.hora_inicio,
          metadata: {
            source: "dashboard_update",
            estado: normalizedEstado,
          },
        },
        { connection },
      );
    }

    await connection.commit();
    res.json({ success: true, notification });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: "Error al actualizar turno" });
  } finally {
    connection.release();
  }
});

router.delete("/:id", async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const appointment = await fetchAppointmentById(
      connection,
      req.user.id_empresa,
      req.params.id,
    );

    if (!appointment) {
      await connection.rollback();
      return res.status(404).json({ error: "Turno no encontrado" });
    }

    const notification = await createBookingNotification(
      {
        companyId: req.user.id_empresa,
        type: NOTIFICATION_TYPES.BOOKING_CANCELLED,
        appointmentId: Number(req.params.id),
        clientName: appointment.nombre_wa,
        serviceName: appointment.servicio_nombre,
        professionalName: formatProfessionalName(appointment),
        date: appointment.fecha,
        time: appointment.hora_inicio,
        metadata: {
          source: "dashboard_delete",
        },
      },
      { connection },
    );

    await connection.execute("DELETE FROM TURNO WHERE id_turno = ?", [
      req.params.id,
    ]);

    await connection.commit();
    res.json({ success: true, notification });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: "Error al borrar turno" });
  } finally {
    connection.release();
  }
});

module.exports = router;
