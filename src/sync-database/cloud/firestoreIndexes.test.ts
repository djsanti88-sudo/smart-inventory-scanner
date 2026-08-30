import indexes from "../../../firestore.indexes.json";
import { describe, expect, it } from "vitest";

describe("Firestore indexes", () => {
  it("declares the session timeline scanEvents query index", () => {
    expect(indexes.indexes).toContainEqual({
      collectionGroup: "scanEvents",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "sessionId", order: "ASCENDING" },
        { fieldPath: "createdAt", order: "ASCENDING" },
      ],
    });
  });
});
