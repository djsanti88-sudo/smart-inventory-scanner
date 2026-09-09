import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageHoverPreview } from "@/user-interface/ui/ImageHoverPreview";

afterEach(() => cleanup());

describe("ImageHoverPreview dialog focus", () => {
  it("moves focus to Close when the image dialog opens", async () => {
    const user = userEvent.setup();
    render(<ImageHoverPreview imageUrl="/product.png" alt="All-weather tire" />);

    await user.click(screen.getByRole("button", { name: "View image for All-weather tire" }));

    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("keeps Tab and Shift+Tab focus inside the image dialog", async () => {
    const user = userEvent.setup();
    render(<ImageHoverPreview imageUrl="/product.png" alt="All-weather tire" />);

    await user.click(screen.getByRole("button", { name: "View image for All-weather tire" }));
    const closeButton = screen.getByRole("button", { name: "Close" });
    closeButton.focus();

    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.tab({ shift: true });
    expect(closeButton).toHaveFocus();
  });

  it("closes on Escape and returns focus to the image trigger", async () => {
    const user = userEvent.setup();
    render(<ImageHoverPreview imageUrl="/product.png" alt="All-weather tire" />);

    const trigger = screen.getByRole("button", { name: "View image for All-weather tire" });
    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
