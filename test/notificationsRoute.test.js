const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapTurnoToNotification,
  NOTIFICATION_TYPES,
} = require("../src/routes/notifications.routes");

test("mapTurnoToNotification maps manual confirmed cancellation separately", () => {
  const notification = mapTurnoToNotification({
    estado: "cancelado",
    turno_origen: "whatsapp|manual_confirmed_cancellation",
    cliente_nombre: "Juan Perez",
    servicio_nombre: "Corte",
  });

  assert.equal(
    notification.type,
    NOTIFICATION_TYPES.MANUAL_CONFIRMED_CANCELLATION,
  );
  assert.match(notification.description, /cancelo manualmente/i);
});

test("mapTurnoToNotification keeps general cancelled notification for other cancellations", () => {
  const notification = mapTurnoToNotification({
    estado: "cancelado",
    turno_origen: "whatsapp",
    cliente_nombre: "Juan Perez",
    servicio_nombre: "Corte",
  });

  assert.equal(notification.type, NOTIFICATION_TYPES.BOOKING_CANCELLED);
});
