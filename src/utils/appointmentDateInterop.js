const LEGACY_LOCAL_CLOCK_ORIGINS = new Set(["manual", "pagina"]);

const pad = (value) => String(value).padStart(2, "0");

const normalizeOrigin = (origin) => String(origin || "").trim().toLowerCase();

const usesLegacyLocalClockStorage = (origin) =>
  LEGACY_LOCAL_CLOCK_ORIGINS.has(normalizeOrigin(origin));

const toComparableAppointmentDate = ({ fecha_hora, origen }) => {
  const input =
    fecha_hora instanceof Date ? fecha_hora : new Date(fecha_hora || Date.now());

  if (Number.isNaN(input.getTime())) {
    return input;
  }

  return new Date(input);
};

const formatComparableDateKey = (appointmentDate, timezone) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(appointmentDate);

const formatStoredDateKey = ({ fecha_hora, origen, timezone }) =>
  formatComparableDateKey(
    toComparableAppointmentDate({ fecha_hora, origen }),
    timezone,
  );

const formatStoredTimeKey = ({ fecha_hora, origen, timezone }) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(toComparableAppointmentDate({ fecha_hora, origen }));

const buildLocalClockDateKey = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

module.exports = {
  buildLocalClockDateKey,
  formatStoredDateKey,
  formatStoredTimeKey,
  normalizeOrigin,
  toComparableAppointmentDate,
  usesLegacyLocalClockStorage,
};
