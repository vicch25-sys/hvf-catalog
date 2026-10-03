// Reject partial/oversized saved report ranges before building a table.
const DAY_MS = 86400000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function dateMillis(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return NaN;
  const date = new Date(`${value}T00:00:00Z`);
  const time = date.getTime();
  if (!Number.isFinite(time) || date.toISOString().slice(0, 10) !== value) return NaN;
  return time;
}

export function validateReportRange(from, to) {
  const start = dateMillis(from);
  const end = dateMillis(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Enter complete, valid start and end dates.";
  if (end < start) return "End date must be on or after the start date.";
  if ((end - start) / DAY_MS + 1 > 366) return "Choose a report range of 366 days or fewer.";
  return "";
}

// Calendar weekday lookup avoids constructing an Intl formatter for each cell.
export function weekdayName(value) {
  const time = dateMillis(value);
  return Number.isFinite(time) ? WEEKDAYS[new Date(time).getUTCDay()] : "";
}
