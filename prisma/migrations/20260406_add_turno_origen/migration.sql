ALTER TABLE TURNO
ADD COLUMN origen VARCHAR(50) NULL AFTER estado;

UPDATE TURNO
SET origen = 'pagina'
WHERE origen IS NULL
  AND estado = 'pendiente_confirmacion';

UPDATE TURNO
SET origen = 'whatsapp'
WHERE origen IS NULL
  AND estado IN ('pendiente', 'confirmado');

UPDATE TURNO
SET estado = 'confirmado'
WHERE estado = 'pendiente';
