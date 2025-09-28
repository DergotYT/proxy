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
  
  // OpenRouter использует путь /v1/...
  // Если addV1 убрал /v1/, то путь будет, например, /chat/completions.
  // Мы должны убедиться, что путь для проксирования начнется с /v1/, если он не начинается с него.
  
  if (!pathname.startsWith("/v1/")) {
    manager.setPath(`/v1${pathname}`);
  }
}

const openRouterProxy = createQueuedProxyMiddleware({
  target: "https://openrouter.ai", // Target должен быть без /v1, т.к. мы его добавляем в selectUpstreamPath
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

// Endpoint для всего, что не /models
// Поскольку addV1 убирает /v1, этот маршрут должен ловить все, что осталось (например, /chat/completions)
openrouterRouter.post(
  "/*", // <-- Ловит все POST-запросы, включая /chat/completions
  ipLimiter,
  openRouterPreprocessor,
  openRouterProxy
);

// Endpoint для model listing
openrouterRouter.get(
    "/models",
    ipLimiter,
    openRouterProxy
);

export const openrouter = openrouterRouter;