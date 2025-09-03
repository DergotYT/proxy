import express from "express";
import { addV1 } from "./add-v1";
import { anthropic } from "./anthropic";
import { aws } from "./aws";
import { azure } from "./azure";
import { checkRisuToken } from "./check-risu-token";
import { gatekeeper } from "./gatekeeper";
import { gcp } from "./gcp";
import { googleAI } from "./google-ai";
import { mistralAI } from "./mistral-ai";
import { openai } from "./openai";
import { openaiImage } from "./openai-image";
import { deepseek } from "./deepseek";
import { xai } from "./xai";
import { openrouter } from "./openrouter";
import { cohere } from "./cohere";
import { qwen } from "./qwen";
import { moonshot } from "./moonshot";
import { sendErrorToClient } from "./middleware/response/error-generator";
import { logger } from "../logger";

console.log("🚀 Routes module loading...");

const log = logger.child({ module: "routes" });
log.info("Routes module initialized");

const proxyRouter = express.Router();
log.info("Proxy router created");

// Remove `expect: 100-continue` header from requests due to incompatibility
// with node-http-proxy.
proxyRouter.use((req, _res, next) => {
  if (req.headers.expect) {
    delete req.headers.expect;
  }
  next();
});

log.info("Setting up body parsers...");
// Apply body parsers.
proxyRouter.use(
  express.json({ limit: "100mb" }),
  express.urlencoded({ extended: true, limit: "100mb" })
);

log.info("Setting up auth/rate limits...");
// Apply auth/rate limits.
proxyRouter.use(gatekeeper);
proxyRouter.use(checkRisuToken);

// Initialize request queue metadata.
proxyRouter.use((req, _res, next) => {
  req.startTime = Date.now();
  req.retryCount = 0;
  next();
});

log.info("Setting up proxy endpoints...");

// Check if openrouter module loaded correctly
console.log("📋 Checking openrouter import:", typeof openrouter);
log.info(`OpenRouter import type: ${typeof openrouter}`);

if (!openrouter) {
  log.error("❌ OpenRouter module failed to import!");
  console.error("❌ OpenRouter module failed to import!");
} else {
  log.info("✅ OpenRouter module imported successfully");
  console.log("✅ OpenRouter module imported successfully");
}

// Add logging middleware for all routes
proxyRouter.use((req, res, next) => {
  req.log = req.log || log.child({ reqId: req.id || Math.random().toString(36).substr(2, 9) });
  req.log.info(`🌐 Request: ${req.method} ${req.path} (Original: ${req.originalUrl})`);
  next();
});

// Proxy endpoints.
log.info("Registering proxy endpoints...");

proxyRouter.use("/openai", addV1, openai);
log.info("✅ OpenAI endpoint registered: /openai");

proxyRouter.use("/openai-image", addV1, openaiImage);
log.info("✅ OpenAI Image endpoint registered: /openai-image");

proxyRouter.use("/anthropic", addV1, anthropic);
log.info("✅ Anthropic endpoint registered: /anthropic");

proxyRouter.use("/google-ai", addV1, googleAI);
log.info("✅ Google AI endpoint registered: /google-ai");

proxyRouter.use("/mistral-ai", addV1, mistralAI);
log.info("✅ Mistral AI endpoint registered: /mistral-ai");

proxyRouter.use("/aws", aws);
log.info("✅ AWS endpoint registered: /aws");

proxyRouter.use("/gcp/claude", addV1, gcp);
log.info("✅ GCP endpoint registered: /gcp/claude");

proxyRouter.use("/azure/openai", addV1, azure);
log.info("✅ Azure endpoint registered: /azure/openai");

proxyRouter.use("/deepseek", addV1, deepseek);
log.info("✅ Deepseek endpoint registered: /deepseek");

proxyRouter.use("/xai", addV1, xai);
log.info("✅ XAI endpoint registered: /xai");

// OpenRouter endpoint with extra logging
console.log("📋 About to register OpenRouter endpoint...");
log.info("About to register OpenRouter endpoint...");

try {
  proxyRouter.use("/openrouter", addV1, openrouter);
  console.log("✅ OpenRouter endpoint registered successfully: /openrouter");
  log.info("✅ OpenRouter endpoint registered successfully: /openrouter");
} catch (error) {
  console.error("❌ Failed to register OpenRouter endpoint:", error);
  log.error("❌ Failed to register OpenRouter endpoint:", error);
}

proxyRouter.use("/cohere", addV1, cohere);
log.info("✅ Cohere endpoint registered: /cohere");

proxyRouter.use("/qwen", addV1, qwen);
log.info("✅ Qwen endpoint registered: /qwen");

proxyRouter.use("/moonshot", addV1, moonshot);
log.info("✅ Moonshot endpoint registered: /moonshot");

// Debug middleware to log all registered routes
proxyRouter.use((req, res, next) => {
  req.log.info(`🛣️ Route check: ${req.method} ${req.path}`);
  req.log.info(`📍 Base URL: ${req.baseUrl}`);
  req.log.info(`🔗 Original URL: ${req.originalUrl}`);
  
  // Check if this is an OpenRouter request
  if (req.path.includes('openrouter') || req.originalUrl.includes('openrouter')) {
    req.log.info("🎯 This is an OpenRouter request!");
    console.log("🎯 OpenRouter request detected:", {
      method: req.method,
      path: req.path,
      originalUrl: req.originalUrl,
      baseUrl: req.baseUrl
    });
  }
  
  next();
});

// Redirect browser requests to the homepage.
proxyRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    req.log.info("🌐 Browser request detected, redirecting to homepage");
    res.redirect("/");
  } else {
    next();
  }
});

// Send a fake client error if user specifies an invalid proxy endpoint.
proxyRouter.use((req, res) => {
  req.log.warn(`❌ Unmatched route: ${req.method} ${req.originalUrl}`);
  console.log(`❌ Unmatched route: ${req.method} ${req.originalUrl}`);
  
  sendErrorToClient({
    req,
    res,
    options: {
      title: "Proxy error (HTTP 404 Not Found)",
      message: "The requested proxy endpoint does not exist.",
      model: req.body?.model,
      reqId: req.id,
      format: "unknown",
      obj: {
        proxy_note:
          "Your chat client is using the wrong endpoint. Check the Service Info page for the list of available endpoints.",
        requested_url: req.originalUrl,
      },
    },
  });
});

console.log("✅ Routes module loaded successfully");
log.info("Routes configuration completed");

export { proxyRouter as proxyRouter };