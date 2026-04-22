const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');
const { hasClienteEmailColumn } = require('../services/clientSchema.service');
const { hasTurnoOrigenColumn, inferAppointmentOrigin, parseTurnoOrigin, buildTurnoOrigin } = require('../services/turnoSchema.service');
const { mapTurnoToNotification } = require('./notifications.routes');

const formatDateLocal = (value) => {
    const date = new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const formatTimeLocal = (value) => {
    const date = new Date(value);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
};

router.use(authMiddleware);

const MANUAL_CHANGE_ORIGIN = 'manual';
const MANUAL_CONFIRMED_CANCELLATION_REASON = 'manual_confirmed_cancellation';

const ALLOWED_STATUS_TRANSITIONS = {
    pendiente: new Set(['confirmado', 'cancelado']),
    pendiente_confirmacion: new Set(['confirmado', 'cancelado']),
    confirmado: new Set(['cancelado']),
    cancelado: new Set([]),
};

const buildAppointmentStatusChange = ({ currentStatus, nextStatus, currentOrigin }) => {
    const previousStatus = String(currentStatus || '').trim().toLowerCase();
    const requestedStatus = String(nextStatus || '').trim().toLowerCase();

    if (!requestedStatus) {
        const error = new Error('Debes enviar un estado valido.');
        error.statusCode = 400;
        throw error;
    }

    if (!previousStatus) {
        const error = new Error('El turno no tiene un estado valido.');
        error.statusCode = 409;
        throw error;
    }

    if (previousStatus === requestedStatus) {
        return {
            previousStatus,
            currentStatus: requestedStatus,
            changeOrigin: MANUAL_CHANGE_ORIGIN,
            changeReason: null,
            nextOrigin: currentOrigin,
            wasChanged: false,
        };
    }

    const allowedTransitions = ALLOWED_STATUS_TRANSITIONS[previousStatus];
    if (!allowedTransitions || !allowedTransitions.has(requestedStatus)) {
        const error = new Error(`No se permite cambiar un turno de ${previousStatus} a ${requestedStatus}.`);
        error.statusCode = 409;
        throw error;
    }

    const parsedOrigin = parseTurnoOrigin(currentOrigin);
    const baseOrigin = parsedOrigin.origin || inferAppointmentOrigin({ origen: currentOrigin, estado: previousStatus });
    const changeReason =
        previousStatus === 'confirmado' && requestedStatus === 'cancelado'
            ? MANUAL_CONFIRMED_CANCELLATION_REASON
            : null;

    return {
        previousStatus,
        currentStatus: requestedStatus,
        changeOrigin: MANUAL_CHANGE_ORIGIN,
        changeReason,
        nextOrigin: changeReason
            ? buildTurnoOrigin({ origin: baseOrigin, reason: changeReason })
            : currentOrigin,
        wasChanged: true,
    };
};

const buildAppointmentMutationNotification = ({
    appointmentId,
    currentStatus,
    currentOrigin,
    clienteNombre,
    servicioNombre,
}) => {
    const mapped = mapTurnoToNotification({
        id_turno: appointmentId,
        estado: currentStatus,
        turno_origen: currentOrigin,
        cliente_nombre: clienteNombre,
        servicio_nombre: servicioNombre,
    });

    return {
        id: appointmentId,
        type: mapped.type,
        title: mapped.title,
        description: mapped.description,
        createdAt: new Date().toISOString(),
        readAt: null,
        affectsCalendar: Boolean(mapped.affectsCalendar),
        appointmentId,
        metadata: null,
    };
};

router.get('/', async (req, res) => {
    try {
        const includeClientEmail = await hasClienteEmailColumn();
        const includeOrigin = await hasTurnoOrigenColumn();
        const query = `
            SELECT t.*, c.nombre_wa, c.whatsapp_id,
                   ${includeClientEmail ? 'c.email AS cliente_email,' : 'NULL AS cliente_email,'}
                   ${includeOrigin ? 't.origen AS turno_origen,' : "NULL AS turno_origen,"}
                   u.nombre as prestador_nombre, u.apellido as prestador_apellido,
                   s.nombre as servicio_nombre
            FROM TURNO t
            JOIN CLIENTE c ON t.id_cliente = c.id_cliente
            JOIN PRESTADOR p ON t.id_prestador = p.id_prestador
            JOIN USUARIO u ON p.id_usuario = u.id_usuario
            JOIN SERVICIO s ON t.id_servicio = s.id_servicio
            WHERE c.id_empresa = ?
            ORDER BY t.fecha_hora ASC
        `;
        const [rows] = await pool.execute(query, [req.user.id_empresa]);

        const formatted = rows.map(appt => ({
            id: appt.id_turno,
            fecha: formatDateLocal(appt.fecha_hora),
            hora_inicio: formatTimeLocal(appt.fecha_hora),
            estado: appt.estado,
            origen: inferAppointmentOrigin({ origen: appt.turno_origen, estado: appt.estado }),
            cliente_nombre: appt.nombre_wa || 'Sin nombre',
            cliente_whatsapp: appt.whatsapp_id.startsWith('manual_') ? '' : (appt.whatsapp_id.includes('_') ? appt.whatsapp_id.split('_')[0] : appt.whatsapp_id),
            cliente_email: appt.cliente_email || '',
            prestador_nombre: appt.prestador_nombre,
            prestador_apellido: appt.prestador_apellido,
            servicio_nombre: appt.servicio_nombre
        }));

        res.json(formatted);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener turnos' });
    }
});

router.post('/', async (req, res) => {
    const { cliente_nombre, cliente_telefono, servicio_id, prestador_id, fecha, hora_inicio } = req.body;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const empresaId = req.user.id_empresa;

        // Validate blocked dates
        const [blockedRows] = await connection.execute(
            'SELECT id FROM BLOCKED_DATES WHERE id_empresa = ? AND fecha = ? AND (id_prestador = ? OR id_prestador IS NULL)',
            [empresaId, fecha, prestador_id]
        );

        if (blockedRows.length > 0) {
            return res.status(400).json({ error: 'El negocio no trabaja ese día.' });
        }

        // Upsert CLIENTE
        let phoneToSearch = cliente_telefono || `manual_${Date.now()}`;
        const [checkRows] = await connection.execute(
            'SELECT id_cliente, nombre_wa FROM CLIENTE WHERE id_empresa = ? AND whatsapp_id = ?',
            [empresaId, phoneToSearch]
        );

        let clienteId;
        if (checkRows.length > 0) {
            const existingName = (checkRows[0].nombre_wa || '').trim().toLowerCase();
            const newName = (cliente_nombre || '').trim().toLowerCase();
            
            if (existingName !== newName) {
                const fallbackPhone = `${phoneToSearch}_${Date.now()}`;
                const [insertRes] = await connection.execute(
                    'INSERT INTO CLIENTE (id_empresa, whatsapp_id, nombre_wa) VALUES (?, ?, ?)',
                    [empresaId, fallbackPhone, cliente_nombre]
                );
                clienteId = insertRes.insertId;
            } else {
                clienteId = checkRows[0].id_cliente;
            }
        } else {
            const [insertRes] = await connection.execute(
                'INSERT INTO CLIENTE (id_empresa, whatsapp_id, nombre_wa) VALUES (?, ?, ?)',
                [empresaId, phoneToSearch, cliente_nombre]
            );
            clienteId = insertRes.insertId;
        }

        const fullDate = `${fecha} ${hora_inicio}:00`;
        const includeOrigin = await hasTurnoOrigenColumn(connection);
        const turnoQuery = includeOrigin
            ? 'INSERT INTO TURNO (id_cliente, id_prestador, id_servicio, fecha_hora, estado, origen) VALUES (?, ?, ?, ?, ?, ?)'
            : 'INSERT INTO TURNO (id_cliente, id_prestador, id_servicio, fecha_hora, estado) VALUES (?, ?, ?, ?, ?)';
        const turnoParams = includeOrigin
            ? [clienteId, prestador_id, servicio_id, fullDate, 'confirmado', 'manual']
            : [clienteId, prestador_id, servicio_id, fullDate, 'confirmado'];
        const [turnoRes] = await connection.execute(turnoQuery, turnoParams);

        await connection.commit();
        res.status(201).json({ id_turno: turnoRes.insertId });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: 'Error al crear turno' });
    } finally {
        connection.release();
    }
});

router.put('/:id', async (req, res) => {
    const { estado } = req.body;

    try {
        const includeOrigin = await hasTurnoOrigenColumn();
        const [rows] = await pool.execute(
            `
            SELECT
                t.id_turno,
                t.estado,
                ${includeOrigin ? 't.origen AS turno_origen,' : 'NULL AS turno_origen,'}
                c.nombre_wa AS cliente_nombre,
                s.nombre AS servicio_nombre
            FROM TURNO t
            JOIN CLIENTE c ON c.id_cliente = t.id_cliente
            JOIN SERVICIO s ON s.id_servicio = t.id_servicio
            WHERE t.id_turno = ? AND c.id_empresa = ?
            LIMIT 1
            `,
            [req.params.id, req.user.id_empresa]
        );

        if (!rows.length) {
            return res.status(404).json({ error: 'Turno no encontrado' });
        }

        const appointment = rows[0];
        const resolvedChange = buildAppointmentStatusChange({
            currentStatus: appointment.estado,
            nextStatus: estado,
            currentOrigin: appointment.turno_origen,
        });

        if (resolvedChange.wasChanged) {
            const updateParams = [resolvedChange.currentStatus];
            let updateQuery = 'UPDATE TURNO SET estado = ?';

            if (includeOrigin && resolvedChange.nextOrigin !== appointment.turno_origen) {
                updateQuery += ', origen = ?';
                updateParams.push(resolvedChange.nextOrigin);
            }

            updateQuery += ' WHERE id_turno = ?';
            updateParams.push(req.params.id);

            await pool.execute(updateQuery, updateParams);
        }

        const notification = resolvedChange.wasChanged
            ? buildAppointmentMutationNotification({
                appointmentId: Number(appointment.id_turno),
                currentStatus: resolvedChange.currentStatus,
                currentOrigin: resolvedChange.nextOrigin,
                clienteNombre: appointment.cliente_nombre,
                servicioNombre: appointment.servicio_nombre,
            })
            : null;

        res.json({
            success: true,
            appointmentId: Number(appointment.id_turno),
            previousStatus: resolvedChange.previousStatus,
            currentStatus: resolvedChange.currentStatus,
            changeOrigin: resolvedChange.changeOrigin,
            changeReason: resolvedChange.changeReason,
            notification,
        });
    } catch (err) {
        const statusCode = Number(err?.statusCode || 500);
        res.status(statusCode).json({ error: err.message || 'Error al actualizar turno' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM TURNO WHERE id_turno = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al borrar turno' });
    }
});

module.exports = router;
module.exports.ALLOWED_STATUS_TRANSITIONS = ALLOWED_STATUS_TRANSITIONS;
module.exports.MANUAL_CONFIRMED_CANCELLATION_REASON = MANUAL_CONFIRMED_CANCELLATION_REASON;
module.exports.buildAppointmentStatusChange = buildAppointmentStatusChange;
