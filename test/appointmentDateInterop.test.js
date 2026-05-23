const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildStoredAppointmentDateTime,
  formatStoredTimeKey,
  toComparableAppointmentDate,
} = require("../src/utils/appointmentDateInterop");

test("stored UTC datetime renders as Argentina local clock time", () => {
  const storedPrismaDate = new Date("2026-05-22T20:30:00.000Z");
  const comparable = toComparableAppointmentDate({
    fecha_hora: storedPrismaDate,
  });

  assert.equal(
    formatStoredTimeKey({
      fecha_hora: storedPrismaDate,
      timezone: "America/Argentina/Buenos_Aires",
    }),
    "17:30",
  );
  assert.equal(comparable.toISOString(), "2026-05-22T20:30:00.000Z");
});

test("local Argentina appointment input is stored as UTC literal datetime", () => {
  assert.equal(
    buildStoredAppointmentDateTime({
      date: "2026-05-22",
      time: "17:30",
      timezone: "America/Argentina/Buenos_Aires",
    }),
    "2026-05-22 20:30:00",
  );
});

test("SQL datetime strings are parsed as UTC, not process local time", () => {
  const comparable = toComparableAppointmentDate({
    fecha_hora: "2026-05-22 20:30:00",
  });

  assert.equal(comparable.toISOString(), "2026-05-22T20:30:00.000Z");
});
