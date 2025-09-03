import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { OpenrouterKey, keyPool } from "../shared/key-management";
import { isOpenrouterVisionModel, isOpenrouterImageGenModel, isOpenrouterReasoningModel, isOpenrouterReasoningEffortModel, isOpenrouterReasoningContentModel } from "../shared/api-schemas/openrouter";

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

  // Preserve the original body (including potential reasoning_content)
  let newBody = responseBody;
  
  // Check if this is an image generation response (data array with url or b64_json)
  if (responseBody.data && Array.isArray(responseBody.data)) {
    req.log.debug(
      { imageCount: responseBody.data.length },
      "OpenRouter image generation response detected"
    );
    
    // Transform the image generation response into a chat completion format
    const images = responseBody.data;
    
    // Create a chat completion style response
    newBody = {
      id: `openrouter-image-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.body.model,
      choices: images.map((image, index) => {
        // Create markdown image content for each generated image
        let content = '';
        
        // Add the image using data URL for b64_json
        if (image.b64_json) {
          const imgData = image.b64_json.startsWith('data:image/') 
            ? image.b64_json 
            : `data:image/jpeg;base64,${image.b64_json}`;
          
          content = `![Generated Image](${imgData})`;
        } 
        // Fall back to URL if b64_json isn't available
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
      usage: responseBody.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
    
    req.log.debug("Transformed image generation response to chat format");
  }
  // Check if this is a chat completion response with choices
  else if (responseBody.choices && Array.isArray(responseBody.choices) && responseBody.choices.length > 0) {
    // Make sure each choice's message is preserved
    const model = req.body.model;
    if (isOpenrouterReasoningContentModel(model)) {
      responseBody.choices.forEach(choice => {
        if (choice.message && choice.message.reasoning_content) {
          req.log.debug(
            { reasoning_length: choice.message.reasoning_content.length },
            "OpenRouter reasoning content detected"
          );
        }
      });
    }
  }

  res.status(200).json({ ...newBody, proxy: responseBody.proxy });
};

const getModelsResponse = async () => {
  // Return cache if less than 1 minute old
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  try {
    // Get an OpenRouter key directly using keyPool.get()
    const modelToUse = "anthropic/claude-sonnet-4"; // Use any OpenRouter model here
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
  target: "https://openrouter.ai",
  blockingResponseHandler: openrouterResponseHandler,
});

const openrouterRouter = Router();

// combines all the assistant messages at the end of the context and adds the
// beta 'prefix' option, makes prefills work the same way they work for Claude
function enablePrefill(req: Request) {
  // If you want to disable
  if (process.env.NO_OPENROUTER_PREFILL) return
  
  // Skip if no messages (e.g., for image generation requests)
  if (!req.body.messages || !Array.isArray(req.body.messages)) return;
  
  const msgs = req.body.messages;
  if (msgs.length === 0 || msgs.at(-1)?.role !== 'assistant') return;

  let i = msgs.length - 1;
  let content = '';
  
  while (i >= 0 && msgs[i].role === 'assistant') {
    // maybe we should also add a newline between messages? no for now.
    content = msgs[i--].content + content;
  }
  
  msgs.splice(i + 1, msgs.length, { role: 'assistant', content, prefix: true });
}

// Function to redirect image model requests to the image generations endpoint
function redirectImageRequests(req: Request) {
  const model = req.body.model;
  
  // If this is an image generation model but the endpoint is chat/completions,
  // we need to transform the request to match the image generations endpoint format
  if (isOpenrouterImageGenModel(model) && req.path === "/v1/chat/completions") {
    req.log.info(`Redirecting ${model} request to /v1/images/generations endpoint`);
    
    // Save original URL and path for later
    const originalUrl = req.url;
    const originalPath = req.path;
    
    // Change the request URL and path to the images endpoint
    req.url = req.url.replace("/v1/chat/completions", "/v1/images/generations");
    Object.defineProperty(req, 'path', { value: "/v1/images/generations" });
    
    // Extract the prompt from the messages if present
    if (req.body.messages && Array.isArray(req.body.messages)) {
      // Find the last user message and use its content as the prompt
      for (let i = req.body.messages.length - 1; i >= 0; i--) {
        const msg = req.body.messages[i];
        if (msg.role === 'user') {
          // Extract text content
          let prompt = "";
          if (typeof msg.content === 'string') {
            prompt = msg.content;
          } else if (Array.isArray(msg.content)) {
            // Collect all text content items
            prompt = msg.content
              .filter((item: any) => item.type === 'text')
              .map((item: any) => item.text)
              .join(" ");
          }
          
          if (prompt) {
            // Create a new request body for image generation
            req.body = {
              model: model,
              prompt: prompt,
              n: req.body.n || 1,
              response_format: "b64_json", // Always use b64_json for better client compatibility
              user: req.body.user
            };
            req.log.debug({ newBody: req.body }, "Transformed request for image generation");
            break;
          }
        }
      }
    }
    
    // Log transformation
    req.log.info(`Request transformed from ${originalUrl} to ${req.url}`);
  }
}

// Function to remove parameters not supported by X.AI/Grok models and handle special cases
function removeUnsupportedParameters(req: Request) {
  const model = req.body.model;
  
  // Check if this is a reasoning model (grok-3-mini or grok-4-0709)
  const isReasoningModel = isOpenrouterReasoningModel(model);
  const isReasoningEffortModel = isOpenrouterReasoningEffortModel(model);
  
  if (isReasoningModel) {
    // List of parameters not supported by reasoning models
    const unsupportedParams = [
      'presence_penalty',
      'frequency_penalty',
      'stop'  // stop parameter is not supported by reasoning models
    ];
    
    for (const param of unsupportedParams) {
      if (req.body[param] !== undefined) {
        req.log.info(`Removing unsupported parameter for reasoning model ${model}: ${param}`);
        delete req.body[param];
      }
    }
    
    // Handle reasoning_effort parameter - only supported by grok-3-mini
    if (isReasoningEffortModel) {
      // This is grok-3-mini, handle reasoning_effort
      if (req.body.reasoning_effort) {
        // If reasoning_effort is already present in the request, validate it
        if (!['low', 'medium', 'high'].includes(req.body.reasoning_effort)) {
          req.log.warn(`Invalid reasoning_effort value: ${req.body.reasoning_effort}, removing it`);
          delete req.body.reasoning_effort;
        }
      } else {
        // Default to low reasoning effort if not specified
        req.body.reasoning_effort = 'low';
        req.log.debug(`Setting default reasoning_effort=low for Grok-3-mini model`);
      }
    } else {
      // This is grok-4-0709 or other reasoning model that doesn't support reasoning_effort
      if (req.body.reasoning_effort !== undefined) {
        req.log.info(`Removing unsupported reasoning_effort parameter for model ${model}`);
        delete req.body.reasoning_effort;
      }
    }
  }
  
  // Special handling for vision models
  if (isOpenrouterVisionModel(model)) {
    req.log.debug(`Detected Openrouter vision model: ${model}`);
    
    // Check that messages have proper format for vision models
    if (req.body.messages && Array.isArray(req.body.messages)) {
      req.body.messages.forEach((msg: { content: string | any[] }) => {
        // If content is a string but the model is vision-capable,
        // convert it to an array with a single text item for consistency
        if (typeof msg.content === 'string') {
          req.log.debug('Converting string content to array format for vision model');
          msg.content = [{ type: 'text', text: msg.content }];
        }
      });
    }
  }
  
  // Special handling for image generation models is handled by separate endpoint
}

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

// Set up count token functionality for Openrouter models
function countOpenrouterTokens(req: Request) {
  const model = req.body.model;
  
  // For vision models, estimate image token usage
  if (isOpenrouterVisionModel(model) && req.body.messages && Array.isArray(req.body.messages)) {
    // Initialize image count
    let imageCount = 0;
    
    // Count images in the request
    for (const msg of req.body.messages) {
      if (Array.isArray(msg.content)) {
        const imagesInMessage = msg.content.filter(
          (item: any) => item.type === "image_url"
        ).length;
        imageCount += imagesInMessage;
      }
    }
    
    // Apply token estimations for images
    // Each image is approximately 1500 tokens based on documentation
    const TOKENS_PER_IMAGE = 1500;
    const imageTokens = imageCount * TOKENS_PER_IMAGE;
    
    if (imageTokens > 0) {
      req.log.debug(
        { imageCount, tokenEstimate: imageTokens },
        "Estimated token count for Openrouter vision images"
      );
      
      // Add the image tokens to the existing token count if available
      if (req.promptTokens) {
        req.promptTokens += imageTokens;
      }
    }
  }
}

openrouterRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "openrouter" },
    { afterTransform: [ redirectImageRequests, enablePrefill, removeUnsupportedParameters, countOpenrouterTokens ] }
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