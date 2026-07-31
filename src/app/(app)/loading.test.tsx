import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Loading from "./loading";

describe("protected app route loading UI", () => {
  it("gives immediate, announced feedback while a route segment streams", () => {
    render(<Loading />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading page");
  });
});
