export function getCalendarUrl() {
  const explicitUrl = process.env.GOOGLE_CALENDAR_URL?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const calendarId = process.env.GOOGLE_CALENDAR_ID?.trim();
  if (!calendarId) {
    return "";
  }

  return `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(calendarId)}`;
}
