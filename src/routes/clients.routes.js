const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

router.use(authMiddleware);

// GET /api/clients — lista clientes con stats
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT
         c.id_cliente,
         c.nombre_wa,
         c.whatsapp_id,
         COUNT(t.id_turno) AS total_turnos,
         MAX(CASE WHEN t.fecha_hora <= NOW() THEN t.fecha_hora END) AS ultimo_turno
       FROM CLIENTE c
       LEFT JOIN TURNO t ON t.id_cliente = c.id_cliente
       WHERE c.id_empresa = ?
       GROUP BY c.id_cliente
       ORDER BY ultimo_turno DESC`,
      [req.user.id_empresa]
    );

    const now = new Date();
    const result = rows.map((r) => {
      const phone = r.whatsapp_id && !r.whatsapp_id.startsWith('manual_')
        ? (r.whatsapp_id.includes('_') ? r.whatsapp_id.split('_')[0] : r.whatsapp_id)
        : '';

      let diasDesde = null;
      if (r.ultimo_turno) {
        const diff = now - new Date(r.ultimo_turno);
        diasDesde = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
      }

      return {
        id: r.id_cliente,
        nombre: r.nombre_wa || 'Sin nombre',
        telefono: phone,
        total_turnos: Number(r.total_turnos),
        ultimo_turno: r.ultimo_turno ? new Date(r.ultimo_turno).toISOString() : null,
        dias_desde_ultimo: diasDesde,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

// PUT /api/clients/:id — editar nombre y telefono
router.put('/:id', async (req, res) => {
  const { nombre, telefono } = req.body;
  const clienteId = req.params.id;

  try {
    const [rows] = await pool.execute(
      'SELECT id_cliente FROM CLIENTE WHERE id_cliente = ? AND id_empresa = ?',
      [clienteId, req.user.id_empresa]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const updates = [];
    const params = [];

    if (nombre !== undefined) {
      updates.push('nombre_wa = ?');
      params.push(nombre.trim());
    }

    if (telefono !== undefined) {
      const newPhone = telefono.trim() || `manual_${Date.now()}`;
      updates.push('whatsapp_id = ?');
      params.push(newPhone);
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'Nada para actualizar' });
    }

    params.push(clienteId);
    await pool.execute(
      `UPDATE CLIENTE SET ${updates.join(', ')} WHERE id_cliente = ?`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar cliente' });
  }
});

// DELETE /api/clients/:id — borrar cliente
router.delete('/:id', async (req, res) => {
  const clienteId = req.params.id;

  try {
    const [rows] = await pool.execute(
      'SELECT id_cliente FROM CLIENTE WHERE id_cliente = ? AND id_empresa = ?',
      [clienteId, req.user.id_empresa]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    await pool.execute('DELETE FROM CLIENTE WHERE id_cliente = ?', [clienteId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al borrar cliente' });
  }
});

module.exports = router;
