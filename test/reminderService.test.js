const test = require("node:test");
const assert = require("node:assert/strict");

const {
  _private: { getReminderDueState, processSingleReminder },
} = require("../src/services/reminder.service");

const baseRow = {
  id_turno: 123,
  fecha_hora: "2026-05-22 20:30:00",
  cliente_nombre: "Nico",
  whatsapp_id: "5491111111111",
  id_empresa: 1,
  empresa_nombre: "Citax",
  config_recordatorios: {
    recordatorio_activo: true,
    recordatorio_offsets_minutos: [30],
    recordatorio_mensaje: "Turno {{hora}}",
  },
  instance_name: "citax-test",
};

test("reminder is not due three hours before the real UTC send time", () => {
  const state = getReminderDueState({
    appointmentDate: new Date("2026-05-22T20:30:00.000Z"),
    offset: 30,
    now: new Date("2026-05-22T17:00:00.000Z"),
  });

  assert.equal(state.due, false);
});

test("reminder is due after ideal time within grace window", () => {
  const state = getReminderDueState({
    appointmentDate: new Date("2026-05-22T20:30:00.000Z"),
    offset: 30,
    now: new Date("2026-05-22T20:02:00.000Z"),
  });

  assert.equal(state.due, true);
});

test("reminder does not send before ideal time", () => {
  const state = getReminderDueState({
    appointmentDate: new Date("2026-05-22T20:30:00.000Z"),
    offset: 30,
    now: new Date("2026-05-22T19:59:59.000Z"),
  });

  assert.equal(state.due, false);
});

test("processSingleReminder skips already recorded reminders before sending", async () => {
  const calls = [];
  const fakePool = {
    async execute(sql) {
      calls.push(sql);
      if (sql.startsWith("SELECT 1 FROM TURNO_RECORDATORIO")) {
        return [[{ 1: 1 }]];
      }
      return [{ affectedRows: 1 }];
    },
  };
  const sent = [];

  await processSingleReminder(baseRow, {
    now: new Date("2026-05-22T20:02:00.000Z"),
    poolClient: fakePool,
    sendMessage: async (...args) => sent.push(args),
  });

  assert.equal(sent.length, 0);
  assert.equal(calls.length, 1);
});
