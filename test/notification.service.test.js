const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NOTIFICATION_TYPES,
  buildBookingDescription,
  buildBookingNotificationContent,
  mapNotificationRow,
} = require("../src/services/notification.service");

test("buildBookingDescription composes the booking summary for inbox items", () => {
  const description = buildBookingDescription({
    clientName: "Valentin",
    serviceName: "Corte clasico",
    professionalName: "Paula Herrera",
    date: "2026-04-02",
    time: "15:30",
  });

  assert.equal(
    description,
    "Valentin - Corte clasico · 02/04/2026 15:30 · con Paula Herrera",
  );
});

test("buildBookingNotificationContent maps booking types to user-facing titles", () => {
  const content = buildBookingNotificationContent(
    NOTIFICATION_TYPES.BOOKING_CONFIRMED,
    {
      clientName: "Valentin",
      serviceName: "Corte clasico",
      date: "2026-04-02",
      time: "15:30",
    },
  );

  assert.equal(content.title, "Reserva confirmada");
  assert.match(content.description, /Valentin - Corte clasico/);
});

test("mapNotificationRow normalizes persisted rows for the frontend", () => {
  const notification = mapNotificationRow({
    id_notificacion: 17,
    tipo: NOTIFICATION_TYPES.NEW_BOOKING,
    titulo: "Nueva reserva",
    descripcion: "Cliente WhatsApp",
    created_at: new Date("2026-04-02T15:30:00Z"),
    read_at: null,
    appointment_id: 88,
    metadata: JSON.stringify({ source: "assistant" }),
  });

  assert.equal(notification.id, 17);
  assert.equal(notification.type, NOTIFICATION_TYPES.NEW_BOOKING);
  assert.equal(notification.affectsCalendar, true);
  assert.equal(notification.appointmentId, 88);
  assert.deepEqual(notification.metadata, { source: "assistant" });
});
