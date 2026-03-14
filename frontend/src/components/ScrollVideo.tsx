// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: scroll-video-v3-ios-autoplay
"use client";

import { useRef, useEffect, useState } from "react";

const MODULE_REVISION = "scroll-video-v3-ios-autoplay";
console.log(
  `[ScrollVideo] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

interface ScrollVideoProps {
  src: string;
  poster?: string;
  alt?: string;
  style?: React.CSSProperties;
}

export function ScrollVideo({ src, poster, alt, style }: ScrollVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [videoReady, setVideoReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    const updateTime = () => {
      if (!video.duration) return;
      const rect = container.getBoundingClientRect();
      const windowH = window.innerHeight;
      // progress=0 when element top is at viewport center, progress=1 when fully exited top
      const start = windowH * 0.5;
      const end = -rect.height;
      const progress = Math.min(
        1,
        Math.max(0, (start - rect.top) / (start - end))
      );
      video.currentTime = progress * video.duration;
    };

    const onScroll = () => requestAnimationFrame(updateTime);

    const activate = () => {
      video.pause();
      setVideoReady(true);
      updateTime();
      window.addEventListener("scroll", onScroll, { passive: true });
    };

    // iOS: autoplay will fire "playing" once data is available.
    // Desktop: loadeddata fires when enough data is buffered.
    // We listen for both and activate on whichever fires first.
    let activated = false;
    const onActivate = () => {
      if (activated) return;
      activated = true;
      activate();
    };

    video.addEventListener("playing", onActivate, { once: true });
    video.addEventListener("loadeddata", onActivate, { once: true });

    // Kick off autoplay — iOS needs this to start loading
    video.play().catch(() => {
      // Autoplay blocked (e.g. old iOS policy) — poster image stays visible
    });

    return () => {
      window.removeEventListener("scroll", onScroll);
      video.removeEventListener("playing", onActivate);
      video.removeEventListener("loadeddata", onActivate);
    };
  }, []);

  const sharedStyle: React.CSSProperties = {
    width: "100%",
    maxHeight: "360px",
    objectFit: "cover",
    borderRadius: "12px",
    display: "block",
    ...style,
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {/* Poster image as fallback until video is ready */}
      {poster && (
        <img
          src={poster}
          alt={alt || ""}
          style={{
            ...sharedStyle,
            ...(videoReady
              ? { position: "absolute", top: 0, left: 0, opacity: 0, pointerEvents: "none" }
              : {}),
          }}
        />
      )}
      <video
        ref={videoRef}
        src={src}
        muted
        playsInline
        autoPlay
        preload="auto"
        aria-label={alt}
        style={{
          ...sharedStyle,
          ...(videoReady ? {} : { position: "absolute", top: 0, left: 0, opacity: 0 }),
        }}
      />
    </div>
  );
}
