// Known codes for the QA bots. The seed catalog (src/seed/seedData.ts) contains a real Falken tire
// (prod-falken) with aliases: 848983012906 (barcode), 28816861 (SKU), 2881-6861 (dashed SKU).
// These are the exact shapes that caused the real-world Falken/Camel failure.

export const FALKEN_PRODUCT_NAME = "Falken Sincera ST80 A/S";
export const CAMEL_PRODUCT_NAME = "Camel Crush Menthol Silver Cigarettes";

// The dangerous code in EVERY separator shape a technician might scan. All must resolve to the same
// product and NEVER to Camel. (scanCleaner strips - space / \ _ . to a common no-separator key.)
export const FALKEN_PART_NUMBER_VARIANTS = [
  { code: "2881-6861", label: "dashed (the original failing scan)" },
  { code: "28816861", label: "no separator (found Falken online)" },
  { code: "2881 6861", label: "space separated" },
  { code: "2881/6861", label: "slash separated" },
  { code: "2881\\6861", label: "backslash separated" },
  { code: "2881_6861", label: "underscore separated" },
  { code: "2881.6861", label: "dot separated" },
];

export const FALKEN_BARCODE = "848983012906";

// A tire code that is NOT in the seed catalog (used to exercise the unknown -> link / mismatch flow).
export const UNREGISTERED_TIRE_CODE = "4950-1122";
