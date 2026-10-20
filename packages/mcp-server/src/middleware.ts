import type { NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { McpServer } from "skybridge/server";
import { validateToken } from "./utils/auth.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("Middleware");

export const corsMiddleware = cors({
  origin: [
    "https://chatgpt.com",
    "https://chat.openai.com",
    /https:\/\/.*\.oaiusercontent\.com$/,
    "https://claude.ai",
    /https:\/\/.*\.claude\.ai$/,
    "http://localhost:3000",
  ],
  credentials: true,
});

export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  if (req.path === "/health" || req.path === "/manifest.json" || req.path.startsWith("/web")) {
    next();
    return;
  }

  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  const merchantId = req.headers["x-delegare-merchant-id"];
  const apiKey = req.headers["x-delegare-api-key"];
  
  if (!authHeader && !merchantId && !apiKey) {
    if (process.env.NODE_ENV !== "production" || process.env.SKIP_AUTH === "true") {
       logger.info("Missing Authorization header in dev mode, using mock claims");
       const mockClaims = await validateToken("mock-token");
       (req as any).merchantClaims = mockClaims;
       next();
       return;
    }
    res.status(401).json({ error: "Missing Authorization header or Delegare API keys" });
    return;
  }

  const claims = authHeader ? await validateToken(authHeader as string) : {};
  (req as any).merchantClaims = claims;
  next();
};

export const mcp = (server: McpServer<any>) => (req: Request, res: Response, next: NextFunction): void => {
  corsMiddleware(req, res, (err: any) => {
    if (err) return next(err);

    const handler = async () => {
      if (req.method !== "POST") {
        return next();
      }

      // ChatGPT adds proprietary fields like "__nv_message_id" and "kind" to MCP messages
      if (req.body) {
        const stripKeys = (obj: any) => {
          if (!obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            obj.forEach(stripKeys);
            return;
          }
          delete obj.__nv_message_id;
          delete obj.kind;
          Object.values(obj).forEach(stripKeys);
        };
        stripKeys(req.body);
      }

      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });

        res.on("close", () => transport.close());
        await server.connect(transport);

        await transport.handleRequest(req, res, req.body);
      } catch (error: any) {
        logger.error({ error }, "Error handling MCP request");
        
        // If it's a ZodError, don't let it bubble to the global Express error handler
        // which would return a raw JSON array (breaking ChatGPT's client-side parser).
        // Instead, return a valid JSON-RPC error object.
        if (!res.headersSent) {
          const isZod = error.name === 'ZodError' || Array.isArray(error.errors);
          const message = isZod ? "Invalid JSON-RPC request structure" : (error.message || "Internal server error");
          const code = isZod ? -32600 : -32603;

          res.status(isZod ? 400 : 500).json({
            jsonrpc: "2.0",
            error: { code, message, data: isZod ? error.errors : undefined },
            id: req.body?.id || null,
          });
        }
      }
    };

    handler().catch(next);
  });
};
