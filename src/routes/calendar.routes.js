const express = require('express');
const router = express.Router();
const { generateCalendarIcs } = require('../services/calendar.service');
const logger = require('../utils/logger');

router.get('/:secretToken.ics', async (req, res) => {
  const { secretToken } = req.params;

  try {
    const result = await generateCalendarIcs(secretToken);

    if (!result) {
      return res.status(404).send('Calendario no encontrado');
    }

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="citax-${result.empresaName}.ics"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(result.icsContent);
  } catch (err) {
    logger.error({ err }, 'Error al generar calendario .ics');
    res.status(500).send('Error interno del servidor');
  }
});

module.exports = router;
