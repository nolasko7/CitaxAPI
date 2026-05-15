const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatStoredTimeKey,
  toComparableAppointmentDate,
} = require("../src/utils/appointmentDateInterop");

test("manual appointments keep local clock time when normalized from Prisma dates", () => {
  const storedPrismaDate = new Date("2026-05-16T13:00:00.000Z");
  const comparable = toComparableAppointmentDate({
    fecha_hora: storedPrismaDate,
    origen: "manual",
  });

  assert.equal(
    formatStoredTimeKey({
      fecha_hora: storedPrismaDate,
      origen: "manual",
      timezone: "America/Argentina/Buenos_Aires",
    }),
    "13:00",
  );
  assert.equal(comparable.toISOString(), "2026-05-16T16:00:00.000Z");
});

test("whatsapp appointments preserve current UTC-based interpretation", () => {
  const storedPrismaDate = new Date("2026-05-16T16:00:00.000Z");

  assert.equal(
    formatStoredTimeKey({
      fecha_hora: storedPrismaDate,
      origen: "whatsapp",
      timezone: "America/Argentina/Buenos_Aires",
    }),
    "13:00",
  );
});
