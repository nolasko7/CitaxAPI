const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAppointmentStatusChange,
  MANUAL_CONFIRMED_CANCELLATION_REASON,
} = require("../src/routes/appointments.routes");

test("buildAppointmentStatusChange allows confirmed to cancelled with manual cancellation reason", () => {
  const result = buildAppointmentStatusChange({
    currentStatus: "confirmado",
    nextStatus: "cancelado",
    currentOrigin: "whatsapp",
  });

  assert.equal(result.previousStatus, "confirmado");
  assert.equal(result.currentStatus, "cancelado");
  assert.equal(result.changeOrigin, "manual");
  assert.equal(
    result.changeReason,
    MANUAL_CONFIRMED_CANCELLATION_REASON,
  );
  assert.equal(result.nextOrigin, "whatsapp|manual_confirmed_cancellation");
  assert.equal(result.wasChanged, true);
});

test("buildAppointmentStatusChange keeps pending to cancelled without manual confirmed cancellation reason", () => {
  const result = buildAppointmentStatusChange({
    currentStatus: "pendiente",
    nextStatus: "cancelado",
    currentOrigin: "manual",
  });

  assert.equal(result.previousStatus, "pendiente");
  assert.equal(result.currentStatus, "cancelado");
  assert.equal(result.changeOrigin, "manual");
  assert.equal(result.changeReason, null);
  assert.equal(result.nextOrigin, "manual");
  assert.equal(result.wasChanged, true);
});

test("buildAppointmentStatusChange rejects invalid transitions", () => {
  assert.throws(
    () =>
      buildAppointmentStatusChange({
        currentStatus: "cancelado",
        nextStatus: "confirmado",
        currentOrigin: "whatsapp",
      }),
    /No se permite cambiar un turno de cancelado a confirmado\./,
  );
});
