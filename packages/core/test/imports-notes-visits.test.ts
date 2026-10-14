import { describe, it, expect } from "vitest";
import { guessColumns, mappingProblems, parseTime, readRow, minutesOf } from "../src/imports/index.js";

const options = { dayFirst: false, today: "2026-10-14" };

describe("a time of day from a file", () => {
  it("reads a 24 hour clock and AM or PM", () => {
    expect(parseTime("14:30")).toEqual({ ok: true, value: "14:30" });
    expect(parseTime("2:30 PM")).toEqual({ ok: true, value: "14:30" });
    expect(parseTime("2pm")).toEqual({ ok: true, value: "14:00" });
    expect(parseTime("12:15 am")).toEqual({ ok: true, value: "00:15" });
    expect(parseTime("09:05:00")).toEqual({ ok: true, value: "09:05" });
    expect(minutesOf("14:30")).toBe(870);
  });

  it("refuses what is not a time on the clock, rather than guessing", () => {
    expect(parseTime("25:00").ok).toBe(false);
    expect(parseTime("13 pm").ok).toBe(false);
    expect(parseTime("afternoon").ok).toBe(false);
    expect(parseTime("14").ok).toBe(false);
  });
});

describe("a notes file", () => {
  const header = ["Customer ID", "Date", "Note", "For technician"];

  it("matches its columns and needs whose each note is", () => {
    const columns = guessColumns("notes", header);
    expect(columns).toEqual(["customerRef", "notedOn", "body", "forField"]);
    expect(mappingProblems("notes", columns)).toEqual([]);
    expect(mappingProblems("notes", [null, "notedOn", "body", null]).join(" ")).toMatch(/whose each note is/);
  });

  it("reads a row as it will land, and refuses one with no day", () => {
    const columns = guessColumns("notes", header);
    expect(readRow("notes", columns, ["C-1", "3/4/2021", "Gate sticks.", "yes"], options))
      .toEqual({ values: { customerRef: "C-1", notedOn: "2021-03-04", body: "Gate sticks.", forField: "true" }, problems: [] });
    expect(readRow("notes", columns, ["C-1", "", "Gate sticks.", ""], options).problems).toEqual(["Written on is empty."]);
  });
});

describe("a past visits file", () => {
  const header = ["Job number", "Technician email", "Visit date", "Start time", "End time", "Notes"];

  it("matches its columns", () => {
    expect(guessColumns("visits", header)).toEqual(["jobRef", "technicianEmail", "visitedOn", "startTime", "endTime", "notes"]);
  });

  it("reads the day and the times, and refuses a visit that ends before it starts or names no email", () => {
    const columns = guessColumns("visits", header);
    expect(readRow("visits", columns, ["1042", "ray@shop.test", "2021-03-04", "9:00 AM", "11:30 AM", "Replaced capacitor."], options).values)
      .toEqual({ jobRef: "1042", technicianEmail: "ray@shop.test", visitedOn: "2021-03-04", startTime: "09:00", endTime: "11:30", notes: "Replaced capacitor." });
    const backwards = readRow("visits", columns, ["1042", "ray@shop.test", "2021-03-04", "11:30", "09:00", ""], options);
    expect(backwards.problems.join(" ")).toMatch(/not after it started/);
    const named = readRow("visits", columns, ["1042", "Ray Ortiz", "2021-03-04", "09:00", "", ""], options);
    expect(named.problems.join(" ")).toMatch(/is not an email address/);
    const ahead = readRow("visits", columns, ["1042", "ray@shop.test", "2027-01-01", "09:00", "", ""], options);
    expect(ahead.problems.join(" ")).toMatch(/has not happened yet/);
  });
});
