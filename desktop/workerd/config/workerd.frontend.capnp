# workerd config (Cap'n Proto text format)
# This runs the frontend Worker bundle on localhost for desktop use.

using Workerd = import "/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "internet", network = (
      allow = ["public", "private", "local"]
    )),
    # Asset service reads static files from disk
    (name = "assets", worker = (
      modules = [
        (name = "worker.js", esModule = embed "../assets-service/worker.js")
      ],
      compatibilityDate = "2024-09-23",
      compatibilityFlags = ["nodejs_compat"],
      bindings = [
        (name = "ASSETS_DIR", fromEnvironment = "ASSETS_DIR")
      ]
    )),
    # Frontend worker - the bundled OpenNext worker
    (name = "frontend", worker = (
      modules = [
        (name = "worker.js", esModule = embed "../../frontend/worker.js"),
        # WASM modules required by Next.js image optimization
        (name = "77d9faebf7af9e421806970ce10a58e9d83116d7-resvg.wasm?module", wasm = embed "../../frontend/77d9faebf7af9e421806970ce10a58e9d83116d7-resvg.wasm"),
        (name = "ef4866ecae192fd87727067cf2c0c0cf9fb8b020-yoga.wasm?module", wasm = embed "../../frontend/ef4866ecae192fd87727067cf2c0c0cf9fb8b020-yoga.wasm")
      ],
      compatibilityDate = "2024-09-23",
      compatibilityFlags = ["nodejs_compat"],
      globalOutbound = "internet",
      bindings = [
        (name = "ASSETS", service = "assets"),
        (name = "NEXT_PUBLIC_API_URL", fromEnvironment = "NEXT_PUBLIC_API_URL"),
        (name = "NEXT_PUBLIC_SITE_URL", fromEnvironment = "NEXT_PUBLIC_SITE_URL"),
        (name = "NEXT_PUBLIC_DEV_MODE_ENABLED", fromEnvironment = "NEXT_PUBLIC_DEV_MODE_ENABLED")
      ]
    ))
  ],

  sockets = [
    (name = "http", service = "frontend")
  ]
);
