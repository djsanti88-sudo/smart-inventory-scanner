import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageHoverPreview } from "./ImageHoverPreview";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("ImageHoverPreview", () => {
  it.each([
    "https://images.example.test/tire.jpg",
    "http://images.example.test/tire.jpg",
    "//images.example.test/tire.jpg",
    "data:image/svg+xml,<svg />",
  ])("does not render an image or preview control for %s in the local demo", (imageUrl) => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");

    const { container } = render(<ImageHoverPreview imageUrl={imageUrl} alt="Demo tire" />);

    expect(screen.getByText("Image unavailable in local demo")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByTestId("image-link")).toBeNull();
    expect(container.querySelector("a[href]")).toBeNull();

    fireEvent.mouseEnter(container.firstElementChild!);
    expect(screen.queryByTestId("image-hover-card")).toBeNull();
    expect(screen.queryByTestId("image-modal")).toBeNull();
  });
});
