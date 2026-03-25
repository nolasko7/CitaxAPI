const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

router.use(authMiddleware);

// GET /api/services - List all services for the company
router.get('/', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM SERVICIO WHERE id_empresa = ?',
            [req.user.id_empresa]
        );
        const formatted = rows.map(s => ({
            ...s,
            id: s.id_servicio
        }));
        res.json(formatted);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener servicios' });
    }
});

// POST /api/services - Create a new service (admin only)
router.post('/', requireRole('admin_empresa'), async (req, res) => {
    const { nombre, descripcion, duracion_minutos, precio } = req.body;
    try {
        const [result] = await pool.execute(
            'INSERT INTO SERVICIO (id_empresa, nombre, descripcion, duracion_minutos, precio) VALUES (?, ?, ?, ?, ?)',
            [req.user.id_empresa, nombre, descripcion, duracion_minutos, precio]
        );
        res.status(201).json({
            id_servicio: result.insertId,
            nombre, descripcion, duracion_minutos, precio
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear servicio' });
    }
});

// PATCH /api/services/:id - Update a service (admin only)
router.patch('/:id', requireRole('admin_empresa'), async (req, res) => {
    const { nombre, descripcion, duracion_minutos, precio } = req.body;
    try {
        await pool.execute(
            'UPDATE SERVICIO SET nombre = ?, descripcion = ?, duracion_minutos = ?, precio = ? WHERE id_servicio = ? AND id_empresa = ?',
            [nombre, descripcion, duracion_minutos, precio, req.params.id, req.user.id_empresa]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar servicio' });
    }
});

// DELETE /api/services/:id - Delete a service (admin only)
router.delete('/:id', requireRole('admin_empresa'), async (req, res) => {
    try {
        await pool.execute(
            'DELETE FROM SERVICIO WHERE id_servicio = ? AND id_empresa = ?',
            [req.params.id, req.user.id_empresa]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al eliminar servicio' });
    }
});

module.exports = router;
