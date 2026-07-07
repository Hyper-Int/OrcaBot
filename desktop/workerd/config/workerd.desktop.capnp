# workerd config (Cap'n Proto text format)
# This runs the controlplane Worker bundle on localhost for desktop use.
#
# Bindings declared here must stay in sync with the env vars referenced by
# the controlplane code (controlplane/src/**/*.ts → env.X) and the secrets
# listed in controlplane/wrangler.production.toml.
#
# Drift check:  node desktop/scripts/check-drift.mjs
# Intentional gaps are documented in desktop/scripts/drift-allowlist.json.

using Workerd = import "/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "internet", network = (
      # public = internet APIs (OAuth token exchange, provider APIs); local =
      # the loopback d1-shim (:9001) + sandbox (:8080). "private" is deliberately
      # dropped so a control-plane SSRF can't reach private-LAN hosts
      # (10.0.0.0/8, 192.168.0.0/16, …) — nothing here needs it.
      allow = ["public", "local"],
      # Enable outbound HTTPS from the control-plane worker (OAuth token
      # exchange, provider APIs, Resend, etc.). Without tlsOptions, workerd's
      # network service is HTTP-only and every server-side fetch to an https://
      # URL fails with "this HttpClient doesn't support HTTPS".
      tlsOptions = (trustBrowserCas = true)
    )),
    (name = "d1-shim", external = (
      address = "127.0.0.1:9001",
      http = ()
    )),
    (name = "controlplane", worker = (
      modules = [
        # The bundled worker output from desktop/workerd/dist/worker.js
        (name = "worker.js", esModule = embed "../dist/worker.js")
      ],
      compatibilityDate = "2024-01-01",
      globalOutbound = "internet",
      bindings = [
        # Core
        (name = "SANDBOX_URL", fromEnvironment = "SANDBOX_URL"),
        (name = "SANDBOX_INTERNAL_TOKEN", fromEnvironment = "SANDBOX_INTERNAL_TOKEN"),
        (name = "INTERNAL_API_TOKEN", fromEnvironment = "INTERNAL_API_TOKEN"),
        (name = "D1_HTTP_URL", fromEnvironment = "D1_HTTP_URL"),
        (name = "D1_SHIM", service = "d1-shim"),
        (name = "D1_SHIM_DEBUG", fromEnvironment = "D1_SHIM_DEBUG"),
        (name = "DEV_AUTH_ENABLED", fromEnvironment = "DEV_AUTH_ENABLED"),
        (name = "ALLOWED_ORIGINS", fromEnvironment = "ALLOWED_ORIGINS"),
        (name = "FRONTEND_URL", fromEnvironment = "FRONTEND_URL"),

        # Secrets / crypto
        (name = "SECRETS_ENCRYPTION_KEY", fromEnvironment = "SECRETS_ENCRYPTION_KEY"),

        # OAuth — pass through optionally; empty = feature disabled.
        # Desktop is a PUBLIC OAuth client (embedded client_id, no protectable
        # secret) so it uses the PKCE flow — always on here, unset in cloud.
        (name = "OAUTH_PUBLIC_CLIENT", text = "true"),
        (name = "OAUTH_REDIRECT_BASE", fromEnvironment = "OAUTH_REDIRECT_BASE"),
        (name = "GOOGLE_CLIENT_ID", fromEnvironment = "GOOGLE_CLIENT_ID"),
        (name = "GOOGLE_CLIENT_SECRET", fromEnvironment = "GOOGLE_CLIENT_SECRET"),
        (name = "GOOGLE_API_KEY", fromEnvironment = "GOOGLE_API_KEY"),
        (name = "GITHUB_CLIENT_ID", fromEnvironment = "GITHUB_CLIENT_ID"),
        (name = "GITHUB_CLIENT_SECRET", fromEnvironment = "GITHUB_CLIENT_SECRET"),
        (name = "MICROSOFT_CLIENT_ID", fromEnvironment = "MICROSOFT_CLIENT_ID"),
        (name = "MICROSOFT_CLIENT_SECRET", fromEnvironment = "MICROSOFT_CLIENT_SECRET"),
        (name = "ONEDRIVE_CLIENT_ID", fromEnvironment = "ONEDRIVE_CLIENT_ID"),
        (name = "ONEDRIVE_CLIENT_SECRET", fromEnvironment = "ONEDRIVE_CLIENT_SECRET"),
        (name = "BOX_CLIENT_ID", fromEnvironment = "BOX_CLIENT_ID"),
        (name = "BOX_CLIENT_SECRET", fromEnvironment = "BOX_CLIENT_SECRET"),
        (name = "TWITTER_CLIENT_ID", fromEnvironment = "TWITTER_CLIENT_ID"),
        (name = "TWITTER_CLIENT_SECRET", fromEnvironment = "TWITTER_CLIENT_SECRET"),
        (name = "DISCORD_CLIENT_ID", fromEnvironment = "DISCORD_CLIENT_ID"),
        (name = "DISCORD_CLIENT_SECRET", fromEnvironment = "DISCORD_CLIENT_SECRET"),
        (name = "SLACK_CLIENT_ID", fromEnvironment = "SLACK_CLIENT_ID"),
        (name = "SLACK_CLIENT_SECRET", fromEnvironment = "SLACK_CLIENT_SECRET"),

        # Email
        (name = "RESEND_API_KEY", fromEnvironment = "RESEND_API_KEY"),
        (name = "EMAIL_FROM", fromEnvironment = "EMAIL_FROM"),

        # Sandbox feature flags
        (name = "EGRESS_PROXY_ENABLED", fromEnvironment = "EGRESS_PROXY_ENABLED"),

        # Durable Objects
        (name = "DASHBOARD", durableObjectNamespace = (className = "DashboardDO")),
        (name = "RATE_LIMIT_COUNTER", durableObjectNamespace = (className = "RateLimitCounter")),
        (name = "ASR_STREAM", durableObjectNamespace = (className = "ASRStreamProxy"))
      ],
      durableObjectNamespaces = [
        (className = "DashboardDO", uniqueKey = "orcabot-desktop-dashboard"),
        (className = "RateLimitCounter", uniqueKey = "orcabot-desktop-rate-limit"),
        (className = "ASRStreamProxy", uniqueKey = "orcabot-desktop-asr-stream")
      ],
      durableObjectStorage = (localDisk = "do-storage")
    )),
    (name = "do-storage", disk = (writable = true))
  ],

  sockets = [
    (name = "http", service = "controlplane")
  ]
);
