import { describe, expect, it } from "vitest";
import {
  formatDigital,
  formatHumanReadable,
  getDateForTimestamp,
  getEpochBoundsForDate,
  getHourForTimestamp,
  isValidTimezone,
} from "../../src/utils/time-format";

describe("isValidTimezone", () => {
  it("accepts known IANA zones", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Asia/Tokyo")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
  });

  it("rejects nonsense values", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("not a tz")).toBe(false);
  });
});

describe("getDateForTimestamp", () => {
  it("returns YYYY-MM-DD in UTC when no timezone is given", () => {
    // 2026-03-14 16:00 UTC
    const epoch = Date.UTC(2026, 2, 14, 16, 0, 0) / 1000;
    expect(getDateForTimestamp(epoch)).toBe("2026-03-14");
  });

  it("buckets across the UTC day boundary into the user's local date — Asia/Tokyo", () => {
    // 2026-03-13 23:30 UTC = 2026-03-14 08:30 JST (UTC+9)
    const epoch = Date.UTC(2026, 2, 13, 23, 30, 0) / 1000;
    expect(getDateForTimestamp(epoch, "Asia/Tokyo")).toBe("2026-03-14");
    expect(getDateForTimestamp(epoch, "UTC")).toBe("2026-03-13");
  });

  it("buckets across the UTC day boundary into the user's local date — America/New_York", () => {
    // 2026-03-14 02:00 UTC = 2026-03-13 22:00 EDT (UTC-4)
    const epoch = Date.UTC(2026, 2, 14, 2, 0, 0) / 1000;
    expect(getDateForTimestamp(epoch, "America/New_York")).toBe("2026-03-13");
  });

  it("falls back to UTC when the timezone is unknown", () => {
    const epoch = Date.UTC(2026, 2, 14, 12, 0, 0) / 1000;
    expect(getDateForTimestamp(epoch, "Mars/Olympus")).toBe("2026-03-14");
  });
});

describe("getHourForTimestamp", () => {
  it("returns the UTC hour (0-23) when no timezone is given", () => {
    expect(getHourForTimestamp(Date.UTC(2026, 2, 14, 0, 30, 0) / 1000)).toBe(0);
    expect(getHourForTimestamp(Date.UTC(2026, 2, 14, 9, 0, 0) / 1000)).toBe(9);
    expect(getHourForTimestamp(Date.UTC(2026, 2, 14, 23, 59, 0) / 1000)).toBe(23);
  });

  it("shifts the hour into the user's timezone — Asia/Tokyo (UTC+9)", () => {
    // 2026-03-13 23:30 UTC = 2026-03-14 08:30 JST
    const epoch = Date.UTC(2026, 2, 13, 23, 30, 0) / 1000;
    expect(getHourForTimestamp(epoch, "Asia/Tokyo")).toBe(8);
    expect(getHourForTimestamp(epoch, "UTC")).toBe(23);
  });

  it("shifts the hour for a negative-offset timezone — America/New_York", () => {
    // 2026-03-14 02:00 UTC = 2026-03-13 22:00 EDT (UTC-4 in March, post spring-forward)
    const epoch = Date.UTC(2026, 2, 14, 2, 0, 0) / 1000;
    expect(getHourForTimestamp(epoch, "America/New_York")).toBe(22);
  });

  it("reflects the local hour right after a DST spring-forward", () => {
    // 2026-03-08 07:30 UTC. New York springs forward at 02:00->03:00 local;
    // by 07:30 UTC the offset is -4, so local time is 03:30 -> hour 3.
    const epoch = Date.UTC(2026, 2, 8, 7, 30, 0) / 1000;
    expect(getHourForTimestamp(epoch, "America/New_York")).toBe(3);
  });

  it("falls back to the UTC hour when the timezone is unknown", () => {
    const epoch = Date.UTC(2026, 2, 14, 15, 0, 0) / 1000;
    expect(getHourForTimestamp(epoch, "Mars/Olympus")).toBe(15);
  });
});

describe("getEpochBoundsForDate", () => {
  it("returns 24-hour bounds for a UTC day", () => {
    const { start, end } = getEpochBoundsForDate("2026-03-14", "UTC");
    expect(end - start).toBe(86400);
    expect(start).toBe(Date.UTC(2026, 2, 14) / 1000);
  });

  it("computes JST midnight bounds shifted 9 hours earlier than UTC", () => {
    const { start, end } = getEpochBoundsForDate("2026-03-14", "Asia/Tokyo");
    expect(end - start).toBe(86400);
    // JST midnight of 2026-03-14 == 2026-03-13 15:00 UTC
    expect(start).toBe(Date.UTC(2026, 2, 13, 15, 0, 0) / 1000);
  });

  it("returns a 23-hour day across the US spring-forward DST transition", () => {
    // America/New_York 2026-03-08 is the second-Sunday spring-forward day.
    // Local midnight to next midnight should span 23 hours of real time.
    const { start, end } = getEpochBoundsForDate("2026-03-08", "America/New_York");
    expect(end - start).toBe(23 * 3600);
  });

  it("returns a 25-hour day across the US fall-back DST transition", () => {
    // America/New_York 2026-11-01 is the first-Sunday fall-back day.
    const { start, end } = getEpochBoundsForDate("2026-11-01", "America/New_York");
    expect(end - start).toBe(25 * 3600);
  });
});

describe("formatDigital", () => {
  it("formats seconds as H:MM", () => {
    expect(formatDigital(0)).toBe("0:00");
    expect(formatDigital(59)).toBe("0:00");
    expect(formatDigital(60)).toBe("0:01");
    expect(formatDigital(3600)).toBe("1:00");
    expect(formatDigital(9000)).toBe("2:30");
  });
});

describe("formatHumanReadable", () => {
  it("returns '0 secs' for exactly zero", () => {
    expect(formatHumanReadable(0)).toBe("0 secs");
  });

  it("pluralises hours and minutes correctly", () => {
    expect(formatHumanReadable(3600)).toBe("1 hr");
    expect(formatHumanReadable(7200)).toBe("2 hrs");
    expect(formatHumanReadable(60)).toBe("1 min");
    expect(formatHumanReadable(9000)).toBe("2 hrs 30 mins");
  });

  it("falls back to seconds only when sub-minute", () => {
    expect(formatHumanReadable(45)).toBe("45 secs");
    expect(formatHumanReadable(1)).toBe("1 sec");
  });
});
