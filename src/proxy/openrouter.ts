import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { OpenrouterKey, keyPool } from "../shared/key-management";
import { logger } from "../logger";

console.log("🚀 OpenRouter module loading...");

const log = logger.child({ module: "openrouter-proxy" });
log.info("OpenRouter module initialized");

let modelsCache: any = null;
let modelsCacheTime = 0;

const openrouterResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  req.log.info("📤 OpenRouter response handler called");
  
  if (typeof body !== "object") {
    req.log.error("❌ Expected body to be an object, got:", typeof body);
    throw new Error("Expected body to be an object");
  }

  req.log.info("✅ OpenRouter response processed successfully");
  res.status(200).json({ ...body, proxy: body.proxy });
};

const getModelsResponse = async () => {
  log.info("📋 Getting models response...");
  
  // Return cache if less than 1 minute old
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    log.info("📋 Using cached models response");
    return modelsCache;
  }

  try {
    log.info("🔑 Getting OpenRouter key...");
    // Get an OpenRouter key directly using keyPool.get()
    const openrouterKey = keyPool.get("openai/gpt-3.5-turbo", "openrouter") as OpenrouterKey;
    
    if (!openrouterKey || !openrouterKey.key) {
      log.error("❌ Failed to get valid openrouter key");
      throw new Error("Failed to get valid openrouter key");
    }
    
    log.info("✅ Got OpenRouter key, fetching models...");

    // Fetch models from OpenRouter API with authorization
    const response = await axios.get("https://openrouter.ai/api/v1/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openrouterKey.key}`
      },
    });

    log.info(`📋 Models fetched successfully, count: ${response.data?.data?.length || 0}`);

    // If successful, update the cache
    if (response.data && response.data.data) {
      modelsCache = {
        object: "list",
        data: response.data.data.map((model: any) => ({
          id: model.id,
          object: "model",
          owned_by: "openrouter",
        })),
      };
      log.info("✅ Models cache updated");
    } else {
      log.error("❌ Unexpected response format from openrouter API");
      throw new Error("Unexpected response format from openrouter API");
    }
  } catch (error) {
    log.error("❌ Error fetching openrouter models:", error);
    throw error;
  }

  modelsCacheTime = new Date().getTime();
  return modelsCache;
};

const handleModelRequest: RequestHandler = async (req, res) => {
  req.log.info("📋 Model request received");
  
  try {
    const modelsResponse = await getModelsResponse();
    req.log.info("✅ Models response ready, sending to client");
    res.status(200).json(modelsResponse);
  } catch (error) {
    req.log.error("❌ Error in handleModelRequest:", error);
    res.status(500).json({ error: "Failed to fetch models" });
  }
};

log.info("🔧 Creating OpenRouter proxy middleware...");

const openrouterProxy = createQueuedProxyMiddleware({
  mutations: [addKey, finalizeBody],
  target: "https://openrouter.ai",
  blockingResponseHandler: openrouterResponseHandler,
});

log.info("✅ OpenRouter proxy middleware created");

const openrouterRouter = Router();
log.info("🛣️ OpenRouter router created");

// Simple preprocessing function for OpenRouter
function preprocessOpenrouterRequest(req: Request) {
  req.log.info(`🔄 Processing OpenRouter request for model: ${req.body?.model || 'unknown'}`);
  req.log.info(`📊 Request body keys: ${Object.keys(req.body || {}).join(', ')}`);
  
  // Basic request preprocessing
  if (!req.body?.model) {
    req.log.warn("⚠️ No model specified in request");
  }
  
  req.log.info("✅ OpenRouter request preprocessing completed");
}

// Add middleware with logging
openrouterRouter.use((req, res, next) => {
  req.log = req.log || log;
  req.log.info(`🌐 OpenRouter middleware: ${req.method} ${req.path}`);
  req.log.info(`🔗 Full URL: ${req.originalUrl}`);
  req.log.info(`📝 Headers: ${JSON.stringify(req.headers, null, 2)}`);
  next();
});

log.info("🛣️ Setting up OpenRouter routes...");

openrouterRouter.post(
  "/chat/completions",
  (req, res, next) => {
    req.log.info("📨 Chat completions endpoint hit");
    next();
  },
  ipLimiter,
  (req, res, next) => {
    req.log.info("🚦 IP limiter passed");
    next();
  },
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "openrouter" },
    { afterTransform: [preprocessOpenrouterRequest] }
  ),
  (req, res, next) => {
    req.log.info("🔄 Preprocessor middleware passed");
    next();
  },
  openrouterProxy
);

openrouterRouter.get("/v1/models", (req, res, next) => {
  req.log.info("📋 Models endpoint hit");
  next();
}, handleModelRequest);

// Catch-all for debugging
openrouterRouter.use("*", (req, res, next) => {
  req.log.warn(`❓ Unmatched OpenRouter route: ${req.method} ${req.path}`);
  req.log.warn(`🔗 Original URL: ${req.originalUrl}`);
  next();
});

log.info("✅ OpenRouter routes configured");

console.log("✅ OpenRouter module loaded successfully");
log.info("OpenRouter router ready for export");

export const openrouter = openrouterRouter;