// src/proxy/openrouter.ts

import { Router } from "express";
import { ipLimiter } from "./rate-limit";
import { addKey, createPreprocessorMiddleware, finalizeBody } from "./middleware/request";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { ProxyReqManager } from "./middleware/request/proxy-req-manager";

const openRouterBaseUrl = "https://openrouter.ai/api/v1";

function selectUpstreamPath(manager: ProxyReqManager) {
  const req = manager.request;
  let pathname = req.url.split("?")[0];

  // OpenRouter's API URL already contains /api/v1.
  // The path coming here from the router (e.g., /v1/chat/completions) needs to be stripped of /v1.
  if (pathname.startsWith("/v1/")) {
    pathname = pathname.substring(3); // Removes "/v1"
  }
  
  // Clean up any other variations like /v1
  if (pathname === "/v1") {
      pathname = "/";
  }

  // Use the cleaned pathname
  manager.setPath(pathname);
}

const openRouterProxy = createQueuedProxyMiddleware({
  target: openRouterBaseUrl,
  // OpenRouter uses an OpenAI-compatible API for chat completions
  mutations: [selectUpstreamPath, addKey, finalizeBody],
});

const openRouterPreprocessor = createPreprocessorMiddleware(
  {
    inApi: "openai", 
    outApi: "openai", 
    service: "openrouter" 
  },
  { 
    afterTransform: [] 
  }
);

const openrouterRouter = Router();

// Endpoint for chat completions (OpenAI compatible)
openrouterRouter.post(
  "/chat/completions",
  ipLimiter,
  openRouterPreprocessor,
  openRouterProxy
);

// Endpoint for model listing
openrouterRouter.get(
    "/models",
    ipLimiter,
    openRouterProxy
);

export const openrouter = openrouterRouter;