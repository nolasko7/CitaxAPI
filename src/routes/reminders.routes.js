const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authMiddleware = require("../middlewares/auth.middleware");
const { sendTextMessageWithFallback } = require("../services/evolution.service");
const { parseSqlDateTimeAsUtc } = require("../utils/appointmentDateInterop");

router.use(authMiddleware);

function resolveTemplate(template, vars) {
  return template
    .replace(/\{\{cliente_nombre\}\}/g, vars.cliente_nombre || "")
    .replace(/\{\{fecha\}\}/g, vars.fecha || "")
    .replace(/\{\{hora\}\}/g, vars.hora || "")
    .replace(/\{\{empresa_nombre\}\}/g, vars.empresa_nombre || "");
}

function formatDateLocal(date) {
  return date.toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

function formatTimeLocal(date) {
  return date.toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

router.get("/today", async (req, res) => {
  try {
    const companyId = req.user.id_empresa;

    const [configRows] = await pool.execute(
      "SELECT config_recordatorios, nombre_comercial FROM EMPRESA WHERE id_empresa = ?",
      [companyId],
    );

    if (!configRows.length) {
      return res.status(404).json({ error: "Empresa no encontrada" });
    }

    const config =
      typeof configRows[0].config_recordatorios === "string"
        ? JSON.parse(configRows[0].config_recordatorios)
        : configRows[0].config_recordatorios || {};

    const defaultMessage =
      'Hola {{cliente_nombre}}, te recordamos tu turno para {{fecha}} a las {{hora}} en {{empresa_nombre}}.';

    const [turnos] = await pool.execute(
      `SELECT
        t.id_turno,
        t.fecha_hora,
        t.estado,
        c.nombre_wa AS cliente_nombre,
        c.whatsapp_id,
        s.nombre AS servicio_nombre,
        cw.instance_name,
        cw.whatsapp_number AS company_whatsapp_number
      FROM TURNO t
      JOIN CLIENTE c ON c.id_cliente = t.id_cliente
      JOIN SERVICIO s ON s.id_servicio = t.id_servicio
      LEFT JOIN CONFIG_WHATSAPP cw ON cw.id_empresa = ?
      WHERE c.id_empresa = ?
        AND t.estado IN ('pendiente', 'pendiente_confirmacion', 'confirmado')
        AND t.fecha_hora BETWEEN UTC_TIMESTAMP() AND DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
      ORDER BY t.fecha_hora ASC`,
      [companyId, companyId],
    );

    const appointments = turnos.map((t) => {
      const d =
        t.fecha_hora instanceof Date
          ? new Date(t.fecha_hora.getTime())
          : parseSqlDateTimeAsUtc(t.fecha_hora);
      return {
        id_turno: t.id_turno,
        cliente_nombre: t.cliente_nombre || "Cliente",
        whatsapp_id: t.whatsapp_id,
        servicio_nombre: t.servicio_nombre || "Servicio",
        estado: t.estado,
        fecha: formatDateLocal(d),
        hora: formatTimeLocal(d),
        fecha_hora: t.fecha_hora,
        tiene_whatsapp: Boolean(t.whatsapp_id),
        tiene_instance: Boolean(t.instance_name),
      };
    });

    const empresaNombre = configRows[0].nombre_comercial || "";

    const previewMessage = resolveTemplate(
      config.recordatorio_mensaje?.trim() || defaultMessage,
      {
        cliente_nombre: "{{cliente_nombre}}",
        fecha: "{{fecha}}",
        hora: "{{hora}}",
        empresa_nombre: empresaNombre,
      },
    );

    res.json({
      appointments,
      total: appointments.length,
      default_message: config.recordatorio_mensaje?.trim() || defaultMessage,
      preview_message: previewMessage,
      empresa_nombre: empresaNombre,
      recordatorio_activo: config.recordatorio_activo === true,
    });
  } catch (err) {
    console.error("Error al obtener preview de recordatorios:", err);
    res.status(500).json({ error: "Error al obtener recordatorios del dia" });
  }
});

router.post("/send-today", async (req, res) => {
  try {
    const companyId = req.user.id_empresa;
    const customMessage = String(req.body?.message || "").trim();

    const [configRows] = await pool.execute(
      "SELECT config_recordatorios, nombre_comercial FROM EMPRESA WHERE id_empresa = ?",
      [companyId],
    );

    if (!configRows.length) {
      return res.status(404).json({ error: "Empresa no encontrada" });
    }

    const empresaNombre = configRows[0].nombre_comercial || "";

    const [turnos] = await pool.execute(
      `SELECT
        t.id_turno,
        t.fecha_hora,
        c.nombre_wa AS cliente_nombre,
        c.whatsapp_id,
        cw.instance_name,
        cw.whatsapp_number AS company_whatsapp_number
      FROM TURNO t
      JOIN CLIENTE c ON c.id_cliente = t.id_cliente
      LEFT JOIN CONFIG_WHATSAPP cw ON cw.id_empresa = ?
      WHERE c.id_empresa = ?
        AND t.estado IN ('pendiente', 'pendiente_confirmacion', 'confirmado')
        AND t.fecha_hora BETWEEN UTC_TIMESTAMP() AND DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
      ORDER BY t.fecha_hora ASC`,
      [companyId, companyId],
    );

    const results = [];
    let sent = 0;
    let failed = 0;

    for (const t of turnos) {
      try {
        if (!t.whatsapp_id || !t.instance_name) {
          results.push({
            id_turno: t.id_turno,
            success: false,
            error: "Sin WhatsApp configurado",
          });
          failed++;
          continue;
        }

        const [[sentRow]] = await pool.execute(
          "SELECT 1 FROM TURNO_RECORDATORIO WHERE id_turno = ? AND offset_minutos = ? LIMIT 1",
          [t.id_turno, 0],
        );

        if (sentRow) {
          results.push({ id_turno: t.id_turno, success: false, error: "Ya se envio un recordatorio para este turno" });
          failed++;
          continue;
        }

        const d =
          t.fecha_hora instanceof Date
            ? new Date(t.fecha_hora.getTime())
            : parseSqlDateTimeAsUtc(t.fecha_hora);
        const message = resolveTemplate(customMessage, {
          cliente_nombre: t.cliente_nombre || "",
          fecha: formatDateLocal(d),
          hora: formatTimeLocal(d),
          empresa_nombre: empresaNombre,
        });

        await sendTextMessageWithFallback({
          phoneNumber: t.whatsapp_id,
          referencePhone: t.company_whatsapp_number,
          text: message,
          instanceName: t.instance_name,
        });

        await pool.execute(
          "INSERT INTO TURNO_RECORDATORIO (id_turno, offset_minutos, enviado_at) VALUES (?, ?, UTC_TIMESTAMP())",
          [t.id_turno, 0],
        );

        results.push({ id_turno: t.id_turno, success: true });
        sent++;
      } catch (err) {
        results.push({
          id_turno: t.id_turno,
          success: false,
          error: err.message,
        });
        failed++;
      }
    }

    res.json({ sent, failed, total: turnos.length, results });
  } catch (err) {
    console.error("Error al enviar recordatorios:", err);
    res.status(500).json({ error: "Error al enviar recordatorios" });
  }
});

module.exports = router;
