import { formatDate, addDays, getToday } from "./time-format";

export function resolveStatsRange(range: string, tz?: string): { start: string; end: string; text: string } | null {
  const today = getToday(tz);

  switch (range) {
    case "last_7_days":
      return { start: formatDate(addDays(today, -6)), end: formatDate(today), text: "last 7 days" };

    case "last_30_days":
      return { start: formatDate(addDays(today, -29)), end: formatDate(today), text: "last 30 days" };

    case "last_6_months": {
      const sixMonthsAgo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 6, today.getUTCDate()));
      return { start: formatDate(sixMonthsAgo), end: formatDate(today), text: "last 6 months" };
    }

    case "last_year": {
      const oneYearAgo = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()));
      return { start: formatDate(oneYearAgo), end: formatDate(today), text: "last year" };
    }

    case "all_time":
      return { start: "1970-01-01", end: formatDate(today), text: "all time" };

    default:
      break;
  }

  // YYYY format (full year)
  if (/^\d{4}$/.test(range)) {
    const year = parseInt(range, 10);
    return {
      start: `${range}-01-01`,
      end: `${range}-12-31`,
      text: String(year),
    };
  }

  // YYYY-MM format (specific month)
  if (/^\d{4}-\d{2}$/.test(range)) {
    const [y, m] = range.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      start: `${range}-01`,
      end: `${range}-${String(lastDay).padStart(2, "0")}`,
      text: range,
    };
  }

  return null;
}
