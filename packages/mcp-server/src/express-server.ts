import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { authMiddleware, mcp } from "./middleware.js";
import { config } from "./config/environment.js";
import mcpServer from "./index.js";
import { createLogger } from "./utils/logger.js";
import cors from "cors";

const logger = createLogger("ExpressServer");

async function main() {
  const app = express();

  const currentDir = __dirname;
  const projectRoot = path.join(currentDir, "..");
  const isDev = config.isDevelopment || process.env.NODE_ENV !== 'production';

  if (isDev) {
    // In dev mode, allow all origins BEFORE any other middleware.
    // This must run first so Vite-served assets and ngrok tunnels get CORS headers.
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
      res.setHeader("Access-Control-Allow-Headers", "X-Requested-With,Content-Type,Authorization,ngrok-skip-browser-warning");
      res.setHeader("Access-Control-Allow-Credentials", "true");

      if (req.method === "OPTIONS") {
        return res.sendStatus(200);
      }
      next();
    });
  } else {
    app.use(
      cors({
        origin: [
          "https://chatgpt.com",
          "https://chat.openai.com",
          /https:\/\/.*\.oaiusercontent\.com$/,
          "https://claude.ai",
          /https:\/\/.*\.claude\.ai$/,
        ],
        credentials: true,
      }),
    );
  }

  app.use(express.json({ limit: "50mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "healthy", service: "delegare-mcp" });
  });

  // Serve manifest.json for Smithery and other clients
  app.get("/manifest.json", (_req, res) => {
    res.sendFile(path.join(projectRoot, "manifest.json"));
  });

  // MCP protocol handler with auth
  app.use("/mcp", authMiddleware);
  app.use(mcp(mcpServer));

  if (isDev) {
    logger.info(
      "Running in development mode, Vite middleware will be enabled.",
    );

    try {
      const vite = await import("vite");
      const viteServer = await vite.createServer({
        root: projectRoot,
        server: {
          middlewareMode: true,
          allowedHosts: true,
          hmr: {
            overlay: false,
          },
        },
        appType: "custom",
        base: "/",
      });
      app.use(viteServer.middlewares);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error(
        `Failed to create Vite server. Please run 'pnpm install'. Error: ${error}`,
      );
      process.exit(1);
    }
  } else {
    // Prod static files — serve built web assets and public directory
    app.use(express.static(path.join(currentDir, "web")));
    app.use(express.static(currentDir));
    app.use(express.static(path.join(projectRoot, "public")));
  }

  const port = config.port || 3000;
  app.listen(port, () => {
    logger.info(`🚀 Delegare MCP server listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start Delegare MCP server:", err);
  process.exit(1);
});
