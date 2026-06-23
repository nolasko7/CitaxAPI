const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');
const { hasClienteEmailColumn } = require('../services/clientSchema.service');
const { hasTurnoOrigenColumn, inferAppointmentOrigin, parseTurnoOrigin, buildTurnoOrigin } = require('../services/turnoSchema.service');
const { mapTurnoToNotification } = require('./notifications.routes');
const { getRuntimeTimeZone } = require('../utils/runtimeTimezone');
const { addMinutes, DEFAULT_APPOINTMENT_DURATION_MINUTES } = require('../utils/appointmentOccupancy');
const { findOverlappingAppointmentWithSql } = require('../services/appointmentConflict.service');
const {
    buildStoredAppointmentDate,
    buildStoredAppointmentDateTime,
    toComparableAppointmentDate,
} = require('../utils/appointmentDateInterop');

const APP_TIMEZONE = getRuntimeTimeZone();

const formatDateLocal = (value) => {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: APP_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(toComparableAppointmentDate({ fecha_hora: value }));
};

const formatTimeLocal = (value) => {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: APP_TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(toComparableAppointmentDate({ fecha_hora: value }));
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

        // Paginación por rango de fechas (default: ±30 días desde hoy)
        const now = new Date();
        const defaultDesde = new Date(now);
        defaultDesde.setDate(defaultDesde.getDate() - 30);
        const defaultHasta = new Date(now);
        defaultHasta.setDate(defaultHasta.getDate() + 30);

        const desde = req.query.desde || defaultDesde.toISOString().slice(0, 10);
        const hasta = req.query.hasta || defaultHasta.toISOString().slice(0, 10);

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
              AND t.fecha_hora >= ? AND t.fecha_hora <= ?
            ORDER BY t.fecha_hora ASC
        `;
        const [rows] = await pool.execute(query, [
            req.user.id_empresa,
            `${desde} 00:00:00`,
            `${hasta} 23:59:59`,
        ]);

        const formatted = rows.map(appt => {
            const rawOrigin = inferAppointmentOrigin({ origen: appt.turno_origen, estado: appt.estado });
            const clientName = appt.nombre_wa || 'Sin nombre';
            const displayName = rawOrigin === 'fijo' ? `(Fijo) ${clientName}` : clientName;

            return {
                id: appt.id_turno,
                id_servicio: appt.id_servicio,
                id_prestador: appt.id_prestador,
                fecha: formatDateLocal(appt.fecha_hora),
                hora_inicio: formatTimeLocal(appt.fecha_hora),
                estado: appt.estado,
                origen: rawOrigin,
                cliente_nombre: displayName,
                cliente_whatsapp: appt.whatsapp_id.startsWith('manual_') ? '' : (appt.whatsapp_id.includes('_') ? appt.whatsapp_id.split('_')[0] : appt.whatsapp_id),
                cliente_email: appt.cliente_email || '',
                prestador_nombre: appt.prestador_nombre,
                prestador_apellido: appt.prestador_apellido,
                servicio_nombre: appt.servicio_nombre
            };
        });

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

        const requestedStart = buildStoredAppointmentDate({ date: fecha, time: hora_inicio, timezone: APP_TIMEZONE });
        const fullDate = buildStoredAppointmentDateTime({ date: fecha, time: hora_inicio, timezone: APP_TIMEZONE });
        const [serviceRows] = await connection.execute(
            'SELECT id_servicio, duracion_minutos FROM SERVICIO WHERE id_servicio = ? LIMIT 1',
            [servicio_id]
        );

        if (!serviceRows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Servicio no encontrado.' });
        }

        const requestedEnd = addMinutes(
            requestedStart,
            serviceRows[0].duracion_minutos || DEFAULT_APPOINTMENT_DURATION_MINUTES
        );

        const conflict = await findOverlappingAppointmentWithSql({
            executor: connection,
            companyId: empresaId,
            professionalId: prestador_id,
            start: requestedStart,
            end: requestedEnd,
        });

        if (conflict) {
            await connection.rollback();
            return res.status(409).json({ error: 'Ese horario ya no esta disponible.' });
        }

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
    const { estado, servicio_id, prestador_id, fecha, hora_inicio, cliente_nombre, cliente_telefono, force } = req.body;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const includeOrigin = await hasTurnoOrigenColumn(connection);
        
        const [rows] = await connection.execute(
            `
            SELECT
                t.id_turno,
                t.estado,
                t.id_servicio,
                t.id_prestador,
                t.fecha_hora,
                t.id_cliente,
                ${includeOrigin ? 't.origen AS turno_origen,' : 'NULL AS turno_origen,'}
                c.id_empresa,
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
            await connection.rollback();
            return res.status(404).json({ error: 'Turno no encontrado' });
        }

        const appointment = rows[0];
        let hasChanges = false;
        const updateFields = [];
        const updateParams = [];

        // Handle Client Info Changes
        if (cliente_nombre !== undefined) {
            await connection.execute(
                'UPDATE CLIENTE SET nombre_wa = ? WHERE id_cliente = ?',
                [cliente_nombre, appointment.id_cliente]
            );
        }
        if (cliente_telefono !== undefined) {
            await connection.execute(
                'UPDATE CLIENTE SET whatsapp_id = ? WHERE id_cliente = ?',
                [cliente_telefono, appointment.id_cliente]
            );
        }

        // Handle Status Change
        let resolvedChange = { wasChanged: false, currentStatus: appointment.estado, nextOrigin: appointment.turno_origen };
        if (estado && estado !== appointment.estado) {
            resolvedChange = buildAppointmentStatusChange({
                currentStatus: appointment.estado,
                nextStatus: estado,
                currentOrigin: appointment.turno_origen,
            });

            if (resolvedChange.wasChanged) {
                updateFields.push('estado = ?');
                updateParams.push(resolvedChange.currentStatus);
                
                if (includeOrigin && resolvedChange.nextOrigin !== appointment.turno_origen) {
                    updateFields.push('origen = ?');
                    updateParams.push(resolvedChange.nextOrigin);
                }
                hasChanges = true;
            }
        }

        // Handle Detail Changes (service, professional, date/time)
        const nextServiceId = servicio_id ? Number(servicio_id) : appointment.id_servicio;
        const nextPrestadorId = prestador_id ? Number(prestador_id) : appointment.id_prestador;
        
        let nextFechaHora = appointment.fecha_hora;
        let nextFechaHoraDate = toComparableAppointmentDate(appointment);
        if (fecha && hora_inicio) {
            nextFechaHoraDate = buildStoredAppointmentDate({ date: fecha, time: hora_inicio, timezone: APP_TIMEZONE });
            nextFechaHora = buildStoredAppointmentDateTime({ date: fecha, time: hora_inicio, timezone: APP_TIMEZONE });
        }

        const detailsChanged = 
            nextServiceId !== appointment.id_servicio || 
            nextPrestadorId !== appointment.id_prestador || 
            (fecha && hora_inicio && nextFechaHoraDate.getTime() !== toComparableAppointmentDate(appointment).getTime());

        if (detailsChanged) {
            const [serviceRows] = await connection.execute(
                'SELECT id_servicio, duracion_minutos FROM SERVICIO WHERE id_servicio = ? LIMIT 1',
                [nextServiceId]
            );

            if (!serviceRows.length) {
                await connection.rollback();
                return res.status(404).json({ error: 'Servicio no encontrado.' });
            }

            if (!force) {
                const targetDate = fecha || formatDateLocal(appointment.fecha_hora);
                const [blockedRows] = await connection.execute(
                    'SELECT id FROM BLOCKED_DATES WHERE id_empresa = ? AND fecha = ? AND (id_prestador = ? OR id_prestador IS NULL)',
                    [appointment.id_empresa, targetDate, nextPrestadorId]
                );

                if (blockedRows.length > 0) {
                    await connection.rollback();
                    return res.status(400).json({ error: 'El negocio no trabaja ese día.' });
                }

                const requestedStart = nextFechaHoraDate;
                const requestedEnd = addMinutes(
                    requestedStart,
                    serviceRows[0].duracion_minutos || DEFAULT_APPOINTMENT_DURATION_MINUTES
                );

                const conflict = await findOverlappingAppointmentWithSql({
                    executor: connection,
                    companyId: appointment.id_empresa,
                    professionalId: nextPrestadorId,
                    start: requestedStart,
                    end: requestedEnd,
                    excludeAppointmentId: appointment.id_turno
                });

                if (conflict) {
                    await connection.rollback();
                    return res.status(409).json({ error: 'CONFICT_DETECTED', message: 'Ese horario ya no esta disponible para el profesional seleccionado.' });
                }
            }

            if (nextServiceId !== appointment.id_servicio) {
                updateFields.push('id_servicio = ?');
                updateParams.push(nextServiceId);
            }
            if (nextPrestadorId !== appointment.id_prestador) {
                updateFields.push('id_prestador = ?');
                updateParams.push(nextPrestadorId);
            }
            if (nextFechaHora !== appointment.fecha_hora) {
                updateFields.push('fecha_hora = ?');
                updateParams.push(nextFechaHora);
            }
            hasChanges = true;
        }

        if (hasChanges) {
            const updateQuery = `UPDATE TURNO SET ${updateFields.join(', ')} WHERE id_turno = ?`;
            updateParams.push(req.params.id);
            await connection.execute(updateQuery, updateParams);
        }

        await connection.commit();

        const notification = resolvedChange.wasChanged
            ? buildAppointmentMutationNotification({
                appointmentId: Number(appointment.id_turno),
                currentStatus: resolvedChange.currentStatus,
                currentOrigin: resolvedChange.nextOrigin,
                clienteNombre: cliente_nombre || appointment.cliente_nombre,
                servicioNombre: appointment.servicio_nombre,
            })
            : null;

        res.json({
            success: true,
            appointmentId: Number(appointment.id_turno),
            previousStatus: appointment.estado,
            currentStatus: resolvedChange.currentStatus,
            hasChanges,
            notification,
        });
    } catch (err) {
        await connection.rollback();
        const statusCode = Number(err?.statusCode || 500);
        res.status(statusCode).json({ error: err.message || 'Error al actualizar turno' });
    } finally {
        connection.release();
    }
});

router.delete('/:id', async (req, res) => {
    try {
        // Verificar que el turno pertenece a la empresa del usuario autenticado
        const [rows] = await pool.execute(
            `SELECT t.id_turno FROM TURNO t
             JOIN CLIENTE c ON t.id_cliente = c.id_cliente
             WHERE t.id_turno = ? AND c.id_empresa = ?`,
            [req.params.id, req.user.id_empresa]
        );
        if (!rows.length) {
            return res.status(404).json({ error: 'Turno no encontrado' });
        }
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
