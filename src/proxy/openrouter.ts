import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { OpenrouterKey, keyPool } from "../shared/key-management";

let modelsCache: any = null;
let modelsCacheTime = 0;

const openrouterResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

const getModelsResponse = async () => {
  // Return cache if less than 1 minute old
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  try {
    // Get a Openroouter key directly using keyPool.get()
    const modelToUse = "qwen/qwen3-30b-a3b-thinking-2507"; // Use any Openrouter model here - just for key selection
    const openrouterKey = keyPool.get(modelToUse, "openrouter") as OpenrouterKey;
    
    if (!openrouterKey || !openrouterKey.key) {
      throw new Error("Failed to get valid Openrouter key");
    }

    // Fetch models from Openrouter API with authorization
    const response = await axios.get("https://openrouter.ai/api/v1/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openrouterKey.key}`
      },
    });

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
    } else {
      throw new Error("Unexpected response format from Openrouter API");
    }
  } catch (error) {
    console.error("Error fetching Openrouter models:", error);
    throw error; // No fallback - error will be passed to caller
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
  target: "https://openrouter.ai/api/v1",
  blockingResponseHandler: openrouterResponseHandler,
});

const openrouterRouter = Router();

// combines all the assistant messages at the end of the context and adds the
// beta 'prefix' option, makes prefills work the same way they work for Claude
function enablePrefill(req: Request) {
  // If you want to disable
  if (process.env.NO_OPENROUTER_PREFILL) return
  
  const msgs = req.body.messages;
  if (msgs.at(-1)?.role !== 'assistant') return;

  let i = msgs.length - 1;
  let content = '';
  
  while (i >= 0 && msgs[i].role === 'assistant') {
    // maybe we should also add a newline between messages? no for now.
    content = msgs[i--].content + content;
  }
  
  msgs.splice(i + 1, msgs.length, { role: 'assistant', content, prefix: true });
}

function removeReasonerStuff(req: Request) {
  if (req.body.model === "deepseek-reasoner") {
    // https://api-docs.deepseek.com/guides/reasoning_model
    delete req.body.presence_penalty;
    delete req.body.frequency_penalty;
    delete req.body.temperature;
    delete req.body.top_p;
    delete req.body.logprobs;
    delete req.body.top_logprobs;
  }
}

openrouterRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "openrouter" },
    { afterTransform: [ enablePrefill, removeReasonerStuff ] }
  ),
  openrouterProxy
);

openrouterRouter.get("/v1/models", handleModelRequest);

export const openrouter = openrouterRouter;