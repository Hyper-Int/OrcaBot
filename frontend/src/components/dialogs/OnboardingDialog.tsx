// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: onboarding-v2-alternating-layout
const MODULE_REVISION = "onboarding-v2-alternating-layout";
console.log(`[onboarding] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
} from "@/components/ui";

const STORAGE_KEY = "orcabot:onboarding-dismissed";

interface OnboardingSlide {
  title: string;
  description: React.ReactNode;
  imageSrc?: string;
}

// Replace these placeholder slides with your own content and images
const ONBOARDING_SLIDES: OnboardingSlide[] = [
  {
    title: "Welcome to Orcabot",
    description: "Your multiplayer AI coding workspace. Run Claude, Codex, or any agent in the browser with zero setup. Safely run with stronger permissions on our sandboxed virtual machines.",
    imageSrc: "/onboarding/claude_code.png",
  },
  {
    title: "Build agentic AI on a Canvas",
    description: "Drag terminals, notes, todos, and integrations onto an infinite canvas. Add your Gmail, Calendar, Drive and attatch them to the agentic terminals with precisely defined access gates. Connect them with edges to grant what each agent can access.",
    imageSrc: "/onboarding/integrations.png",
  },
  {
    title: "Use multiple agents in tandem",
    description: "Run multiple agents side by side, each with different subagents and tools attached. Compare their approaches, or have one agent review another's work in a loop.",
    imageSrc: "/onboarding/opinions.png",
  },
  {
    title: "Integrate Securely",
    description: "OrcaBot will watch out for security risks and encourage best practices, such as avoiding open access to email or exposing api keys to agents on the virtual machines.",
    imageSrc: "/onboarding/danger.png",
  },
];

export function OnboardingDialog() {
  const [open, setOpen] = React.useState(false);
  const [currentSlide, setCurrentSlide] = React.useState(0);
  const [dontShowAgain, setDontShowAgain] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (!dismissed && ONBOARDING_SLIDES.length > 0) {
      setOpen(true);
    }
  }, []);

  const handleClose = React.useCallback(() => {
    setOpen(false);
    if (dontShowAgain) {
      localStorage.setItem(STORAGE_KEY, "true");
    }
    setCurrentSlide(0);
  }, [dontShowAgain]);

  const handleNext = React.useCallback(() => {
    if (currentSlide < ONBOARDING_SLIDES.length - 1) {
      setCurrentSlide((s) => s + 1);
    } else {
      handleClose();
    }
  }, [currentSlide, handleClose]);

  const handlePrev = React.useCallback(() => {
    setCurrentSlide((s) => Math.max(0, s - 1));
  }, []);

  const slide = ONBOARDING_SLIDES[currentSlide];
  const isLastSlide = currentSlide === ONBOARDING_SLIDES.length - 1;
  const imageOnRight = currentSlide % 2 === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        {/* Side-by-side layout: text + image alternate direction */}
        <div className={`flex min-h-[320px] ${imageOnRight ? "flex-row" : "flex-row-reverse"}`}>
          {/* Text side */}
          <div className="flex flex-col justify-center flex-1 p-8">
            <DialogHeader>
              <DialogTitle className="text-2xl font-semibold">{slide?.title}</DialogTitle>
              <div className="mt-2 text-body text-[var(--foreground-muted)]">{slide?.description}</div>
            </DialogHeader>
          </div>

          {/* Image side */}
          {slide?.imageSrc && (
            <div className="flex items-center justify-center flex-1 bg-[var(--background)] p-6">
              <img
                src={slide.imageSrc}
                alt={slide.title}
                className="max-h-64 w-auto rounded-[var(--radius-card)] object-contain"
              />
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center !justify-between gap-4 px-8 pb-6 pt-0">
          {/* Don't show again checkbox */}
          <label className="flex items-center gap-2 text-sm text-[var(--foreground-muted)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="rounded border-[var(--border)] accent-[var(--accent-primary)]"
            />
            Don&apos;t show again
          </label>

          <div className="flex items-center gap-3">
            {/* Dot indicators */}
            <div className="flex items-center gap-1.5">
              {ONBOARDING_SLIDES.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentSlide(i)}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    i === currentSlide
                      ? "bg-[var(--accent-primary)]"
                      : "bg-[var(--border)]"
                  }`}
                  aria-label={`Go to slide ${i + 1}`}
                />
              ))}
            </div>

            {/* Navigation buttons */}
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handlePrev}
                disabled={currentSlide === 0}
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Back
              </Button>
              <Button size="sm" onClick={handleNext}>
                {isLastSlide ? "Get Started" : "Next"}
                {!isLastSlide && <ChevronRight className="w-4 h-4 ml-1" />}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
