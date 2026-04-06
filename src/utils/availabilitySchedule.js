const pad = (value) => String(value).padStart(2, "0");

const formatTime = (value) => {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, 5);
};

const isNullishAvailability = (raw) => {
  if (raw === null || raw === undefined) return true;
  if (typeof raw !== "string") return false;

  const text = raw.trim().toLowerCase();
  return text === "" || text === "null";
};

const parseAvailability = (raw) => {
  if (isNullishAvailability(raw)) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
};

const normalizeActiveFlag = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["1", "true", "si", "sí", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  }

  return Boolean(value);
};

const normalizeAvailabilityItems = (raw) => {
  const parsed = parseAvailability(raw);
  const config = Array.isArray(parsed?.config) ? parsed.config : [];

  return config
    .map((item) => ({
      dia_semana: Number(item?.dia_semana),
      hora_desde: formatTime(item?.hora_desde),
      hora_hasta: formatTime(item?.hora_hasta),
      activo: normalizeActiveFlag(item?.activo) ? 1 : 0,
    }))
    .filter(
      (item) =>
        Number.isInteger(item.dia_semana) &&
        item.dia_semana >= 1 &&
        item.dia_semana <= 7 &&
        item.hora_desde &&
        item.hora_hasta &&
        item.hora_desde < item.hora_hasta &&
        item.activo
    );
};

const toAvailabilityPayload = (raw) => ({
  config: normalizeAvailabilityItems(raw),
});

const hasOwnAvailability = (raw) => !isNullishAvailability(raw);

const resolveEffectiveAvailability = ({ ownConfig, companyConfig }) => {
  if (hasOwnAvailability(ownConfig)) {
    return {
      scope: "prestador",
      source: "own",
      config: toAvailabilityPayload(ownConfig),
    };
  }

  return {
    scope: "prestador",
    source: "fallback_empresa",
    config: toAvailabilityPayload(companyConfig),
  };
};

const buildAvailabilityMap = (raw) => {
  const map = {};
  for (const item of normalizeAvailabilityItems(raw)) {
    const day = Number(item.dia_semana);
    if (!map[day]) map[day] = [];
    map[day].push({ start: item.hora_desde, end: item.hora_hasta });
  }
  return map;
};

const addDays = (dateStr, days) => {
  const date = new Date(`${dateStr}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const toWeekdayNumber = (dateStr) => {
  const weekday = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
};

const combineDateTime = (dateStr, timeStr) =>
  new Date(`${dateStr}T${timeStr}:00Z`);

const overlaps = (startA, endA, startB, endB) =>
  startA < endB && startB < endA;

module.exports = {
  addDays,
  buildAvailabilityMap,
  combineDateTime,
  formatTime,
  parseAvailability,
  hasOwnAvailability,
  isNullishAvailability,
  normalizeActiveFlag,
  normalizeAvailabilityItems,
  overlaps,
  pad,
  resolveEffectiveAvailability,
  toWeekdayNumber,
  toAvailabilityPayload,
};
