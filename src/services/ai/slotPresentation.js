const DEFAULT_TIMEZONE = "America/Argentina/Buenos_Aires";

const normalizeDateOnly = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.slice(0, 10);
};

const daysBetween = (leftDate, rightDate) => {
  if (!leftDate || !rightDate) return null;
  const left = new Date(`${leftDate}T12:00:00Z`);
  const right = new Date(`${rightDate}T12:00:00Z`);
  return Math.round((left.getTime() - right.getTime()) / 86400000);
};

const formatWeekday = (dateStr, timezone = DEFAULT_TIMEZONE) =>
  new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    timeZone: timezone,
  }).format(new Date(`${dateStr}T12:00:00Z`));

const formatDayOfMonth = (dateStr, timezone = DEFAULT_TIMEZONE) =>
  new Intl.DateTimeFormat("es-AR", {
    day: "numeric",
    timeZone: timezone,
  }).format(new Date(`${dateStr}T12:00:00Z`));

const formatNaturalDate = ({
  date,
  referenceDate,
  timezone = DEFAULT_TIMEZONE,
}) => {
  const normalizedDate = normalizeDateOnly(date);
  const normalizedReference = normalizeDateOnly(referenceDate);
  const weekday = formatWeekday(normalizedDate, timezone);
  const day = formatDayOfMonth(normalizedDate, timezone);
  const diff = daysBetween(normalizedDate, normalizedReference);

  if (diff === 0) return `hoy ${weekday} ${day}`;
  if (diff === 1) return `ma\u00f1ana ${weekday} ${day}`;
  return `${weekday} ${day}`;
};

const compactTime = (time) => {
  const raw = String(time || "").trim();
  if (!raw) return "";
  return raw.endsWith(":00") ? String(Number(raw.slice(0, 2))) : raw;
};

const timeToMinutes = (time) => {
  const raw = String(time || "").trim();
  if (!/^\d{2}:\d{2}$/.test(raw)) return null;

  const [hours, minutes] = raw.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;

  return hours * 60 + minutes;
};

const joinHumanList = (items) => {
  const visibleItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!visibleItems.length) return "";
  if (visibleItems.length === 1) return visibleItems[0];
  if (visibleItems.length === 2) return `${visibleItems[0]} y ${visibleItems[1]}`;
  return `${visibleItems.slice(0, -1).join(", ")} y ${visibleItems[visibleItems.length - 1]}`;
};

const buildContiguousRanges = (times) => {
  const normalizedTimes = [...new Set((Array.isArray(times) ? times : []).filter(Boolean))].sort();
  if (!normalizedTimes.length) return [];
  if (normalizedTimes.length === 1) {
    return [{ start: normalizedTimes[0], end: normalizedTimes[0], times: normalizedTimes }];
  }

  const minuteValues = normalizedTimes.map(timeToMinutes).filter((value) => value != null);
  const diffs = [];
  for (let index = 1; index < minuteValues.length; index += 1) {
    const diff = minuteValues[index] - minuteValues[index - 1];
    if (diff > 0) diffs.push(diff);
  }

  const baseStep = diffs.length ? Math.min(...diffs) : 30;
  const ranges = [];
  let currentTimes = [normalizedTimes[0]];
  let previousMinutes = minuteValues[0];

  for (let index = 1; index < normalizedTimes.length; index += 1) {
    const currentMinutes = minuteValues[index];
    const diff = currentMinutes - previousMinutes;

    if (diff > baseStep) {
      ranges.push({
        start: currentTimes[0],
        end: currentTimes[currentTimes.length - 1],
        times: currentTimes,
      });
      currentTimes = [normalizedTimes[index]];
    } else {
      currentTimes.push(normalizedTimes[index]);
    }

    previousMinutes = currentMinutes;
  }

  ranges.push({
    start: currentTimes[0],
    end: currentTimes[currentTimes.length - 1],
    times: currentTimes,
  });

  return ranges;
};

const buildTimeDisplay = (times) => {
  if (!Array.isArray(times) || !times.length) {
    return { mode: "empty", text: "", ranges: [] };
  }

  const ranges = buildContiguousRanges(times);

  if (times.length <= 4) {
    return {
      mode: "list",
      text: times.join(", "),
      ranges,
    };
  }

  if (ranges.length > 1) {
    return {
      mode: "multi_range",
      text: joinHumanList(
        ranges.map(
          (range) => `de ${compactTime(range.start)} a ${compactTime(range.end)}`
        )
      ),
      ranges,
    };
  }

  return {
    mode: "range",
    text: `de ${compactTime(times[0])} a ${compactTime(times[times.length - 1])}`,
    ranges,
  };
};

const prioritizeOwnScheduleSlots = (slots) => {
  const normalizedSlots = Array.isArray(slots) ? slots : [];
  const hasOwnSlots = normalizedSlots.some(
    (slot) => String(slot?.scheduleSource || "").trim() === "own"
  );

  if (!hasOwnSlots) {
    return normalizedSlots;
  }

  return normalizedSlots.filter(
    (slot) => String(slot?.scheduleSource || "").trim() === "own"
  );
};

const summarizeAvailableSlotsForAssistant = ({
  slots,
  referenceDate,
  timezone = DEFAULT_TIMEZONE,
}) => {
  const visibleSlots = prioritizeOwnScheduleSlots(slots);
  const groups = new Map();

  for (const slot of visibleSlots) {
    const professionalId = Number(slot.professionalId || 0);
    const date = normalizeDateOnly(slot.date);
    const key = `${professionalId}:${date}`;

    if (!groups.has(key)) {
      groups.set(key, {
        professionalId,
        professionalName: slot.professionalName,
        date,
        humanDate: formatNaturalDate({ date, referenceDate, timezone }),
        scheduleSource: slot.scheduleSource || "unknown",
        times: [],
      });
    }

    groups.get(key).times.push(String(slot.time || "").slice(0, 5));
  }

  return [...groups.values()]
    .map((group) => {
      const times = [...new Set(group.times)].sort();
      const display = buildTimeDisplay(times);

      return {
        ...group,
        times,
        slotCount: times.length,
        displayMode: display.mode,
        displayText: display.text,
        displayRanges: display.ranges,
        firstTime: times[0] || "",
        lastTime: times[times.length - 1] || "",
      };
    })
    .sort((left, right) => {
      if (left.date !== right.date) return left.date.localeCompare(right.date);
      return left.professionalName.localeCompare(right.professionalName);
    });
};

module.exports = {
  compactTime,
  formatNaturalDate,
  prioritizeOwnScheduleSlots,
  summarizeAvailableSlotsForAssistant,
};
