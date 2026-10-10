import { formatDuration, formatTimecode } from "./timecode";

describe("formatTimecode", () => {
  it("formats zero", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
  });

  it("is frame-aware", () => {
    expect(formatTimecode(1.5, 30)).toBe("00:00:01:15");
    expect(formatTimecode(61, 24)).toBe("00:01:01:00");
  });

  it("rolls hours and clamps negatives", () => {
    expect(formatTimecode(3725, 25)).toBe("01:02:05:00");
    expect(formatTimecode(-4, 30)).toBe("00:00:00:00");
  });
});

describe("formatDuration", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(12.4)).toBe("0:12");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});
