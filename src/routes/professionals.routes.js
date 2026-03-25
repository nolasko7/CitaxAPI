const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const bcrypt = require('bcryptjs');

router.use(authMiddleware);

// GET /api/professionals - List all (existing)
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT p.id_prestador, p.activo, u.id_usuario, u.nombre, u.apellido, u.email
            FROM PRESTADOR p
            JOIN USUARIO u ON p.id_usuario = u.id_usuario
            WHERE p.id_empresa = ?
        `;
        const [rows] = await pool.execute(query, [req.user.id_empresa]);
        
        // Fetch services for each professional to include in the list
        const formatted = await Promise.all(rows.map(async p => {
            const [svcRows] = await pool.execute(
                'SELECT id_servicio FROM PRESTADOR_SERVICIO WHERE id_prestador = ?',
                [p.id_prestador]
            );
            return {
                id: p.id_prestador,
                id_usuario: p.id_usuario,
                nombre: p.nombre,
                apellido: p.apellido,
                email: p.email,
                activo: p.activo,
                servicios: svcRows.map(s => s.id_servicio)
            };
        }));
        
        res.json(formatted);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener profesionales' });
    }
});

// POST /api/professionals - Create a new prestador (empresa only)
router.post('/', requireRole('admin_empresa'), async (req, res) => {
    const { nombre, apellido, email, password } = req.body;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Check for duplicate email
        const [existing] = await connection.execute('SELECT id_usuario FROM USUARIO WHERE email = ?', [email]);
        if (existing.length > 0) {
            connection.release();
            return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
        }

        const hash = await bcrypt.hash(password || 'citax1234', 10);
        const [userRes] = await connection.execute(
            'INSERT INTO USUARIO (email, password_hash, nombre, apellido, rol) VALUES (?, ?, ?, ?, ?)',
            [email, hash, nombre, apellido, 'prestador']
        );

        const [prestRes] = await connection.execute(
            'INSERT INTO PRESTADOR (id_usuario, id_empresa, activo) VALUES (?, ?, ?)',
            [userRes.insertId, req.user.id_empresa, 1]
        );

        await connection.commit();
        res.status(201).json({
            id: prestRes.insertId,
            nombre, apellido, email, activo: true
        });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: 'Error al crear prestador' });
    } finally {
        connection.release();
    }
});

// PATCH /api/professionals/:id - Toggle activo (empresa only)
router.patch('/:id', requireRole('admin_empresa'), async (req, res) => {
    const { activo } = req.body;
    try {
        await pool.execute(
            'UPDATE PRESTADOR SET activo = ? WHERE id_prestador = ? AND id_empresa = ?',
            [activo ? 1 : 0, req.params.id, req.user.id_empresa]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar prestador' });
    }
});

// DELETE /api/professionals/:id (empresa only)
router.delete('/:id', requireRole('admin_empresa'), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        // Get the user ID first
        const [rows] = await connection.execute(
            'SELECT id_usuario FROM PRESTADOR WHERE id_prestador = ? AND id_empresa = ?',
            [req.params.id, req.user.id_empresa]
        );
        if (rows.length === 0) {
            connection.release();
            return res.status(404).json({ error: 'Prestador no encontrado' });
        }
        const id_usuario = rows[0].id_usuario;
        
        // Remove the professional record
        await connection.execute('DELETE FROM PRESTADOR WHERE id_prestador = ?', [req.params.id]);
        
        // ONLY delete the user record if they are NOT the owner of the company
        const [ownerRows] = await connection.execute('SELECT id_usuario FROM EMPRESA WHERE id_empresa = ?', [req.user.id_empresa]);
        const ownerId = ownerRows[0]?.id_usuario;
        
        if (id_usuario !== ownerId) {
            await connection.execute('DELETE FROM USUARIO WHERE id_usuario = ?', [id_usuario]);
        }
        await connection.commit();
        res.json({ success: true });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: 'Error al eliminar prestador' });
    } finally {
        connection.release();
    }
});

// GET /api/professionals/:id/services - Get services for a professional
router.get('/:id/services', async (req, res) => {
    try {
        const query = `
            SELECT s.* 
            FROM SERVICIO s
            JOIN PRESTADOR_SERVICIO ps ON s.id_servicio = ps.id_servicio
            WHERE ps.id_prestador = ? AND s.id_empresa = ?
        `;
        const [rows] = await pool.execute(query, [req.params.id, req.user.id_empresa]);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener servicios del prestador' });
    }
});

// POST /api/professionals/:id/services - Link a service to a professional (admin only)
router.post('/:id/services', requireRole('admin_empresa'), async (req, res) => {
    const { id_servicio } = req.body;
    try {
        // Verify service belongs to company
        const [sRows] = await pool.execute('SELECT id_servicio FROM SERVICIO WHERE id_servicio = ? AND id_empresa = ?', [id_servicio, req.user.id_empresa]);
        if (sRows.length === 0) return res.status(403).json({ error: 'Servicio no encontrado o no pertenece a la empresa' });

        await pool.execute(
            'INSERT IGNORE INTO PRESTADOR_SERVICIO (id_prestador, id_servicio) VALUES (?, ?)',
            [req.params.id, id_servicio]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al vincular servicio' });
    }
});

// DELETE /api/professionals/:id/services/:serviceId - Unlink a service (admin only)
router.delete('/:id/services/:serviceId', requireRole('admin_empresa'), async (req, res) => {
    try {
        await pool.execute(
            'DELETE FROM PRESTADOR_SERVICIO WHERE id_prestador = ? AND id_servicio = ?',
            [req.params.id, req.params.serviceId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al desvincular servicio' });
    }
});

module.exports = router;
