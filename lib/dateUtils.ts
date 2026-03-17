const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || "Europe/Madrid";

export function getTimezone() {
  return DEFAULT_TIMEZONE;
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatDisplayDate(isoDate: string) {
  if (!isoDate) {
    return "";
  }

  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }

  return `${match[3]}/${match[2]}/${match[1]}`;
}

export function addDays(date: string, days: number) {
  const base = new Date(`${date}T00:00:00`);
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

export function tomorrowIsoDate() {
  return addDays(new Date().toISOString().slice(0, 10), 1);
}

export function makeDateTime(date: string, time: string) {
  return {
    dateTime: `${date}T${time || "10:00"}:00`,
    timeZone: getTimezone()
  };
}
