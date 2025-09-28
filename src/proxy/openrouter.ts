// src/proxy/openrouter.ts

import { Router } from "express";
import { ipLimiter } from "./rate-limit";
import { addKey, createPreprocessorMiddleware, finalizeBody } from "./middleware/request";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { ProxyReqManager } from "./middleware/request/proxy-req-manager";

const openRouterTarget = "https://openrouter.ai";
const openRouterApiPrefix = "/api/v1";

function selectUpstreamPath(manager: ProxyReqManager) {
  const req = manager.request;
  const pathname = req.url.split("?")[0];
  
  // После прохода через proxyRouter.use("/openrouter", addV1, ...)
  // Входящий URL /proxy/openrouter/v1/chat/completions превратился в /chat/completions.
  // Нам нужно преобразовать его в /api/v1/chat/completions.
  
  // Если addV1 не сработал и путь остался /v1/chat/completions:
  if (pathname.startsWith("/v1")) {
      manager.setPath(`${openRouterApiPrefix}${pathname.slice(3)}`);
  } 
  // Если addV1 сработал и путь /chat/completions:
  else if (!pathname.startsWith(openRouterApiPrefix)) {
    manager.setPath(`${openRouterApiPrefix}${pathname}`);
  }
  
  // Добавляем логирование для отладки
  req.log.debug({ originalUrl: req.originalUrl, finalPath: manager.path }, "OpenRouter path selection");
}


const openRouterProxy = createQueuedProxyMiddleware({
  target: openRouterTarget,
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