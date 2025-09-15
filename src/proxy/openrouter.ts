import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { OpenrouterKey, keyPool } from "../shared/key-management";
import { isFreeOpenRouterModel } from "../shared/models/openrouter-free-models";

let modelsCache: any = null;
let modelsCacheTime = 0;

const openrouterResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  let responseBody = body;
  
  // Если тело ответа — строка, пытаемся распарсить её как JSON
  if (typeof body === 'string') {
    // Проверяем, не является ли ответ HTML
    if (body.trim().startsWith('<!DOCTYPE') || body.trim().startsWith('<html')) {
      // Это HTML ответ, вероятно ошибка
      req.log.warn({ response: body.slice(0, 200) }, "OpenRouter returned HTML instead of JSON");
      throw new Error("OpenRouter returned HTML response, likely an error page");
    }
    
    try {
      responseBody = JSON.parse(body);
    } catch (e) {
      // Если не удалось распарсить, создаём объект ошибки
      responseBody = {
        error: {
          message: body,
          type: 'invalid_response'
        }
      };
    }
  }

  if (typeof responseBody !== "object") {
    throw new Error("Expected body to be an object");
  }

  // Проверяем наличие ошибок в ответе OpenRouter
  if (responseBody.error) {
    req.log.warn(
      { error: responseBody.error, key: req.key?.hash },
      "OpenRouter API returned an error"
    );
    
    // Если это ошибка "model not found", преобразуем её в стандартный формат
    if (responseBody.error.message && responseBody.error.message.includes("model not found")) {
      responseBody = {
        error: {
          message: `The model "${req.body.model}" is not available on OpenRouter`,
          type: "invalid_request_error",
          code: "model_not_found"
        }
      };
    }
  }

  res.status(200).json({ ...responseBody, proxy: responseBody.proxy });
};

const getModelsResponse = async () => {
  // Return cache if less than 1 minute old
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  try {
    // Get an OpenRouter key directly using keyPool.get()
    const modelToUse = "anthropic/claude-3-sonnet"; // Use a valid OpenRouter model
    const openrouterKey = keyPool.get(modelToUse, "openrouter") as OpenrouterKey;
    
    if (!openrouterKey || !openrouterKey.key) {
      throw new Error("Failed to get valid OpenRouter key");
    }

    // Fetch models from OpenRouter API with authorization
    const response = await axios.get("https://openrouter.ai/api/v1/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openrouterKey.key}`
      },
    });

    // If successful, update the cache
    if (response.data && Array.isArray(response.data)) {
      modelsCache = {
        object: "list",
        data: response.data.map((model: any) => ({
          id: model.id,
          object: "model",
          owned_by: model.organization || "openrouter",
        })),
      };
    } else {
      throw new Error("Unexpected response format from OpenRouter API");
    }
  } catch (error) {
    console.error("Error fetching OpenRouter models:", error);
    throw error;
  }

  modelsCacheTime = new Date().getTime();
  return modelsCache;
};

const handleModelRequest: RequestHandler = async (_req, res) => {
  try {
    const modelsResponse = await getModelsResponse();
    res.status(200).json(modelsResponse);
  } catch (error) {
    console.error("Error in handleModelRequest:", error);
    res.status(500).json({ error: "Failed to fetch models" });
  }
};

const openrouterProxy = createQueuedProxyMiddleware({
  mutations: [addKey, finalizeBody],
  target: "https://openrouter.ai/api", // Correct API endpoint
  blockingResponseHandler: openrouterResponseHandler,
});

const openrouterRouter = Router();

// Function to handle OpenRouter-specific request transformations
// Обновим функцию prepareOpenRouterRequest
function prepareOpenRouterRequest(req: Request) {
  // Установим max_tokens по умолчанию в 1000
  if (req.body.max_tokens === undefined) {
    req.body.max_tokens = 1000;
  }
  
  // Проверим, является ли модель бесплатной
  const model = req.body.model;
  const isFreeModel = isFreeOpenRouterModel(model);
  
  // Если ключ бесплатный, но модель платная - выдаем ошибку
  if (req.key && (req.key as OpenrouterKey).isFreeTier && !isFreeModel) {
    throw new Error(
      `Free tier OpenRouter keys can only be used with free models. ` +
      `Model '${model}' is not a free model. ` +
      `Please use a paid key or select a free model.`
    );
}}

// Handler for image generation requests
const handleImageGenerationRequest: RequestHandler = async (req, res) => {
  try {
    // OpenRouter doesn't have a dedicated image generation endpoint like XAI
    // We'll use the chat completions endpoint with a special model
    const modelToUse = req.body.model || "stability-ai/stable-diffusion-xl"; // Default model
    const openrouterKey = keyPool.get(modelToUse, "openrouter") as OpenrouterKey;
    
    if (!openrouterKey || !openrouterKey.key) {
      throw new Error("Failed to get valid OpenRouter key for image generation");
    }
    
    // Forward the request to OpenRouter API's chat completions endpoint
    const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", req.body, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openrouterKey.key}`
      },
    });
    
    // Return the response directly
    res.status(200).json(response.data);
  } catch (error) {
    req.log.error({ error }, "Error in image generation request");
    // Pass through the error response if available
    if (error.response && error.response.data) {
      res.status(error.response.status || 500).json(error.response.data);
    } else {
      res.status(500).json({ error: "Failed to generate image", message: error.message });
    }
  }
};

openrouterRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "openrouter" },
    { afterTransform: [prepareOpenRouterRequest] }
  ),
  openrouterProxy
);

// Add endpoint for image generation
openrouterRouter.post(
  "/v1/images/generations",
  ipLimiter,
  handleImageGenerationRequest
);

openrouterRouter.get("/v1/models", handleModelRequest);

export const openrouter = openrouterRouter;