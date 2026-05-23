const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { hasClienteEmailColumn } = require('../services/clientSchema.service');
const { hasTurnoOrigenColumn, inferAppointmentOrigin } = require('../services/turnoSchema.service');
const { getRuntimeTimeZone } = require('../utils/runtimeTimezone');
const { addMinutes, DEFAULT_APPOINTMENT_DURATION_MINUTES } = require('../utils/appointmentOccupancy');
const { findOverlappingAppointmentWithSql } = require('../services/appointmentConflict.service');
const { buildAppointmentStatusChange } = require('./appointments.routes');
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

const resolveCompanyMiddleware = async (req, res, next) => {
    const slug = req.params.slug;
    if (!slug) {
        return res.status(400).json({ error: 'Slug requerido' });
    }
    try {
        const [rows] = await pool.execute('SELECT id_empresa, nombre_comercial FROM EMPRESA WHERE slug = ? LIMIT 1', [slug]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Empresa no encontrada' });
        }
        req.companyId = rows[0].id_empresa;
        next();
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al resolver la empresa' });
    }
};

router.use('/:slug', resolveCompanyMiddleware);

// --- Settings: Services, Professionals, Clients (para los dropdowns del dashboard) ---
router.get('/:slug/settings', async (req, res) => {
    try {
        const [services] = await pool.execute('SELECT id_servicio, nombre, duracion_minutos, precio FROM SERVICIO WHERE id_empresa = ? ORDER BY nombre ASC', [req.companyId]);
        const [professionals] = await pool.execute(
            `SELECT p.id_prestador, u.nombre, u.apellido 
             FROM PRESTADOR p 
             JOIN USUARIO u ON p.id_usuario = u.id_usuario 
             WHERE p.id_empresa = ? AND p.activo = 1`, 
            [req.companyId]
        );
        const [clients] = await pool.execute('SELECT id_cliente, nombre_wa, whatsapp_id FROM CLIENTE WHERE id_empresa = ? ORDER BY nombre_wa ASC', [req.companyId]);

        const [profServRows] = await pool.execute(
            `SELECT ps.id_prestador, ps.id_servicio 
             FROM PRESTADOR_SERVICIO ps
             JOIN PRESTADOR p ON ps.id_prestador = p.id_prestador
             WHERE p.id_empresa = ?`,
            [req.companyId]
        );

        const servicesByProf = {};
        for (const row of profServRows) {
            if (!servicesByProf[row.id_prestador]) {
                servicesByProf[row.id_prestador] = [];
            }
            servicesByProf[row.id_prestador].push(row.id_servicio);
        }

        res.json({
            services: services.map(s => ({ ...s, duracion_minutos: Number(s.duracion_minutos) })),
            professionals: professionals.map(p => ({
                id_prestador: p.id_prestador,
                nombre: p.nombre,
                apellido: p.apellido,
                servicios: servicesByProf[p.id_prestador] || []
            })),
            clients: clients.map(c => ({
                id_cliente: c.id_cliente,
                nombre: c.nombre_wa,
                telefono: c.whatsapp_id
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener configuraciones' });
    }
});

// --- Turnos: GET (Agenda) ---
router.get('/:slug/appointments', async (req, res) => {
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
        const [rows] = await pool.execute(query, [req.companyId]);

        const formatted = rows.map(appt => ({
            id: appt.id_turno,
            id_servicio: appt.id_servicio,
            id_prestador: appt.id_prestador,
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

// --- Turnos: POST (Crear) ---
router.post('/:slug/appointments', async (req, res) => {
    const { cliente_nombre, cliente_telefono, servicio_id, prestador_id, fecha, hora_inicio, force } = req.body;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const empresaId = req.companyId;

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

        if (!force) {
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

// --- Turnos: PUT (Modificar) ---
router.put('/:slug/appointments/:id', async (req, res) => {
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
            [req.params.id, req.companyId]
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

        res.json({
            success: true,
            appointmentId: Number(appointment.id_turno),
            previousStatus: appointment.estado,
            currentStatus: resolvedChange.currentStatus,
            hasChanges,
        });
    } catch (err) {
        await connection.rollback();
        const statusCode = Number(err?.statusCode || 500);
        res.status(statusCode).json({ error: err.message || 'Error al actualizar turno' });
    } finally {
        connection.release();
    }
});

// --- Turnos: DELETE (Borrar) ---
router.delete('/:slug/appointments/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM TURNO WHERE id_turno = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al borrar turno' });
    }
});

module.exports = router;
