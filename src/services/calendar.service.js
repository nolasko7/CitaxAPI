const ics = require('ics');
const prisma = require('../config/prisma');
const logger = require('../utils/logger');

const VALID_ESTADOS = ['pendiente', 'confirmado'];

function mapTurnoToEvent(turno) {
  const d = new Date(turno.fecha_hora);
  const prestadorNombre = turno.PRESTADOR?.USUARIO?.nombre;
  const clienteNombre = turno.CLIENTE?.nombre_wa;
  const servicioNombre = turno.SERVICIO?.nombre;
  return {
    title: `${clienteNombre || 'Cliente'} - ${servicioNombre || 'Turno'}`,
    description: [
      `Cliente: ${clienteNombre || 'N/A'}`,
      `Servicio: ${servicioNombre || 'N/A'}`,
      `Prestador: ${prestadorNombre || 'N/A'}`,
      `Origen: ${turno.origen || 'manual'}`,
    ].join('\n'),
    start: [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()],
    duration: { minutes: turno.SERVICIO?.duracion_minutos || 60 },
    startInputType: 'utc',
    startOutputType: 'utc',
  };
}

async function generateCalendarIcs(token) {
  const empresa = await prisma.EMPRESA.findUnique({
    where: { calendar_token: token },
    select: { id_empresa: true, nombre_comercial: true },
  });

  if (!empresa) {
    return null;
  }

  const unMesAtras = new Date();
  unMesAtras.setMonth(unMesAtras.getMonth() - 1);
  const seisMesesAdelante = new Date();
  seisMesesAdelante.setMonth(seisMesesAdelante.getMonth() + 6);

  const turnos = await prisma.TURNO.findMany({
    where: {
      PRESTADOR: {
        EMPRESA: { id_empresa: empresa.id_empresa },
      },
      estado: { in: VALID_ESTADOS },
      fecha_hora: {
        gte: unMesAtras,
        lte: seisMesesAdelante,
      },
    },
    include: {
      CLIENTE: { select: { nombre_wa: true } },
      SERVICIO: { select: { nombre: true, duracion_minutos: true } },
      PRESTADOR: {
        select: {
          USUARIO: { select: { nombre: true } },
        },
      },
    },
    orderBy: { fecha_hora: 'asc' },
  });

  const eventos = turnos.map(mapTurnoToEvent);

  return new Promise((resolve, reject) => {
    ics.createEvents(eventos, (error, value) => {
      if (error) {
        logger.error({ err: error, token }, 'Error al generar .ics');
        reject(error);
        return;
      }
      resolve({ icsContent: value, empresaName: empresa.nombre_comercial });
    });
  });
}

async function getCalendarInfo(empresaId, backendPublicUrl) {
  const empresa = await prisma.EMPRESA.findUnique({
    where: { id_empresa: empresaId },
    select: { calendar_token: true, nombre_comercial: true },
  });

  if (!empresa || !empresa.calendar_token) {
    return { url: null, token: null };
  }

  const baseUrl = (backendPublicUrl || '').replace(/\/+$/, '');
  const url = `${baseUrl}/api/calendars/${empresa.calendar_token}.ics`;

  return { url, token: empresa.calendar_token };
}

async function regenerateCalendarToken(empresaId) {
  const { randomUUID } = require('crypto');
  const newToken = randomUUID();

  await prisma.EMPRESA.update({
    where: { id_empresa: empresaId },
    data: { calendar_token: newToken },
  });

  return newToken;
}

module.exports = {
  generateCalendarIcs,
  getCalendarInfo,
  regenerateCalendarToken,
};
