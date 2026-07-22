import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import NotFound from "./not-found";

afterEach(() => cleanup());

describe("custom 404", () => {
  it("renders a human message and links back into the app shell", () => {
    render(<NotFound />);
    expect(screen.getByText(/page not found/i)).toBeInTheDocument();
    const scanLink = screen.getByRole("link", { name: /scan/i });
    expect(scanLink).toHaveAttribute("href", "/scan");
    const productsLink = screen.getByRole("link", { name: /products/i });
    expect(productsLink).toHaveAttribute("href", "/products");
  });

  it("wraps content in a main landmark", () => {
    render(<NotFound />);
    expect(screen.getByRole("main")).toBeInTheDocument();
  });
});
