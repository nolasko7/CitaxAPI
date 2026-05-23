const pad = (value) => String(value).padStart(2, "0");

const normalizeOrigin = (origin) => String(origin || "").trim().toLowerCase();

const DEFAULT_TIMEZONE = "America/Argentina/Buenos_Aires";

const formatUtcSqlDateTime = (date) =>
  date.toISOString().slice(0, 19).replace("T", " ");

const parseSqlDateTimeAsUtc = (value) => {
  const text = String(value || "").trim();
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!match) return new Date(value || Date.now());

  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0),
    ),
  );
};

const getTimeZoneParts = (date, timezone = DEFAULT_TIMEZONE) => {
  const parts = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  })
    .formatToParts(date)
    .forEach((part) => {
      if (part.type !== "literal") parts[part.type] = part.value;
    });

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
};

const zonedDateTimeToUtcDate = ({
  date,
  time,
  timezone = DEFAULT_TIMEZONE,
}) => {
  const [year, month, day] = String(date || "")
    .split("-")
    .map(Number);
  const [hour, minute, second = 0] = String(time || "")
    .split(":")
    .map(Number);

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const actualParts = getTimeZoneParts(utcGuess, timezone);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const actualAsUtc = Date.UTC(
    actualParts.year,
    actualParts.month - 1,
    actualParts.day,
    actualParts.hour,
    actualParts.minute,
    actualParts.second,
  );

  return new Date(utcGuess.getTime() + (targetAsUtc - actualAsUtc));
};

const buildStoredAppointmentDate = ({
  date,
  time,
  timezone = DEFAULT_TIMEZONE,
}) => zonedDateTimeToUtcDate({ date, time, timezone });

const buildStoredAppointmentDateTime = ({
  date,
  time,
  timezone = DEFAULT_TIMEZONE,
}) => formatUtcSqlDateTime(buildStoredAppointmentDate({ date, time, timezone }));

const buildUtcDayBoundsForTimezone = (
  date,
  timezone = DEFAULT_TIMEZONE,
  end = date,
) => ({
  dayStart: buildStoredAppointmentDate({
    date,
    time: "00:00:00",
    timezone,
  }),
  dayEnd: buildStoredAppointmentDate({
    date: end,
    time: "23:59:59",
    timezone,
  }),
});

const toComparableAppointmentDate = ({ fecha_hora }) => {
  if (fecha_hora instanceof Date) return new Date(fecha_hora.getTime());
  return parseSqlDateTimeAsUtc(fecha_hora);
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
  buildStoredAppointmentDate,
  buildStoredAppointmentDateTime,
  buildLocalClockDateKey,
  buildUtcDayBoundsForTimezone,
  formatUtcSqlDateTime,
  formatStoredDateKey,
  formatStoredTimeKey,
  normalizeOrigin,
  parseSqlDateTimeAsUtc,
  toComparableAppointmentDate,
  zonedDateTimeToUtcDate,
};
