const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');
const { hasTurnoOrigenColumn } = require('../services/turnoSchema.service');

router.use(authMiddleware);

const readMarkersByCompany = new Map();

const normalizeLimit = (value, fallback = 20, max = 120) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
};

const normalizeAfterId = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
};

const mapTurnoToNotification = (row) => {
    const estado = String(row.estado || '').toLowerCase();
    const origen = String(row.turno_origen || '').toLowerCase();

    if (estado === 'cancelado') {
        return {
            type: 'booking_cancelled',
            title: 'Reserva cancelada',
            description: `${row.cliente_nombre || 'Cliente'} cancelo ${row.servicio_nombre || 'el turno'}.`,
            affectsCalendar: true,
        };
    }

    if (origen === 'manual') {
        return {
            type: 'manual_booking',
            title: 'Reserva manual',
            description: `${row.servicio_nombre || 'Servicio'} agendado manualmente para ${row.cliente_nombre || 'cliente'}.`,
            affectsCalendar: true,
        };
    }

    return {
        type: 'booking_confirmed',
        title: 'Nueva reserva',
        description: `${row.cliente_nombre || 'Cliente'} reservo ${row.servicio_nombre || 'un servicio'}.`,
        affectsCalendar: true,
    };
};

router.get('/', async (req, res) => {
    try {
        const companyId = req.user.id_empresa;
        const limit = normalizeLimit(req.query.limit, 20, 120);
        const afterId = normalizeAfterId(req.query.afterId);
        const includeOrigin = await hasTurnoOrigenColumn();

        const notificationsQuery = `
            SELECT
                t.id_turno,
                t.estado,
                t.fecha_hora,
                ${includeOrigin ? 't.origen AS turno_origen,' : "NULL AS turno_origen,"}
                c.nombre_wa AS cliente_nombre,
                s.nombre AS servicio_nombre
            FROM TURNO t
            JOIN CLIENTE c ON c.id_cliente = t.id_cliente
            JOIN SERVICIO s ON s.id_servicio = t.id_servicio
            WHERE c.id_empresa = ?
                ${afterId ? 'AND t.id_turno > ?' : ''}
            ORDER BY t.id_turno DESC
            LIMIT ${limit}
        `;

        const params = afterId
            ? [companyId, afterId]
            : [companyId];

        const [rows] = await pool.execute(notificationsQuery, params);

        const readMarker = Number(readMarkersByCompany.get(companyId) || 0);
        const items = rows.map((row) => {
            const mapped = mapTurnoToNotification(row);
            return {
                id: row.id_turno,
                type: mapped.type,
                title: mapped.title,
                description: mapped.description,
                createdAt: row.fecha_hora ? new Date(row.fecha_hora).toISOString() : new Date().toISOString(),
                readAt: row.id_turno <= readMarker ? new Date().toISOString() : null,
                affectsCalendar: mapped.affectsCalendar,
                appointmentId: row.id_turno,
                metadata: null,
            };
        });

        const unreadQuery = `
            SELECT COUNT(*) AS total
            FROM TURNO t
            JOIN CLIENTE c ON c.id_cliente = t.id_cliente
            WHERE c.id_empresa = ? AND t.id_turno > ?
        `;

        const [[unreadRow]] = await pool.execute(unreadQuery, [companyId, readMarker]);

        res.json({
            items,
            unreadCount: Number(unreadRow?.total || 0),
        });
    } catch (err) {
        console.error('Error al obtener notificaciones:', err);
        res.status(500).json({ error: 'Error al obtener notificaciones' });
    }
});

router.patch('/read-all', async (req, res) => {
    try {
        const companyId = req.user.id_empresa;

        const [rows] = await pool.execute(
            `SELECT COALESCE(MAX(t.id_turno), 0) AS max_id
             FROM TURNO t
             JOIN CLIENTE c ON c.id_cliente = t.id_cliente
             WHERE c.id_empresa = ?`,
            [companyId]
        );

        const maxId = Number(rows[0]?.max_id || 0);
        readMarkersByCompany.set(companyId, maxId);

        res.json({
            success: true,
            readAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error('Error al marcar notificaciones como leidas:', err);
        res.status(500).json({ error: 'Error al marcar notificaciones como leidas' });
    }
});

module.exports = router;
