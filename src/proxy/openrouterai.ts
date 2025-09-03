import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { OpenrouteraiKey, keyPool } from "../shared/key-management";
import { isOpenrouteraiVisionModel, isOpenrouteraiImageGenModel, isOpenrouteraiReasoningModel, isOpenrouteraiReasoningEffortModel, isOpenrouteraiReasoningContentModel } from "../shared/api-schemas/Openrouterai";

let modelsCache: any = null;
let modelsCacheTime = 0;

const openrouteraiResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  req.log.info("OpenRouter response handler started");
  
  if (typeof body !== "object") {
    req.log.error("Expected body to be an object", { bodyType: typeof body });
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  
  // Check if this is an image generation response
  if (body.data && Array.isArray(body.data)) {
    req.log.debug(
      { imageCount: body.data.length },
      "Grok image generation response detected"
    );
    
    const images = body.data;
    req.log.info(`Transforming ${images.length} image(s) to chat format`);
    
    newBody = {
      id: `grok-image-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.body.model,
      choices: images.map((image, index) => {
        let content = '';
        
        if (image.b64_json) {
          const imgData = image.b64_json.startsWith('data:image/') 
            ? image.b64_json 
            : `data:image/jpeg;base64,${image.b64_json}`;
          
          content = `![Generated Image](${imgData})`;
        } 
        else if (image.url) {
          content = `![Generated Image](${image.url})`;
        }
        
        return {
          index,
          message: {
            role: "assistant",
            content
          },
          finish_reason: "stop"
        };
      }),
      usage: body.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
    
    req.log.debug("Transformed image generation response to chat format");
  }
  // Check if this is a chat completion response with choices
  else if (body.choices && Array.isArray(body.choices) && body.choices.length > 0) {
    const model = req.body.model;
    req.log.debug(`Processing chat completion response for model: ${model}`);
    
    if (isOpenrouteraiReasoningContentModel(model)) {
      body.choices.forEach(choice => {
        if (choice.message && choice.message.reasoning_content) {
          req.log.debug(
            { reasoning_length: choice.message.reasoning_content.length },
            "Grok reasoning content detected"
          );
        }
      });
    }
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
  req.log.info("OpenRouter response handler completed");
};

const getModelsResponse = async () => {
  console.log("Getting OpenRouter models...");
  
  // Return cache if less than 1 minute old
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    console.log("Using cached models data");
    return modelsCache;
  }

  try {
    console.log("Fetching fresh models data from OpenRouter API");
    
    const modelToUse = "deepseek/deepseek-chat-v3.1:free";
    const openrouteraiKey = keyPool.get(modelToUse, "openrouterai") as OpenrouteraiKey;
    
    if (!openrouteraiKey || !openrouteraiKey.key) {
      console.error("Failed to get valid OpenRouter key");
      throw new Error("Failed to get valid openrouter key");
    }

    console.log("Making request to OpenRouter API...");
    const response = await axios.get("https://openrouter.ai/api/v1/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openrouteraiKey.key}`
      },
    });

    console.log("OpenRouter API response received", { status: response.status });
    
    if (response.data && response.data.data) {
      modelsCache = {
        object: "list",
        data: response.data.data.map((model: any) => ({
          id: model.id,
          object: "model",
          owned_by: "openrouterai",
        })),
      };
      console.log(`Cached ${modelsCache.data.length} models`);
    } else {
      console.error("Unexpected response format from OpenRouter API", { responseData: response.data });
      throw new Error("Unexpected response format from openrouter API");
    }
  } catch (error) {
    console.error("Error fetching OpenRouter models:", error);
    throw error;
  }

  modelsCacheTime = new Date().getTime();
  return modelsCache;
};

const handleModelRequest: RequestHandler = async (req, res) => {
  req.log.info("Models endpoint called");
  
  try {
    req.log.debug("Fetching models from OpenRouter");
    const modelsResponse = await getModelsResponse();
    req.log.info(`Returning ${modelsResponse.data.length} models`);
    res.status(200).json(modelsResponse);
  } catch (error) {
    req.log.error("Error in handleModelRequest:", error);
    res.status(500).json({ error: "Failed to fetch models" });
  }
};

const openrouteraiProxy = createQueuedProxyMiddleware({
  mutations: [addKey, finalizeBody],
  target: "https://openrouter.ai",
  blockingResponseHandler: openrouteraiResponseHandler,
});

const openrouteraiRouter = Router();

function enablePrefill(req: Request) {
  req.log.debug("Checking prefill enablement");
  
  if (process.env.NO_OPENROUTERAI_PREFILL) {
    req.log.debug("Prefill disabled by environment variable");
    return;
  }
  
  if (!req.body.messages || !Array.isArray(req.body.messages)) {
    req.log.debug("No messages array found, skipping prefill");
    return;
  }
  
  const msgs = req.body.messages;
  if (msgs.length === 0 || msgs.at(-1)?.role !== 'assistant') {
    req.log.debug("No assistant message at end, skipping prefill");
    return;
  }

  req.log.debug("Enabling prefill for assistant messages");
  let i = msgs.length - 1;
  let content = '';
  
  while (i >= 0 && msgs[i].role === 'assistant') {
    content = msgs[i--].content + content;
  }
  
  msgs.splice(i + 1, msgs.length, { role: 'assistant', content, prefix: true });
  req.log.debug("Prefill processing completed");
}

function redirectImageRequests(req: Request) {
  req.log.debug("Checking for image generation redirection");
  const model = req.body.model;
  
  if (isOpenrouteraiImageGenModelImageGenModel(model) && req.path === "/v1/chat/completions") {
    req.log.info(`Redirecting ${model} request to /v1/images/generations endpoint`);
    
    const originalUrl = req.url;
    const originalPath = req.path;
    
    req.url = req.url.replace("/v1/chat/completions", "/v1/images/generations");
    Object.defineProperty(req, 'path', { value: "/v1/images/generations" });
    
    if (req.body.messages && Array.isArray(req.body.messages)) {
      for (let i = req.body.messages.length - 1; i >= 0; i--) {
        const msg = req.body.messages[i];
        if (msg.role === 'user') {
          let prompt = "";
          if (typeof msg.content === 'string') {
            prompt = msg.content;
          } else if (Array.isArray(msg.content)) {
            prompt = msg.content
              .filter((item: any) => item.type === 'text')
              .map((item: any) => item.text)
              .join(" ");
          }
          
          if (prompt) {
            req.body = {
              model: model,
              prompt: prompt,
              n: req.body.n || 1,
              response_format: "b64_json",
              user: req.body.user
            };
            req.log.debug("Transformed request for image generation", { newBody: req.body });
            break;
          }
        }
      }
    }
    
    req.log.info(`Request transformed from ${originalUrl} to ${req.url}`);
  }
}

function removeUnsupportedParameters(req: Request) {
  req.log.debug("Checking for unsupported parameters");
  const model = req.body.model;
  
  const isReasoningModel = isOpenrouteraiReasoningModel(model);
  const isReasoningEffortModel = isOpenrouteraiReasoningEffortModel(model);
  
  if (isReasoningModel) {
    req.log.debug("Processing reasoning model parameters");
    
    const unsupportedParams = [
      'presence_penalty',
      'frequency_penalty',
      'stop'
    ];
    
    for (const param of unsupportedParams) {
      if (req.body[param] !== undefined) {
        req.log.info(`Removing unsupported parameter for reasoning model ${model}: ${param}`);
        delete req.body[param];
      }
    }
    
    if (isReasoningEffortModel) {
      req.log.debug("Processing reasoning_effort for Grok-3-mini");
      if (req.body.reasoning_effort) {
        if (!['low', 'medium', 'high'].includes(req.body.reasoning_effort)) {
          req.log.warn(`Invalid reasoning_effort value: ${req.body.reasoning_effort}, removing it`);
          delete req.body.reasoning_effort;
        }
      } else {
        req.body.reasoning_effort = 'low';
        req.log.debug(`Setting default reasoning_effort=low for Grok-3-mini model`);
      }
    } else {
      if (req.body.reasoning_effort !== undefined) {
        req.log.info(`Removing unsupported reasoning_effort parameter for model ${model}`);
        delete req.body.reasoning_effort;
      }
    }
  }
  
  if (isOpenrouteraiVisionModel(model)) {
    req.log.debug(`Processing vision model: ${model}`);
    
    if (req.body.messages && Array.isArray(req.body.messages)) {
      req.body.messages.forEach((msg: { content: string | any[] }) => {
        if (typeof msg.content === 'string') {
          req.log.debug('Converting string content to array format for vision model');
          msg.content = [{ type: 'text', text: msg.content }];
        }
      });
    }
  }
}

const handleImageGenerationRequest: RequestHandler = async (req, res) => {
  req.log.info("Image generation endpoint called");
  
  try {
    const modelToUse = req.body.model || "google/gemini-2.5-flash-image-preview";
    req.log.debug(`Using model: ${modelToUse}`);
    
    const openrouteraiKey = keyPool.get(modelToUse, "openrouterai") as OpenrouteraiKey;
    
    if (!openrouteraiKey || !openrouteraiKey.key) {
      req.log.error("Failed to get valid OpenRouter key for image generation");
      throw new Error("Failed to get valid openrouter key for image generation");
    }
    
    req.log.debug("Making image generation request to OpenRouter API");
    const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", req.body, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openrouteraiKey.key}`
      },
    });
    
    req.log.info("Image generation request successful");
    res.status(200).json(response.data);
  } catch (error) {
    req.log.error({ error }, "Error in image generation request");
    
    if (error.response && error.response.data) {
      res.status(error.response.status || 500).json(error.response.data);
    } else {
      res.status(500).json({ error: "Failed to generate image", message: error.message });
    }
  }
};

function countOpenrouteraiTokens(req: Request) {
  req.log.debug("Counting OpenRouter tokens");
  const model = req.body.model;
  
  if (isOpenrouteraiVisionModel(model) && req.body.messages && Array.isArray(req.body.messages)) {
    let imageCount = 0;
    
    for (const msg of req.body.messages) {
      if (Array.isArray(msg.content)) {
        const imagesInMessage = msg.content.filter(
          (item: any) => item.type === "image_url"
        ).length;
        imageCount += imagesInMessage;
      }
    }
    
    const TOKENS_PER_IMAGE = 1500;
    const imageTokens = imageCount * TOKENS_PER_IMAGE;
    
    if (imageTokens > 0) {
      req.log.debug(
        { imageCount, tokenEstimate: imageTokens },
        "Estimated token count for Grok vision images"
      );
      
      if (req.promptTokens) {
        req.promptTokens += imageTokens;
      }
    }
  }
}

openrouteraiRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "openrouterai" },
    { afterTransform: [ redirectImageRequests, enablePrefill, removeUnsupportedParameters, countOpenrouteraiTokens ] }
  ),
  openrouteraiProxy
);

openrouteraiRouter.post(
  "/v1/images/generations",
  ipLimiter,
  handleImageGenerationRequest
);

openrouteraiRouter.get("/v1/models", handleModelRequest);

console.log("OpenRouter router configured with endpoints:");
console.log("  POST /v1/chat/completions");
console.log("  POST /v1/images/generations");
console.log("  GET /v1/models");

export const openrouterai = openrouteraiRouter;