// src/proxy/openrouter.ts

import { Router } from "express";
import { ipLimiter } from "./rate-limit";
import { addKey, createPreprocessorMiddleware, finalizeBody } from "./middleware/request";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { ProxyReqManager } from "./middleware/request/proxy-req-manager";

const openRouterBaseUrl = "https://openrouter.ai/api/v1";

function selectUpstreamPath(manager: ProxyReqManager) {
  const req = manager.request;
  const pathname = req.url.split("?")[0];
  
  // ИСПРАВЛЕНИЕ: Удаляем /v1/ префикс, который был добавлен addV1 или уже присутствовал.
  let newPathname = pathname;

  // Если путь начинается с /v1/, удаляем его.
  // Например: /v1/chat/completions -> /chat/completions
  if (newPathname.startsWith("/v1/")) {
    newPathname = newPathname.substring(3);
  }

  // Обновляем путь, сохраняя query parameters (если они были)
  manager.setPath(newPathname + req.url.substring(pathname.length));
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