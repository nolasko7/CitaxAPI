const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authMiddleware = require("../middlewares/auth.middleware");
const {
  generateForSingleRule,
  DAY_NAMES,
} = require("../services/fixedAppointmentGenerator.service");

router.use(authMiddleware);

/**
 * GET /api/fixed-appointments
 * List all fixed appointment rules for the company.
 */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT
         tf.id_turno_fijo,
         tf.id_cliente,
         tf.id_prestador,
         tf.id_servicio,
         tf.dia_semana,
         tf.hora,
         tf.frecuencia_semanas,
         tf.fecha_inicio,
         tf.fecha_fin,
         tf.activo,
         tf.ultima_generacion,
         tf.created_at,
         c.nombre_wa AS cliente_nombre,
         c.whatsapp_id AS cliente_telefono,
         s.nombre AS servicio_nombre,
         s.duracion_minutos,
         u.nombre AS prestador_nombre,
         u.apellido AS prestador_apellido
       FROM TURNO_FIJO tf
       JOIN CLIENTE c ON c.id_cliente = tf.id_cliente
       JOIN SERVICIO s ON s.id_servicio = tf.id_servicio
       JOIN PRESTADOR p ON p.id_prestador = tf.id_prestador
       JOIN USUARIO u ON u.id_usuario = p.id_usuario
       WHERE tf.id_empresa = ?
       ORDER BY tf.activo DESC, tf.dia_semana ASC, tf.hora ASC`,
      [req.user.id_empresa]
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const formatted = rows.map((r) => {
      const phone =
        r.cliente_telefono && !r.cliente_telefono.startsWith("manual_")
          ? r.cliente_telefono.includes("_")
            ? r.cliente_telefono.split("_")[0]
            : r.cliente_telefono
          : "";

      // Calculate next occurrence
      let proximaFecha = null;
      if (r.activo) {
        const fechaInicio = new Date(r.fecha_inicio);
        fechaInicio.setHours(0, 0, 0, 0);
        const cursor = new Date(Math.max(today.getTime(), fechaInicio.getTime()));

        // Find next matching day
        for (let i = 0; i < 60; i++) {
          if (cursor.getDay() === r.dia_semana) {
            const diffMs = cursor.getTime() - fechaInicio.getTime();
            const diffWeeks = Math.floor(
              Math.round(diffMs / (1000 * 60 * 60 * 24)) / 7
            );
            if (diffWeeks >= 0 && diffWeeks % r.frecuencia_semanas === 0) {
              proximaFecha = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
              break;
            }
          }
          cursor.setDate(cursor.getDate() + 1);
        }
      }

      return {
        id: r.id_turno_fijo,
        id_cliente: r.id_cliente,
        id_prestador: r.id_prestador,
        id_servicio: r.id_servicio,
        cliente_nombre: r.cliente_nombre || "Sin nombre",
        cliente_telefono: phone,
        servicio_nombre: r.servicio_nombre,
        duracion_minutos: r.duracion_minutos,
        prestador_nombre: `${r.prestador_nombre || ""} ${r.prestador_apellido || ""}`.trim(),
        dia_semana: r.dia_semana,
        dia_semana_label: DAY_NAMES[r.dia_semana] || "?",
        hora: r.hora,
        frecuencia_semanas: r.frecuencia_semanas,
        fecha_inicio: r.fecha_inicio
          ? new Date(r.fecha_inicio).toISOString().slice(0, 10)
          : null,
        fecha_fin: r.fecha_fin
          ? new Date(r.fecha_fin).toISOString().slice(0, 10)
          : null,
        activo: !!r.activo,
        proxima_fecha: proximaFecha,
        created_at: r.created_at,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener turnos fijos" });
  }
});

/**
 * POST /api/fixed-appointments
 * Create a new fixed appointment rule + generate future instances.
 */
router.post("/", async (req, res) => {
  const {
    cliente_nombre,
    cliente_telefono,
    servicio_id,
    prestador_id,
    dia_semana,
    hora,
    frecuencia_semanas = 1,
    fecha_inicio,
    fecha_fin,
  } = req.body;

  if (!cliente_nombre || servicio_id == null || prestador_id == null || dia_semana == null || !hora || !fecha_inicio) {
    return res.status(400).json({ error: "Faltan campos obligatorios." });
  }

  if (dia_semana < 0 || dia_semana > 6) {
    return res.status(400).json({ error: "dia_semana debe estar entre 0 y 6." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const empresaId = req.user.id_empresa;

    // Upsert CLIENTE (same logic as appointments.routes.js)
    let phoneToSearch = cliente_telefono || `manual_${Date.now()}`;
    const [checkRows] = await connection.execute(
      "SELECT id_cliente, nombre_wa FROM CLIENTE WHERE id_empresa = ? AND whatsapp_id = ?",
      [empresaId, phoneToSearch]
    );

    let clienteId;
    if (checkRows.length > 0) {
      clienteId = checkRows[0].id_cliente;
      // Update name if different
      const existingName = (checkRows[0].nombre_wa || "").trim().toLowerCase();
      const newName = (cliente_nombre || "").trim().toLowerCase();
      if (existingName !== newName) {
        await connection.execute(
          "UPDATE CLIENTE SET nombre_wa = ? WHERE id_cliente = ?",
          [cliente_nombre, clienteId]
        );
      }
    } else {
      const [insertRes] = await connection.execute(
        "INSERT INTO CLIENTE (id_empresa, whatsapp_id, nombre_wa) VALUES (?, ?, ?)",
        [empresaId, phoneToSearch, cliente_nombre]
      );
      clienteId = insertRes.insertId;
    }

    // Insert TURNO_FIJO rule
    const [turnoFijoRes] = await connection.execute(
      `INSERT INTO TURNO_FIJO 
        (id_empresa, id_cliente, id_prestador, id_servicio, dia_semana, hora, frecuencia_semanas, fecha_inicio, fecha_fin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        empresaId,
        clienteId,
        prestador_id,
        servicio_id,
        dia_semana,
        hora,
        frecuencia_semanas,
        fecha_inicio,
        fecha_fin || null,
      ]
    );

    await connection.commit();

    const ruleId = turnoFijoRes.insertId;

    // Generate future instances (outside transaction for simplicity)
    let generatedCount = 0;
    try {
      generatedCount = await generateForSingleRule(ruleId);
    } catch (genErr) {
      console.error("Error generating initial instances:", genErr);
    }

    res.status(201).json({
      id_turno_fijo: ruleId,
      generated_count: generatedCount,
    });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: "Error al crear turno fijo" });
  } finally {
    connection.release();
  }
});

/**
 * PUT /api/fixed-appointments/:id
 * Edit an existing fixed appointment rule.
 */
router.put("/:id", async (req, res) => {
  const ruleId = req.params.id;
  const {
    cliente_nombre,
    cliente_telefono,
    servicio_id,
    prestador_id,
    dia_semana,
    hora,
    frecuencia_semanas,
    fecha_inicio,
    fecha_fin,
  } = req.body;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Verify rule belongs to this company
    const [rows] = await connection.execute(
      "SELECT * FROM TURNO_FIJO WHERE id_turno_fijo = ? AND id_empresa = ?",
      [ruleId, req.user.id_empresa]
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "Turno fijo no encontrado" });
    }

    const rule = rows[0];
    const updates = [];
    const params = [];

    // Update client name if provided
    if (cliente_nombre !== undefined) {
      await connection.execute(
        "UPDATE CLIENTE SET nombre_wa = ? WHERE id_cliente = ?",
        [cliente_nombre, rule.id_cliente]
      );
    }

    if (cliente_telefono !== undefined) {
      await connection.execute(
        "UPDATE CLIENTE SET whatsapp_id = ? WHERE id_cliente = ?",
        [cliente_telefono || `manual_${Date.now()}`, rule.id_cliente]
      );
    }

    if (servicio_id !== undefined) {
      updates.push("id_servicio = ?");
      params.push(servicio_id);
    }
    if (prestador_id !== undefined) {
      updates.push("id_prestador = ?");
      params.push(prestador_id);
    }
    if (dia_semana !== undefined) {
      updates.push("dia_semana = ?");
      params.push(dia_semana);
    }
    if (hora !== undefined) {
      updates.push("hora = ?");
      params.push(hora);
    }
    if (frecuencia_semanas !== undefined) {
      updates.push("frecuencia_semanas = ?");
      params.push(frecuencia_semanas);
    }
    if (fecha_inicio !== undefined) {
      updates.push("fecha_inicio = ?");
      params.push(fecha_inicio);
    }
    if (fecha_fin !== undefined) {
      updates.push("fecha_fin = ?");
      params.push(fecha_fin || null);
    }

    // If schedule changed, reset ultima_generacion so it regenerates
    const scheduleChanged =
      dia_semana !== undefined ||
      hora !== undefined ||
      frecuencia_semanas !== undefined ||
      fecha_inicio !== undefined;

    if (scheduleChanged) {
      updates.push("ultima_generacion = NULL");
    }

    if (updates.length > 0) {
      params.push(ruleId);
      await connection.execute(
        `UPDATE TURNO_FIJO SET ${updates.join(", ")} WHERE id_turno_fijo = ?`,
        params
      );
    }

    await connection.commit();

    // If schedule changed, delete future unmodified instances and regenerate
    if (scheduleChanged) {
      try {
        // Delete only future instances that were auto-generated (estado = confirmado or conflicto, origen = fijo)
        await pool.execute(
          `DELETE FROM TURNO 
           WHERE id_turno_fijo = ? AND fecha_hora >= NOW()
             AND estado IN ('confirmado', 'conflicto')`,
          [ruleId]
        );
        await generateForSingleRule(ruleId);
      } catch (genErr) {
        console.error("Error regenerating instances:", genErr);
      }
    }

    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: "Error al actualizar turno fijo" });
  } finally {
    connection.release();
  }
});

/**
 * PATCH /api/fixed-appointments/:id/toggle
 * Toggle active/inactive state.
 */
router.patch("/:id/toggle", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT id_turno_fijo, activo FROM TURNO_FIJO WHERE id_turno_fijo = ? AND id_empresa = ?",
      [req.params.id, req.user.id_empresa]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Turno fijo no encontrado" });
    }

    const newState = !rows[0].activo;
    await pool.execute(
      "UPDATE TURNO_FIJO SET activo = ? WHERE id_turno_fijo = ?",
      [newState, req.params.id]
    );

    // If reactivated, generate missing instances
    if (newState) {
      try {
        await generateForSingleRule(req.params.id);
      } catch (genErr) {
        console.error("Error generating on reactivation:", genErr);
      }
    }

    res.json({ success: true, activo: newState });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al cambiar estado" });
  }
});

/**
 * DELETE /api/fixed-appointments/:id
 * Delete a rule. Existing TURNO instances are kept (id_turno_fijo becomes NULL via ON DELETE SET NULL).
 */
router.delete("/:id", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT id_turno_fijo FROM TURNO_FIJO WHERE id_turno_fijo = ? AND id_empresa = ?",
      [req.params.id, req.user.id_empresa]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Turno fijo no encontrado" });
    }

    // Delete future unconfirmed instances before deleting the rule
    await pool.execute(
      `DELETE FROM TURNO 
       WHERE id_turno_fijo = ? AND fecha_hora >= NOW()
         AND estado IN ('confirmado', 'conflicto')`,
      [req.params.id]
    );

    await pool.execute(
      "DELETE FROM TURNO_FIJO WHERE id_turno_fijo = ?",
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar turno fijo" });
  }
});

module.exports = router;
