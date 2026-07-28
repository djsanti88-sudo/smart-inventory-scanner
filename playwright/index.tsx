// Playwright component-testing entry point. Runs in the browser before each mounted component.
// Import global CSS here if a component ever needs it; the current example (pure badge markup)
// asserts DOM/text/testid, not computed Tailwind styles, so no stylesheet is required.
import "@playwright/experimental-ct-react/hooks";
