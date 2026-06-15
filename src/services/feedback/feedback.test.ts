import { describe, it, expect } from "vitest";
import { appendFeedback, type FeedbackEvent } from "@/services/feedback/feedback";

function ev(id: string): FeedbackEvent {
  return { id, businessId: "b", type: "barcode_scanned", code: id, productId: null, at: "t" };
}

describe("appendFeedback (private ring-buffer log)", () => {
  it("appends events in order", () => {
    let log: FeedbackEvent[] = [];
    log = appendFeedback(log, ev("1"));
    log = appendFeedback(log, ev("2"));
    expect(log.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("caps the log, dropping the oldest", () => {
    let log: FeedbackEvent[] = [];
    for (let i = 0; i < 10; i++) log = appendFeedback(log, ev(String(i)), 3);
    expect(log).toHaveLength(3);
    expect(log.map((e) => e.id)).toEqual(["7", "8", "9"]);
  });
});
