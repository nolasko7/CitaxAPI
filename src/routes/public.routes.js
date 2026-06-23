const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { listAvailableSlots } = require("../services/ai/companyContextService");
const {
  sendTextMessage,
  sendAppointmentConfirmationPoll,
} = require("../services/evolution.service");
const {
  addMinutes,
  DEFAULT_APPOINTMENT_DURATION_MINUTES,
} = require("../utils/appointmentOccupancy");
const {
  findOverlappingAppointmentWithSql,
} = require("../services/appointmentConflict.service");
const { hasClienteEmailColumn } = require("../services/clientSchema.service");
const { hasTurnoOrigenColumn } = require("../services/turnoSchema.service");
const { resolveCompanyLandingTemplate } = require("../utils/companyLanding");
const {
  buildStoredAppointmentDate,
  buildStoredAppointmentDateTime,
} = require("../utils/appointmentDateInterop");

const SUPPORT_INSTANCE_NAME = String(
  process.env.SUPPORT_WHATSAPP_INSTANCE || "citax-support-whatsapp",
)
  .trim()
  .toLowerCase();

const normalizeSlug = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");

const normalizePhone = (value) =>
  String(value || "")
    .replace(/[^\d]/g, "")
    .trim();

const normalizeEmail = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();
const formatTime = (value) => String(value || "").slice(0, 5);
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^\d{2}:\d{2}$/;

const isValidIsoDate = (value) => {
  const text = String(value || "").trim();
  if (!ISO_DATE_REGEX.test(text)) return false;
  const parsed = new Date(`${text}T12:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === text
  );
};

const isValidTime = (value) => {
  const text = String(value || "").trim();
  if (!TIME_REGEX.test(text)) return false;
  const [hours, minutes] = text.split(":").map(Number);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
};

const buildAppointmentDateTime = (date, time) =>
  buildStoredAppointmentDateTime({ date, time });

const findCompanyBySlug = async (slug) => {
  const [rows] = await pool.execute(
    `SELECT e.id_empresa,
            e.nombre_comercial,
            e.slug,
            e.bot_config,
            cw.instance_name,
            cw.whatsapp_number,
            cw.conectado
     FROM EMPRESA e
     LEFT JOIN CONFIG_WHATSAPP cw ON cw.id_empresa = e.id_empresa
     WHERE e.slug = ?
     LIMIT 1`,
    [slug],
  );

  return rows[0] || null;
};

const getLandingReadyCompany = async (slug) => {
  const company = await findCompanyBySlug(slug);

  if (!company) {
    return { company: null, landingTemplate: null };
  }

  const landingTemplate = resolveCompanyLandingTemplate(company);

  return {
    company,
    landingTemplate,
  };
};

const listCompanyServices = async (companyId) => {
  const [rows] = await pool.execute(
    `SELECT id_servicio, nombre, descripcion, duracion_minutos, precio
     FROM SERVICIO
     WHERE id_empresa = ?
     ORDER BY nombre ASC`,
    [companyId],
  );

  return rows.map((row) => ({
    id: row.id_servicio,
    name: row.nombre,
    description: row.descripcion || "",
    durationMinutes: Number(row.duracion_minutos || 0),
    price: Number(row.precio || 0),
  }));
};

const listCompanyProfessionals = async (companyId) => {
  const [rows] = await pool.execute(
    `SELECT p.id_prestador,
            u.nombre,
            u.apellido,
            ps.id_servicio
     FROM PRESTADOR p
     JOIN USUARIO u ON u.id_usuario = p.id_usuario
     LEFT JOIN PRESTADOR_SERVICIO ps ON ps.id_prestador = p.id_prestador
     WHERE p.id_empresa = ?
       AND p.activo = 1
     ORDER BY u.nombre ASC, u.apellido ASC, ps.id_servicio ASC`,
    [companyId],
  );

  const map = new Map();

  for (const row of rows) {
    if (!map.has(row.id_prestador)) {
      map.set(row.id_prestador, {
        id: row.id_prestador,
        name: `${row.nombre || ""} ${row.apellido || ""}`.trim(),
        services: [],
      });
    }

    if (row.id_servicio) {
      map.get(row.id_prestador).services.push(Number(row.id_servicio));
    }
  }

  return Array.from(map.values()).map((professional) => ({
    ...professional,
    services: Array.from(new Set(professional.services)),
  }));
};

const professionalCanDoService = async ({ professionalId, serviceId }) => {
  const [rows] = await pool.execute(
    `SELECT id_servicio
     FROM PRESTADOR_SERVICIO
     WHERE id_prestador = ?`,
    [professionalId],
  );

  if (!rows.length) {
    return true;
  }

  return rows.some((row) => Number(row.id_servicio) === Number(serviceId));
};

const formatAppointmentDate = (value) =>
  new Date(`${value}T12:00:00Z`).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

const buildWhatsappNotification = ({
  companyName,
  clientName,
  clientPhone,
  clientEmail,
  serviceName,
  professionalName,
  date,
  time,
  turnoId,
}) => {
  const lines = [
    `*Nueva solicitud de turno* — ${companyName}`,
    "",
    `*Cliente:* ${clientName}`,
    `*Teléfono:* ${clientPhone}`,
    `*Email:* ${clientEmail || "No informado"}`,
    `*Servicio:* ${serviceName}`,
    `*Profesional:* ${professionalName}`,
    `*Fecha:* ${formatAppointmentDate(date)}`,
    `*Hora:* ${time}`,
    "",
    `*Turno #${turnoId}*`,
    "",
    "⬇️ Respondé la encuesta de abajo para confirmar o rechazar este turno.",
  ];

  return lines.join("\n");
};

const upsertClient = async ({
  connection,
  companyId,
  clientName,
  clientPhone,
  clientEmail,
}) => {
  const [rows] = await connection.execute(
    `SELECT id_cliente
     FROM CLIENTE
     WHERE id_empresa = ?
       AND whatsapp_id = ?
     LIMIT 1`,
    [companyId, clientPhone],
  );

  const hasEmail = await hasClienteEmailColumn(connection);

  if (rows.length > 0) {
    const clientId = rows[0].id_cliente;

    if (hasEmail) {
      await connection.execute(
        `UPDATE CLIENTE
         SET nombre_wa = ?, email = ?
         WHERE id_cliente = ?`,
        [clientName, clientEmail || null, clientId],
      );
    } else {
      await connection.execute(
        `UPDATE CLIENTE
         SET nombre_wa = ?
         WHERE id_cliente = ?`,
        [clientName, clientId],
      );
    }

    return clientId;
  }

  if (hasEmail) {
    const [result] = await connection.execute(
      `INSERT INTO CLIENTE (id_empresa, whatsapp_id, nombre_wa, email)
       VALUES (?, ?, ?, ?)`,
      [companyId, clientPhone, clientName, clientEmail || null],
    );

    return result.insertId;
  }

  const [result] = await connection.execute(
    `INSERT INTO CLIENTE (id_empresa, whatsapp_id, nombre_wa)
     VALUES (?, ?, ?)`,
    [companyId, clientPhone, clientName],
  );

  return result.insertId;
};

router.get("/landing/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (!slug) {
      return res.status(400).json({ error: "Slug invalido" });
    }

    const { company, landingTemplate } = await getLandingReadyCompany(slug);
    if (!company) {
      return res
        .status(404)
        .json({ error: "Landing no encontrada", redirect_to_main: true });
    }

    if (!landingTemplate) {
      return res.status(404).json({
        error: "La empresa no tiene landing configurada",
        redirect_to_main: true,
      });
    }

    const [services, professionals] = await Promise.all([
      listCompanyServices(company.id_empresa),
      listCompanyProfessionals(company.id_empresa),
    ]);

    res.json({
      company: {
        id: company.id_empresa,
        name: company.nombre_comercial,
        slug: company.slug,
        landing_template: landingTemplate,
        whatsappNumber: company.whatsapp_number || "",
        whatsappConnected: Boolean(company.conectado),
      },
      services,
      professionals,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error obteniendo la landing publica" });
  }
});

router.get("/landing/:slug/availability", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const professionalId = Number(req.query.professional_id);
    const serviceId = Number(req.query.service_id);
    const date = String(req.query.date || "").trim();

    if (!slug) {
      return res.status(400).json({ error: "Slug invalido" });
    }

    if (!professionalId || !serviceId || !date) {
      return res.status(400).json({
        error: "Faltan professional_id, service_id o date",
      });
    }

    if (!isValidIsoDate(date)) {
      return res.status(400).json({
        error: "La fecha debe estar en formato YYYY-MM-DD",
      });
    }

    const { company, landingTemplate } = await getLandingReadyCompany(slug);
    if (!company) {
      return res
        .status(404)
        .json({ error: "Landing no encontrada", redirect_to_main: true });
    }

    if (!landingTemplate) {
      return res.status(404).json({
        error: "La empresa no tiene landing configurada",
        redirect_to_main: true,
      });
    }

    const slots = await listAvailableSlots({
      companyId: company.id_empresa,
      professionalId,
      serviceId,
      startDate: date,
      endDate: date,
      referenceDate: date,
      limit: 120,
    });

    res.json({
      slots: slots
        .filter(
          (slot) =>
            Number(slot.professionalId) === professionalId &&
            slot.date === date,
        )
        .map((slot) => slot.time),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error obteniendo disponibilidad" });
  }
});

router.get("/landing/:slug/availability/blocked-dates", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (!slug) {
      return res.status(400).json({ error: "Slug invalido" });
    }

    const { company } = await getLandingReadyCompany(slug);
    if (!company) {
      return res.status(404).json({ error: "Landing no encontrada" });
    }

    const prestadorId = req.query.prestador_id ? Number(req.query.prestador_id) : null;
    let query = 'SELECT fecha, motivo, id_prestador FROM BLOCKED_DATES WHERE id_empresa = ? AND fecha >= CURDATE()';
    let params = [company.id_empresa];

    if (prestadorId) {
      query += ' AND (id_prestador = ? OR id_prestador IS NULL)';
      params.push(prestadorId);
    }

    const [rows] = await pool.execute(query, params);
    res.json(rows.map(r => ({
      fecha: r.fecha instanceof Date ? r.fecha.toISOString().split('T')[0] : r.fecha,
      motivo: r.motivo,
      prestador_id: r.id_prestador
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error obteniendo fechas bloqueadas públicas" });
  }
});

router.post("/landing/:slug/appointments", async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const slug = normalizeSlug(req.params.slug);
    const clientName = String(req.body.client_name || "").trim();
    const clientPhone = normalizePhone(req.body.client_phone);
    const clientEmail = normalizeEmail(req.body.client_email);
    const serviceId = Number(req.body.service_id);
    const professionalId = Number(req.body.professional_id);
    const date = String(req.body.date || "").trim();
    const time = formatTime(req.body.time);

    if (!slug) {
      return res.status(400).json({ error: "Slug invalido" });
    }

    if (!clientName || !clientPhone || !clientEmail) {
      return res.status(400).json({
        error: "Nombre, telefono y email son obligatorios",
      });
    }

    if (!serviceId || !professionalId || !date || !time) {
      return res.status(400).json({
        error: "Servicio, profesional, fecha y hora son obligatorios",
      });
    }

    if (!isValidIsoDate(date)) {
      return res.status(400).json({
        error: "La fecha debe estar en formato YYYY-MM-DD",
      });
    }

    if (!isValidTime(time)) {
      return res.status(400).json({
        error: "La hora debe estar en formato HH:MM",
      });
    }

    const { company, landingTemplate } = await getLandingReadyCompany(slug);
    if (!company) {
      return res
        .status(404)
        .json({ error: "Landing no encontrada", redirect_to_main: true });
    }

    if (!landingTemplate) {
      return res.status(404).json({
        error: "La empresa no tiene landing configurada",
        redirect_to_main: true,
      });
    }

    // Validate blocked dates
    const [blockedRows] = await pool.execute(
      'SELECT id FROM BLOCKED_DATES WHERE id_empresa = ? AND fecha = ? AND (id_prestador = ? OR id_prestador IS NULL)',
      [company.id_empresa, date, professionalId]
    );

    if (blockedRows.length > 0) {
      return res.status(400).json({ error: 'El negocio no trabaja ese día.' });
    }

    const [serviceRows] = await pool.execute(
      `SELECT id_servicio, nombre, duracion_minutos
       FROM SERVICIO
       WHERE id_empresa = ?
         AND id_servicio = ?
       LIMIT 1`,
      [company.id_empresa, serviceId],
    );

    if (!serviceRows.length) {
      return res.status(404).json({ error: "Servicio no encontrado" });
    }

    const [professionalRows] = await pool.execute(
      `SELECT p.id_prestador, u.nombre, u.apellido
       FROM PRESTADOR p
       JOIN USUARIO u ON u.id_usuario = p.id_usuario
       WHERE p.id_empresa = ?
         AND p.id_prestador = ?
         AND p.activo = 1
       LIMIT 1`,
      [company.id_empresa, professionalId],
    );

    if (!professionalRows.length) {
      return res.status(404).json({ error: "Profesional no encontrado" });
    }

    const canPerformService = await professionalCanDoService({
      professionalId,
      serviceId,
    });

    if (!canPerformService) {
      return res.status(409).json({
        error: "Ese profesional no ofrece el servicio seleccionado",
      });
    }

    // La validación de conflicto se hace con findOverlappingAppointmentWithSql más abajo.
    // No es necesario calcular TODOS los slots disponibles aquí (operación costosa con Prisma)
    // ya que el frontend solo envía horarios válidos desde el selector de disponibilidad.

    await connection.beginTransaction();

    const appointmentDateTime = buildAppointmentDateTime(date, time);
    const requestedStart = buildStoredAppointmentDate({ date, time });
    const requestedEnd = addMinutes(
      requestedStart,
      serviceRows[0].duracion_minutos || DEFAULT_APPOINTMENT_DURATION_MINUTES,
    );
    const conflict = await findOverlappingAppointmentWithSql({
      executor: connection,
      companyId: company.id_empresa,
      professionalId,
      start: requestedStart,
      end: requestedEnd,
    });

    if (conflict) {
      await connection.rollback();
      return res.status(409).json({
        error: "Ese horario ya no esta disponible",
      });
    }

    const clientId = await upsertClient({
      connection,
      companyId: company.id_empresa,
      clientName,
      clientPhone,
      clientEmail,
    });

    const includeOrigin = await hasTurnoOrigenColumn(connection);
    const turnoQuery = includeOrigin
      ? `INSERT INTO TURNO (id_cliente, id_prestador, id_servicio, fecha_hora, estado, origen)
         VALUES (?, ?, ?, ?, ?, ?)`
      : `INSERT INTO TURNO (id_cliente, id_prestador, id_servicio, fecha_hora, estado)
         VALUES (?, ?, ?, ?, ?)`;
    const turnoParams = includeOrigin
      ? [
          clientId,
          professionalId,
          serviceId,
          appointmentDateTime,
          "pendiente_confirmacion",
          "pagina",
        ]
      : [
          clientId,
          professionalId,
          serviceId,
          appointmentDateTime,
          "pendiente_confirmacion",
        ];
    const [turnoResult] = await connection.execute(turnoQuery, turnoParams);

    await connection.commit();

    let notificationSent = false;
    let notificationError = "";

    if (company.whatsapp_number) {
      console.log(
        `[NUEVO] Enviando poll confirmacion WA | instance=${SUPPORT_INSTANCE_NAME} | to=${company.whatsapp_number} | turnoId=${turnoResult.insertId}`,
      );
      try {
        await sendAppointmentConfirmationPoll({
          phoneNumber: company.whatsapp_number,
          instanceName: SUPPORT_INSTANCE_NAME,
          turnoId: turnoResult.insertId,
          companyId: company.id_empresa,
          notificationText: buildWhatsappNotification({
            companyName: company.nombre_comercial,
            clientName,
            clientPhone,
            clientEmail,
            serviceName: serviceRows[0].nombre,
            professionalName:
              `${professionalRows[0].nombre || ""} ${professionalRows[0].apellido || ""}`.trim(),
            date,
            time,
            turnoId: turnoResult.insertId,
          }),
        });
        notificationSent = true;
      } catch (error) {
        notificationError = error.response?.data?.message || error.message;
        console.error("❌ Error notificando solicitud publica por WhatsApp:");
        console.error("- Message:", notificationError);
        console.error(
          "- Response Data:",
          JSON.stringify(error.response?.data || {}, null, 2),
        );
        console.error("- Request Config URL:", error.config?.url);
        console.error("- Request Config Data:", error.config?.data);
      }
    }

    res.status(201).json({
      id_turno: turnoResult.insertId,
      estado: "pendiente_confirmacion",
      notification_sent: notificationSent,
      notification_error: notificationError,
      message:
        "Solicitud enviada. El turno queda pendiente hasta la confirmacion por WhatsApp.",
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // noop
    }
    console.error(error);
    res.status(500).json({ error: "Error creando la solicitud de turno" });
  } finally {
    connection.release();
  }
});

router.post("/landing/:slug/feedback", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = String(req.body.role || "otro").trim();
    const comment = String(req.body.comment || "").trim();

    if (!slug) {
      return res.status(400).json({ error: "Slug invalido" });
    }

    if (!name || !email || !comment) {
      return res.status(400).json({
        error: "Nombre, email y comentarios son obligatorios",
      });
    }

    const { company, landingTemplate } = await getLandingReadyCompany(slug);
    if (!company) {
      return res.status(404).json({ error: "Landing no encontrada" });
    }

    await pool.execute(
      "INSERT INTO FEEDBACK (id_empresa, nombre, email, rol, comentario) VALUES (?, ?, ?, ?, ?)",
      [company.id_empresa, name, email, role, comment]
    );

    if (company.whatsapp_number) {
      try {
        const messageText = `*Nuevo Feedback Recibido* — ${company.nombre_comercial}\n\n*Nombre:* ${name}\n*Email:* ${email}\n*Rol:* ${role}\n*Comentarios:* ${comment}`;
        await sendTextMessage(company.whatsapp_number, messageText, SUPPORT_INSTANCE_NAME);
      } catch (err) {
        console.error("Error al notificar feedback por WhatsApp:", err.message);
      }
    }

    res.status(201).json({ message: "Feedback registrado con éxito" });
  } catch (error) {
    console.error("Error registrando feedback:", error);
    res.status(500).json({ error: "Error interno al registrar el feedback" });
  }
});

module.exports = router;

