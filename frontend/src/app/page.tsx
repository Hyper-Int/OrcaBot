// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: splash-v15-no-iframe
"use client";

const MODULE_REVISION = "splash-v15-no-iframe";
console.log(
  `[page] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import "./splash.css";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { useSplashTransitionStore } from "@/stores/splash-transition-store";
import { createDashboard } from "@/lib/api/cloudflare/dashboards";
import { API } from "@/config/env";

/* ═══════════════════════════════════════════════════════════════
   DATA
   ═══════════════════════════════════════════════════════════════ */

const SLIDES: {
  type: "video" | "image";
  src: string;
  poster?: string;
  title: string;
  desc: string;
}[] = [
  {
    type: "video",
    src: "/videos/open_claude_code.mp4",
    poster: "/videos/open_claude_code-poster.jpg",
    title: "Launch Claude Code in a secure sandbox",
    desc: "Create a dashboard, add a terminal, and launch Claude Code. It runs in an isolated Linux VM. Your API key is injected server-side so the agent never sees it.",
  },
  {
    type: "video",
    src: "/videos/gemini_secret.mp4",
    poster: "/videos/gemini_secret-poster.jpg",
    title: "Secrets broker keeps API keys invisible",
    desc: "API keys are injected at the network layer, not as env vars. The agent only sees placeholders, and any secret in terminal output is redacted before reaching your browser.",
  },
  {
    type: "video",
    src: "/videos/gmail.mp4",
    poster: "/videos/gmail-poster.jpg",
    title: "Connect Gmail with policy-guarded access",
    desc: "Attach integration blocks to terminals and define the policy: which senders the agent can read, which actions are allowed. OAuth tokens never leave the control plane.",
  },
  {
    type: "video",
    src: "/videos/whatsapp.mp4",
    poster: "/videos/whatsapp-poster.jpg",
    title: "Two-way messaging via WhatsApp & Slack",
    desc: "Connect messaging integrations so agents can receive instructions and send updates through your existing channels. Monitor long-running tasks from anywhere.",
  },
  {
    type: "video",
    src: "/videos/chess.mp4",
    poster: "/videos/chess-poster.jpg",
    title: "Multi-agent chess: AIs compete head to head",
    desc: "Place multiple terminals on a dashboard and let different AI agents compete. Each terminal runs in the same sandbox so agents can share files and communicate.",
  },
  {
    type: "image",
    src: "/videos/ralph_wiggum.png",
    title: "Ralph Wiggum loop: code + review agents",
    desc: "Chain agents so one writes code and another reviews it. Different AI providers mean the reviewer isn't biased by its own weights. Continuous improvement, no human needed.",
  },
];

const INTEGRATIONS: {
  name: string;
  img?: string;
  icon?: React.ReactNode;
}[] = [
  { name: "Claude Code", img: "/icons/claude.ico" },
  { name: "Codex", img: "/icons/codex.png" },
  { name: "Gemini CLI", img: "/icons/gemini.ico" },
  {
    name: "Gmail",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </svg>
    ),
  },
  {
    name: "Google Drive",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2L2 19.5h7.5L12 14l2.5 5.5H22z" />
      </svg>
    ),
  },
  {
    name: "Google Calendar",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    name: "Google Contacts",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    name: "Google Sheets",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
        <line x1="9" y1="3" x2="9" y2="21" />
      </svg>
    ),
  },
  {
    name: "Google Forms",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="8" y1="8" x2="16" y2="8" />
        <line x1="8" y1="12" x2="16" y2="12" />
        <line x1="8" y1="16" x2="12" y2="16" />
      </svg>
    ),
  },
  {
    name: "GitHub",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
      </svg>
    ),
  },
  {
    name: "Slack",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="13" y="2" width="3" height="8" rx="1.5" />
        <rect x="8" y="14" width="3" height="8" rx="1.5" />
        <rect x="2" y="8" width="8" height="3" rx="1.5" />
        <rect x="14" y="13" width="8" height="3" rx="1.5" />
      </svg>
    ),
  },
  {
    name: "Discord",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M18 9a5 5 0 0 0-4-2h-4a5 5 0 0 0-4 2" />
        <circle cx="9" cy="13" r="1.25" />
        <circle cx="15" cy="13" r="1.25" />
        <path d="M7 3s-2 2-2 8 2 10 2 10" />
        <path d="M17 3s2 2 2 8-2 10-2 10" />
      </svg>
    ),
  },
  {
    name: "WhatsApp",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    ),
  },
  {
    name: "ElevenLabs",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      </svg>
    ),
  },
  {
    name: "Deepgram",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
      </svg>
    ),
  },
];

/* ═══════════════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════════════ */

export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isAuthResolved } = useAuthStore();
  const { phase, startTransition, setAnimating, reset } =
    useSplashTransitionStore();
  const creatingRef = React.useRef(false);

  // ─── Carousel state ────────────────────────────────────────
  const [currentSlide, setCurrentSlide] = React.useState(0);
  const carouselVisibleRef = React.useRef(false);
  const autoplayTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const videoRefs = React.useRef<(HTMLVideoElement | null)[]>([]);
  const carouselViewportRef = React.useRef<HTMLDivElement>(null);
  const currentSlideRef = React.useRef(0);
  currentSlideRef.current = currentSlide;
  const [carouselHovered, setCarouselHovered] = React.useState(false);

  // ─── Chat bar state ────────────────────────────────────────
  const chatInputRef = React.useRef<HTMLInputElement>(null);
  const [chatSubmitted, setChatSubmitted] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(false);

  // ─── Login popup ───────────────────────────────────────────
  const loginPopupRef = React.useRef<Window | null>(null);
  const popupPollTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const pendingSubmitRef = React.useRef<{
    prompt: string;
    chatBarBottom: number;
  } | null>(null);

  // ─── Helpers ───────────────────────────────────────────────

  const clearAutoplay = React.useCallback(() => {
    if (autoplayTimerRef.current) {
      clearTimeout(autoplayTimerRef.current);
      autoplayTimerRef.current = null;
    }
  }, []);

  const loadAndPlaySlide = React.useCallback((idx: number) => {
    const video = videoRefs.current[idx];
    if (video) {
      if (!video.src && video.dataset.src) video.src = video.dataset.src;
      video.currentTime = 0;
      video.play().catch(() => {});
    } else {
      // Image slide — auto-advance after 6s
      autoplayTimerRef.current = setTimeout(() => {
        setCurrentSlide((prev) => (prev + 1) % SLIDES.length);
      }, 6000);
    }
  }, []);

  const goToSlide = React.useCallback(
    (idx: number) => {
      clearAutoplay();
      const next = ((idx % SLIDES.length) + SLIDES.length) % SLIDES.length;
      // Pause previous
      const prevVideo = videoRefs.current[currentSlideRef.current];
      if (prevVideo) prevVideo.pause();
      setCurrentSlide(next);
    },
    [clearAutoplay]
  );

  // ─── Carousel: play/pause on slide change ──────────────────
  const prevSlideRef = React.useRef(0);
  React.useEffect(() => {
    if (prevSlideRef.current !== currentSlide) {
      const prevVideo = videoRefs.current[prevSlideRef.current];
      if (prevVideo) prevVideo.pause();
      prevSlideRef.current = currentSlide;
    }
    if (carouselVisibleRef.current) {
      loadAndPlaySlide(currentSlide);
    }
    return () => clearAutoplay();
  }, [currentSlide, loadAndPlaySlide, clearAutoplay]);

  // ─── Carousel: intersection observer ───────────────────────
  React.useEffect(() => {
    const vp = carouselViewportRef.current;
    if (!vp) return;
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          carouselVisibleRef.current = entry.isIntersecting;
          const idx = currentSlideRef.current;
          if (entry.isIntersecting) {
            loadAndPlaySlide(idx);
          } else {
            clearAutoplay();
            const v = videoRefs.current[idx];
            if (v) v.pause();
          }
        });
      },
      { threshold: 0.3 }
    );
    obs.observe(vp);
    return () => obs.disconnect();
  }, [loadAndPlaySlide, clearAutoplay]);

  // ─── Carousel: keyboard ────────────────────────────────────
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!carouselHovered) return;
      if (e.key === "ArrowLeft") goToSlide(currentSlideRef.current - 1);
      if (e.key === "ArrowRight") goToSlide(currentSlideRef.current + 1);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [carouselHovered, goToSlide]);

  // ─── Scroll reveal ─────────────────────────────────────────
  React.useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) e.target.classList.add("visible");
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    document.querySelectorAll(".splash-page .reveal").forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  // ─── Responsive placeholder ────────────────────────────────
  React.useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 480);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // ─── Login popup helpers ───────────────────────────────────
  const openLoginPopup = React.useCallback(() => {
    const loginUrl = `${API.cloudflare.base}/auth/google/login?mode=popup`;
    const w = 500,
      h = 600;
    const left = Math.round(screen.width / 2 - w / 2);
    const top = Math.round(screen.height / 2 - h / 2);
    loginPopupRef.current = window.open(
      loginUrl,
      "orcabot-login",
      `width=${w},height=${h},left=${left},top=${top},popup=yes`
    );
    if (!loginPopupRef.current) {
      router.push("/go");
      return;
    }
    // Poll for popup close as fallback
    if (popupPollTimerRef.current) clearInterval(popupPollTimerRef.current);
    popupPollTimerRef.current = setInterval(() => {
      if (loginPopupRef.current && loginPopupRef.current.closed) {
        if (popupPollTimerRef.current)
          clearInterval(popupPollTimerRef.current);
        loginPopupRef.current = null;
        // Popup closed — check if auth was set via cookie
        fetch(API.cloudflare.usersMe, { credentials: "include" })
          .then((r) => (r.ok ? r.json() : null))
          .then(
            (
              data: {
                user?: { id: string; email: string; name: string };
              } | null
            ) => {
              if (data?.user) {
                handleLoginComplete(data.user);
              }
            }
          )
          .catch(() => {});
      }
    }, 500);
  }, [router]);

  // ─── Login completion ──────────────────────────────────────
  const handleLoginComplete = React.useCallback(
    (user: { id: string; email: string; name: string }) => {
      console.log(`[page] Login complete: ${user.email}`);
      useAuthStore.getState().setUser(user);

      if (popupPollTimerRef.current) clearInterval(popupPollTimerRef.current);
      if (loginPopupRef.current && !loginPopupRef.current.closed) {
        loginPopupRef.current.close();
      }
      loginPopupRef.current = null;

      const pending = pendingSubmitRef.current;
      if (pending) {
        pendingSubmitRef.current = null;
        if (creatingRef.current) return;
        creatingRef.current = true;

        localStorage.setItem("orcabot_initial_prompt", pending.prompt);
        const store = useSplashTransitionStore.getState();
        store.startTransition(pending.prompt, pending.chatBarBottom);
        const dashName =
          pending.prompt.slice(0, 40) +
          (pending.prompt.length > 40 ? "..." : "");

        createDashboard(dashName)
          .then(({ dashboard }) => {
            console.log(
              `[page] Dashboard created after login: ${dashboard.id}`
            );
            useSplashTransitionStore.getState().setAnimating(dashboard.id);
            router.push(`/dashboards/${dashboard.id}`);
          })
          .catch((err) => {
            console.error("[page] Failed to create dashboard:", err);
            creatingRef.current = false;
            useSplashTransitionStore.getState().reset();
            setChatSubmitted(false);
            toast.error("Failed to create dashboard");
            router.push("/dashboards");
          });
      } else {
        router.push("/dashboards");
      }
    },
    [router]
  );

  // ─── Listen for login messages ─────────────────────────────
  React.useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "login-auth-complete" && e.data.user) {
        handleLoginComplete(e.data.user);
      }
    }

    window.addEventListener("message", handleMessage);

    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("orcabot-oauth");
      bc.onmessage = (e: MessageEvent) => {
        if (e.data?.type === "login-auth-complete" && e.data.user) {
          handleLoginComplete(e.data.user);
        }
      };
    } catch {}

    return () => {
      window.removeEventListener("message", handleMessage);
      try {
        bc?.close();
      } catch {}
    };
  }, [handleLoginComplete]);

  // ─── Chat bar submit ───────────────────────────────────────
  const handleChatSubmit = React.useCallback(() => {
    const input = chatInputRef.current;
    if (!input) return;
    const query = input.value.trim();
    if (!query || chatSubmitted) return;

    localStorage.setItem("orcabot_initial_prompt", query);

    const chatBar = input.closest(".chat-bar");
    const rect = chatBar?.getBoundingClientRect();
    const chatBarBottom = rect ? window.innerHeight - rect.bottom : 0;

    if (isAuthenticated) {
      setChatSubmitted(true);
      if (creatingRef.current) return;
      creatingRef.current = true;

      startTransition(query, chatBarBottom);
      const dashName = query.slice(0, 40) + (query.length > 40 ? "..." : "");

      createDashboard(dashName)
        .then(({ dashboard }) => {
          console.log(`[page] Dashboard created: ${dashboard.id}`);
          setAnimating(dashboard.id);
          router.push(`/dashboards/${dashboard.id}`);
        })
        .catch((err) => {
          console.error("[page] Failed to create dashboard:", err);
          creatingRef.current = false;
          reset();
          setChatSubmitted(false);
          toast.error("Failed to create dashboard");
          router.push("/go");
        });
    } else {
      // Not authenticated — open login popup with pending prompt
      setChatSubmitted(true);
      pendingSubmitRef.current = { prompt: query, chatBarBottom };
      openLoginPopup();
    }
  }, [
    isAuthenticated,
    chatSubmitted,
    router,
    startTransition,
    setAnimating,
    reset,
    openLoginPopup,
  ]);

  // ─── Login button click ────────────────────────────────────
  const handleLoginClick = React.useCallback(
    (e: React.MouseEvent) => {
      if (isAuthenticated) return; // let href navigate
      e.preventDefault();
      openLoginPopup();
    },
    [isAuthenticated, openLoginPopup]
  );

  // ─── Derived ───────────────────────────────────────────────
  const splashHidden = phase !== "idle" && phase !== "done";
  const headerLoginHref = isAuthenticated ? "/dashboards" : "/go";
  const headerLoginText = isAuthenticated ? "Dashboards" : "Sign In";
  const ctaHref = isAuthenticated ? "/dashboards" : "/go";
  const ctaText = isAuthenticated ? "Dashboards" : "Get Started Free";

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════

  return (
    <div
      className="splash-page"
      style={{
        opacity: splashHidden ? 0 : 1,
        transition: "opacity 400ms cubic-bezier(0.4, 0, 0.2, 1)",
      }}
    >
      {/* ═══ BACKGROUND ═══ */}
      <div className="bg-scene" aria-hidden="true">
        <div className="bg-plane" />
        <div className="bg-plane-2" />
        <div className="bg-glow" />
        <div className="bg-block bg-block-1" />
        <div className="bg-block bg-block-2" />
        <div className="bg-block bg-block-3" />
        <div className="bg-block bg-block-4" />
        <div className="bg-block bg-block-5" />
        <div className="bg-fade" />
      </div>

      {/* ═══ CONTENT ═══ */}
      <div className="sp-content">
        {/* HEADER */}
        <header className="sp-header">
          <a href="/" className="header-logo">
            <img src="/orca.png" alt="OrcaBot" />
            <span>OrcaBot</span>
          </a>
          <nav className="header-nav">
            <a href="#about">About</a>
            <a href="#demos">Demos</a>
            <a href="#features">Features</a>
            <a href="#security">Security</a>
            <a href="#usecases">Use Cases</a>
            <a
              href={headerLoginHref}
              className="btn btn-primary btn-sm"
              onClick={handleLoginClick}
            >
              {headerLoginText}
            </a>
          </nav>
        </header>

        {/* HERO */}
        <div className="hero">
          <img src="/orca.png" alt="OrcaBot" className="hero-orca" />
          <h1 className="hero-tagline">
            Run AI coding agents in the browser. No setup. No risk.
          </h1>
          <div className="chat-bar">
            <input
              ref={chatInputRef}
              type="text"
              placeholder={
                isMobile
                  ? "Describe what you want to build..."
                  : "Set up a coding agent, manage my email, build a workflow..."
              }
              disabled={chatSubmitted}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleChatSubmit();
                }
              }}
            />
            <button
              className="chat-bar-send"
              aria-label="Send"
              disabled={chatSubmitted}
              onClick={handleChatSubmit}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
          <p className="hero-subtext">
            Run AI agents in secure sandboxes. The sane and secure alternative to
            open-source claws.
          </p>
          <p className="hero-legal">
            By continuing, you agree to our{" "}
            <a href="/terms">Terms of Service</a> and{" "}
            <a href="/privacy">Privacy Policy</a>
          </p>
          <a href="#about" className="scroll-hint">
            <span>Explore</span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </a>
        </div>

        {/* WHAT IS ORCABOT */}
        <section id="about">
          <div className="about-box reveal">
            <h2>What is OrcaBot?</h2>
            <p>
              OrcaBot is a{" "}
              <strong>web-based orchestration platform</strong> for AI coding
              agents. It provides sandboxed Linux virtual machines where AI
              agents like Claude Code, Codex, and Gemini CLI can write, run, and
              test code on your behalf &mdash; all accessible through your
              browser.
            </p>
            <p>
              OrcaBot is <strong>not an AI provider</strong>. It orchestrates
              third-party AI agents (from Anthropic, OpenAI, Google, etc.) inside
              secure, isolated environments. You bring your own API keys, which
              are protected by a secrets broker that prevents AI agents from ever
              seeing or exfiltrating them.
            </p>
            <p>
              Users create <strong>dashboards</strong> &mdash; collaborative
              workspaces similar to Figma boards &mdash; where they can place
              terminals, notes, browser previews, and integration blocks.
              Multiple team members can view and interact with the same dashboard
              in real-time.
            </p>
          </div>
        </section>

        {/* DEMOS CAROUSEL */}
        <section id="demos" className="carousel-section">
          <div className="reveal">
            <div className="section-label">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              See It In Action
            </div>
            <h2 className="section-title">Watch how it works.</h2>
            <p className="section-desc" style={{ margin: "0 auto" }}>
              From launching an agent to connecting integrations, OrcaBot is
              designed to get you productive in a few clicks.
            </p>
          </div>

          <div
            className="carousel-wrap reveal reveal-delay-1"
            role="region"
            aria-roledescription="carousel"
            aria-label="Product demos"
            onMouseEnter={() => setCarouselHovered(true)}
            onMouseLeave={() => setCarouselHovered(false)}
          >
            <div
              className="carousel-viewport"
              ref={carouselViewportRef}
              aria-live="polite"
            >
              {SLIDES.map((slide, i) => (
                <div
                  key={i}
                  className={`carousel-slide${i === currentSlide ? " active" : ""}`}
                  role="group"
                  aria-roledescription="slide"
                  aria-label={`${slide.title} (${i + 1} of ${SLIDES.length})`}
                  aria-hidden={i !== currentSlide}
                >
                  {slide.type === "video" ? (
                    <video
                      ref={(el) => {
                        videoRefs.current[i] = el;
                      }}
                      muted
                      playsInline
                      preload="none"
                      poster={slide.poster}
                      data-src={slide.src}
                      onEnded={() => {
                        autoplayTimerRef.current = setTimeout(() => {
                          setCurrentSlide(
                            (prev) => (prev + 1) % SLIDES.length
                          );
                        }, 3000);
                      }}
                    />
                  ) : (
                    <img src={slide.src} alt={slide.title} loading="lazy" />
                  )}
                </div>
              ))}
            </div>

            <button
              className="carousel-arrow prev"
              onClick={() => goToSlide(currentSlide - 1)}
              aria-label="Previous"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <button
              className="carousel-arrow next"
              onClick={() => goToSlide(currentSlide + 1)}
              aria-label="Next"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>

            <div className="carousel-info">
              <h3>{SLIDES[currentSlide].title}</h3>
              <p>{SLIDES[currentSlide].desc}</p>
            </div>

            <div className="carousel-dots">
              {SLIDES.map((_, i) => (
                <button
                  key={i}
                  className={`carousel-dot${i === currentSlide ? " active" : ""}`}
                  aria-label={`Go to slide ${i + 1}`}
                  onClick={() => goToSlide(i)}
                />
              ))}
            </div>
          </div>
        </section>

        {/* FEATURES */}
        <section id="features" style={{ paddingBottom: "40px" }}>
          <div className="reveal">
            <div className="section-label">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              Features
            </div>
            <h2 className="section-title">Ridiculously easy to use.</h2>
            <p className="section-desc">
              From zero to running AI agents in a few clicks. No installs, no
              Docker, no config files.
            </p>
          </div>

          <div style={{ marginTop: "48px" }}>
            <div className="feature-row reveal reveal-delay-1">
              <div
                className="feature-row-num"
                style={{ background: "rgba(59, 130, 246, 0.1)" }}
              >
                <span style={{ color: "var(--accent)" }}>1</span>
              </div>
              <div className="feature-row-body">
                <h3>AI Agents in Your Browser</h3>
                <p>
                  Run vanilla Claude Code, Codex, or Gemini CLI directly in your
                  browser with a built-in Chromium browser for seamless login to
                  your subscription. No local setup, no Docker, no configuration
                  files. A few clicks and you&apos;re coding.
                </p>
              </div>
            </div>

            <div className="feature-row reveal reveal-delay-2">
              <div
                className="feature-row-num"
                style={{ background: "rgba(236, 72, 153, 0.1)" }}
              >
                <span style={{ color: "var(--pink)" }}>2</span>
              </div>
              <div className="feature-row-body">
                <h3>Multiplayer Dashboards</h3>
                <p>
                  Collaborate in real-time on shared workspaces. Place terminals,
                  notes, browser previews, and integration blocks on a
                  Figma-style infinite canvas. Multiple team members can view and
                  interact simultaneously.
                </p>
              </div>
            </div>

            <div className="feature-row reveal reveal-delay-3">
              <div
                className="feature-row-num"
                style={{ background: "rgba(245, 158, 11, 0.1)" }}
              >
                <span style={{ color: "var(--amber)" }}>3</span>
              </div>
              <div className="feature-row-body">
                <h3>Background Workflows &amp; Schedulers</h3>
                <p>
                  Schedule repeatable workflows that run on a cadence or in
                  response to events. Agents keep working even when you close the
                  tab. Build decision trees, set up cron-style triggers, and
                  connect Slack or Discord for notifications.
                </p>
              </div>
            </div>

            <div className="feature-row reveal reveal-delay-4">
              <div
                className="feature-row-num"
                style={{ background: "rgba(6, 182, 212, 0.1)" }}
              >
                <span style={{ color: "var(--cyan)" }}>4</span>
              </div>
              <div className="feature-row-body">
                <h3>Skills, Subagents &amp; MCP</h3>
                <p>
                  A few clicks and you have custom skills, subagent templates,
                  MCP servers, and text-to-speech ready to go. Works natively
                  with Claude Code, Gemini CLI, and Codex CLI.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* SECURITY */}
        <section id="security">
          <div className="reveal">
            <div className="section-label">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              Security
            </div>
            <h2 className="section-title">
              A secure alternative to
              <br />
              claws-type systems.
            </h2>
            <p className="section-desc">
              Running AI agents on your personal machine is asking for trouble.
              OrcaBot isolates execution in sandboxes and adds six layers of
              defense against data exfiltration.
            </p>
          </div>

          <div className="bento-grid bento-grid-3col">
            <div className="bento-card bento-dark reveal reveal-delay-1">
              <div
                className="bento-inline-icon"
                style={{ background: "rgba(34, 197, 94, 0.12)" }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--green)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="3" y1="9" x2="21" y2="9" />
                  <line x1="9" y1="21" x2="9" y2="9" />
                </svg>
              </div>
              <h3>Sandboxed Virtual Machines</h3>
              <p>
                Every session runs in an isolated Linux VM. Agents can&apos;t
                touch your local machine, can&apos;t see other sessions, and
                can&apos;t persist beyond the sandbox.
              </p>
            </div>

            <div className="bento-card bento-accent reveal reveal-delay-2">
              <div
                className="bento-inline-icon"
                style={{ background: "rgba(139, 92, 246, 0.12)" }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--purple)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <h3>Encrypted Secrets Broker</h3>
              <p>
                API keys injected server-side at the network layer. Agents never
                see credentials. Terminal output is scanned and redacted.
              </p>
            </div>

            <div className="bento-card bento-subtle reveal reveal-delay-3">
              <div
                className="bento-inline-icon"
                style={{ background: "rgba(245, 158, 11, 0.12)" }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--amber)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h3>Egress Monitoring</h3>
              <p>
                All outbound traffic intercepted. Unknown domains held for
                approval. 60-second timeout means deny. Little Snitch for AI.
              </p>
            </div>

            <div className="bento-card bento-accent reveal reveal-delay-3">
              <div
                className="bento-inline-icon"
                style={{ background: "rgba(6, 182, 212, 0.12)" }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--cyan)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <polyline points="9 12 12 15 16 10" />
                </svg>
              </div>
              <h3>Policy-Gated Integrations</h3>
              <p>
                Gmail, Drive, Calendar, GitHub, Slack &mdash; each with
                per-terminal policies controlling senders, repos, and actions.
              </p>
            </div>

            <div className="bento-card bento-dark reveal reveal-delay-4">
              <div
                className="bento-inline-icon"
                style={{ background: "rgba(34, 197, 94, 0.12)" }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--green)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <h3>OAuth Tokens Stay Server-Side</h3>
              <p>
                OAuth tokens stored encrypted on the control plane. They never
                reach the sandbox. All API calls made server-side.
              </p>
            </div>

            <div className="bento-card bento-subtle reveal reveal-delay-4">
              <div
                className="bento-inline-icon"
                style={{ background: "rgba(139, 92, 246, 0.1)" }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--purple)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </div>
              <h3>Full Audit Trail</h3>
              <p>
                Every action logged before response. Review what agents accessed,
                when, and what was returned. Disconnect anytime.
              </p>
            </div>
          </div>
        </section>

        {/* INTEGRATIONS MARQUEE */}
        <section id="integrations" style={{ textAlign: "center" }}>
          <div className="reveal">
            <div className="section-label">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              Integrations
            </div>
            <h2 className="section-title">A growing ecosystem.</h2>
            <p className="section-desc" style={{ margin: "0 auto" }}>
              OrcaBot connects to the tools, agents, and services you already
              use. Every integration is optional and controlled by policies you
              define.
            </p>
          </div>

          <div className="marquee-wrap reveal reveal-delay-1">
            <div className="marquee-fade-left" />
            <div className="marquee-fade-right" />
            <div className="marquee-track">
              {/* Doubled for seamless loop */}
              {[...INTEGRATIONS, ...INTEGRATIONS].map((item, i) => (
                <span key={i} className="integration-chip">
                  {item.img ? (
                    <img src={item.img} alt={item.name} />
                  ) : (
                    item.icon
                  )}
                  {item.name}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section>
          <div className="reveal">
            <div className="section-label">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              How It Works
            </div>
            <h2 className="section-title">Five steps to get started.</h2>
          </div>

          <div className="steps">
            <div className="step reveal reveal-delay-1">
              <div className="step-num">1</div>
              <div>
                <h3>Create a Dashboard</h3>
                <p>
                  Sign in and create a new dashboard &mdash; a shared workspace
                  where you place terminals, notes, browser previews, and
                  integration blocks on an infinite canvas.
                </p>
              </div>
            </div>
            <div className="step reveal reveal-delay-2">
              <div className="step-num">2</div>
              <div>
                <h3>Launch a Terminal</h3>
                <p>
                  Add a terminal block to your dashboard. OrcaBot provisions a
                  sandboxed Linux VM and connects it to your browser via a secure
                  WebSocket.
                </p>
              </div>
            </div>
            <div className="step reveal reveal-delay-3">
              <div className="step-num">3</div>
              <div>
                <h3>Run an AI Agent</h3>
                <p>
                  Start an AI coding agent (Claude Code, Codex, Gemini CLI,
                  etc.) inside the terminal. The agent writes, runs, and tests
                  code in the sandbox.
                </p>
              </div>
            </div>
            <div className="step reveal reveal-delay-4">
              <div className="step-num">4</div>
              <div>
                <h3>Connect Integrations</h3>
                <p>
                  Attach Gmail, Drive, Calendar, or GitHub to a terminal so
                  agents can access relevant context. You define policies that
                  control exactly what agents can see and do.
                </p>
              </div>
            </div>
            <div className="step reveal reveal-delay-4">
              <div className="step-num">5</div>
              <div>
                <h3>Collaborate &amp; Ship</h3>
                <p>
                  Share your dashboard with teammates. Everyone can see agent
                  output in real-time, provide input, and review results
                  together.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* USE CASES */}
        <section id="usecases">
          <div className="reveal">
            <div className="section-label">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
              Use Cases
            </div>
            <h2 className="section-title">What can you build?</h2>
            <p className="section-desc">
              From personal assistants to multi-agent tournaments, the only limit
              is your imagination.
            </p>
          </div>

          <div className="usecases">
            <div className="usecase-card reveal reveal-delay-1">
              <span className="usecase-emoji" aria-hidden="true">
                &#x1f4c5;
              </span>
              <h3>Personal AI Assistant</h3>
              <p>
                Set up an agent that manages your meeting schedule and handles
                booking requests. Configure it to only respond to emails with a
                specific subject line and only with calendar invites, so you
                don&apos;t get prompt-hacked out of your crypto savings.
              </p>
            </div>
            <div className="usecase-card reveal reveal-delay-2">
              <span className="usecase-emoji" aria-hidden="true">
                &#x1f504;
              </span>
              <h3>Ralph Wiggum Loop</h3>
              <p>
                A sophisticated code review loop where one agent writes code and
                another reviews it. Unlike other services that use the same model
                for both, OrcaBot lets you pair different AI providers so the
                reviewer isn&apos;t biased by its own weights.
              </p>
            </div>
            <div className="usecase-card reveal reveal-delay-3">
              <span className="usecase-emoji" aria-hidden="true">
                &#x265f;&#xfe0f;
              </span>
              <h3>AI Chess Tournament</h3>
              <p>
                Get agents to play chess against each other. We&apos;re planning
                a benchmark where AI models compete in a tournament. Multiple
                terminals on a shared dashboard, each running a different model.
                Who wins? Stay tuned.
              </p>
            </div>
          </div>
        </section>

        {/* BOTTOM CTA */}
        <div className="cta-section">
          <div className="cta-glow" />
          <div className="reveal">
            <h2>Ready to run your agents?</h2>
            <p>
              Sign in, create a dashboard, and start building in seconds. No
              installs required.
            </p>
            <a
              href={ctaHref}
              className="btn btn-primary"
              style={{ fontSize: "1rem", padding: "14px 32px" }}
              onClick={handleLoginClick}
            >
              {ctaText}
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </a>
          </div>
        </div>

        {/* FOOTER */}
        <footer className="sp-footer">
          <div className="footer-top">
            <span className="footer-brand">
              OrcaBot. Sandboxed, multiplayer AI coding platform.
            </span>
            <div className="footer-links">
              <a href="/privacy">Privacy Policy</a>
              <a href="/terms">Terms of Service</a>
            </div>
          </div>
          <div className="footer-bottom">
            By using OrcaBot, you agree to our{" "}
            <a href="/terms">Terms of Service</a> and{" "}
            <a href="/privacy">Privacy Policy</a>.
          </div>
        </footer>
      </div>
    </div>
  );
}
