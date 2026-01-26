# workerd config (Cap'n Proto text format)
# This runs the controlplane Worker bundle on localhost for desktop use.

using Workerd = import "/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "internet", network = (
      allow = ["public", "private", "local"]
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
        (name = "SANDBOX_URL", fromEnvironment = "SANDBOX_URL"),
        (name = "SANDBOX_INTERNAL_TOKEN", fromEnvironment = "SANDBOX_INTERNAL_TOKEN"),
        (name = "INTERNAL_API_TOKEN", fromEnvironment = "INTERNAL_API_TOKEN"),
        (name = "D1_HTTP_URL", fromEnvironment = "D1_HTTP_URL"),
        (name = "D1_SHIM", service = "d1-shim"),
        (name = "D1_SHIM_DEBUG", fromEnvironment = "D1_SHIM_DEBUG"),
        (name = "DEV_AUTH_ENABLED", fromEnvironment = "DEV_AUTH_ENABLED"),
        (name = "ALLOWED_ORIGINS", fromEnvironment = "ALLOWED_ORIGINS"),
        (name = "FRONTEND_URL", fromEnvironment = "FRONTEND_URL"),
        (name = "DASHBOARD", durableObjectNamespace = (className = "DashboardDO"))
      ],
      durableObjectNamespaces = [
        (className = "DashboardDO", uniqueKey = "orcabot-desktop-dashboard")
      ],
      durableObjectStorage = (localDisk = "do-storage")
    )),
    (name = "do-storage", disk = (writable = true))
  ],

  sockets = [
    (name = "http", service = "controlplane")
  ]
);
