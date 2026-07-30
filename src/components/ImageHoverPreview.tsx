"use client";

import { useState } from "react";

// Product image preview. Pure front-end behavior (no AI). Shows a small thumbnail/link; on hover
// a preview card; on click a larger modal. Gracefully handles "no image" and "failed to load"
// so a missing image never blocks scanning.
export function ImageHoverPreview({ imageUrl, alt }: { imageUrl: string; alt: string }) {
  const [hovering, setHovering] = useState(false);
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const isLocalDemo = process.env.NEXT_PUBLIC_LOCAL_DEMO === "1";
  const isLocalImagePath = /^\/(?![\\/])/.test(imageUrl);

  if (!imageUrl) {
    return <span className="text-sm text-zinc-700">No image yet</span>;
  }

  if (isLocalDemo && !isLocalImagePath) {
    return <span className="text-sm text-zinc-700">Image unavailable in local demo</span>;
  }

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        onFocus={() => setHovering(true)}
        onBlur={() => setHovering(false)}
        aria-label={`View image for ${alt}`}
        className="text-sm font-medium text-blue-600 underline underline-offset-2 hover:text-blue-800"
        data-testid="image-link"
      >
        Image
      </button>

      {hovering && (
        <span
          className="absolute left-0 top-6 z-20 block w-40 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg"
          data-testid="image-hover-card"
        >
          {broken ? (
            <span className="flex h-24 w-full items-center justify-center rounded bg-zinc-100 text-sm text-zinc-700">
              Image unavailable
            </span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt={alt}
              loading="lazy"
              className="h-24 w-full rounded object-contain"
              onError={() => setBroken(true)}
            />
          )}
        </span>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setOpen(false)}
          onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          data-testid="image-modal"
        >
          <div className="max-w-lg rounded-lg bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-800">{alt}</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-zinc-700 hover:text-zinc-900"
              >
                Close
              </button>
            </div>
            {broken ? (
              <div className="flex h-64 w-full items-center justify-center rounded bg-zinc-100 text-sm text-zinc-500">
                Image unavailable
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt={alt}
                className="max-h-[60vh] w-full object-contain"
                onError={() => setBroken(true)}
              />
            )}
          </div>
        </div>
      )}
    </span>
  );
}
