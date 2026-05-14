-- Migración: normalizar turnos creados por AI/WhatsApp
-- 
-- Contexto: los turnos con origen 'whatsapp' fueron creados por Prisma
-- a partir de un Date UTC (new Date("...T...:00Z")), por lo que
-- el DATETIME almacenado representa horario UTC, no ART.
--
-- Después de unificar timezone a -03:00 en Prisma + db.js + TZ del servidor,
-- estos turnos deben restar 3h para que el DATETIME represente ART.
--
-- Ejemplo:
--   AI guardó '2026-05-14 14:30:00' (intención: 11:30 ART)
--   → se lee como 14:30 ART (incorrecto, +3h)
--   → resta: '2026-05-14 11:30:00' → se lee como 11:30 ART ✓
--
-- Manual/página guardaron '2026-05-14 14:30:00' (intención: 14:30 ART)
--   → no se modifican (están correctos como ART)

BEGIN;

UPDATE TURNO
SET fecha_hora = DATE_SUB(fecha_hora, INTERVAL 3 HOUR)
WHERE origen = 'whatsapp';

COMMIT;
