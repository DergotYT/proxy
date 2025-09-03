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

const proxyRouter = express.Router();

console.log("Initializing proxy router...");

// Remove `expect: 100-continue` header from requests due to incompatibility
// with node-http-proxy.
proxyRouter.use((req, _res, next) => {
  console.log(`Processing request: ${req.method} ${req.originalUrl}`);
  console.log(`User-Agent: ${req.headers["user-agent"]}`);
  
  if (req.headers.expect) {
    console.log(`Removing 'expect' header: ${req.headers.expect}`);
    delete req.headers.expect;
  }
  next();
});

// Apply body parsers.
proxyRouter.use(
  express.json({ limit: "100mb" }),
  express.urlencoded({ extended: true, limit: "100mb" })
);

console.log("Body parsers configured with 100MB limit");

// Apply auth/rate limits.
console.log("Applying gatekeeper middleware...");
proxyRouter.use(gatekeeper);
console.log("Applying RisuToken check middleware...");
proxyRouter.use(checkRisuToken);

// Initialize request queue metadata.
proxyRouter.use((req, _res, next) => {
  req.startTime = Date.now();
  req.retryCount = 0;
  console.log(`Request initialized - startTime: ${req.startTime}, retryCount: ${req.retryCount}`);
  next();
});

// Proxy endpoints with detailed logging
console.log("Setting up proxy endpoints:");
proxyRouter.use("/openai", (req, res, next) => {
  console.log(`Routing to OpenAI: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, openai);

proxyRouter.use("/openai-image", (req, res, next) => {
  console.log(`Routing to OpenAI Image: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, openaiImage);

proxyRouter.use("/anthropic", (req, res, next) => {
  console.log(`Routing to Anthropic: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, anthropic);

proxyRouter.use("/google-ai", (req, res, next) => {
  console.log(`Routing to Google AI: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, googleAI);

proxyRouter.use("/mistral-ai", (req, res, next) => {
  console.log(`Routing to Mistral AI: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, mistralAI);

proxyRouter.use("/aws", (req, res, next) => {
  console.log(`Routing to AWS: ${req.method} ${req.originalUrl}`);
  next();
}, aws);

proxyRouter.use("/gcp/claude", (req, res, next) => {
  console.log(`Routing to GCP Claude: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, gcp);

proxyRouter.use("/azure/openai", (req, res, next) => {
  console.log(`Routing to Azure OpenAI: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, azure);

proxyRouter.use("/deepseek", (req, res, next) => {
  console.log(`Routing to DeepSeek: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, deepseek);

proxyRouter.use("/xai", (req, res, next) => {
  console.log(`Routing to XAI: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, xai);

proxyRouter.use("/openrouter", (req, res, next) => {
  console.log(`Routing to OpenRouter: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, openrouter);

proxyRouter.use("/cohere", (req, res, next) => {
  console.log(`Routing to Cohere: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, cohere);

proxyRouter.use("/qwen", (req, res, next) => {
  console.log(`Routing to Qwen: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, qwen);

proxyRouter.use("/moonshot", (req, res, next) => {
  console.log(`Routing to Moonshot: ${req.method} ${req.originalUrl}`);
  next();
}, addV1, moonshot);

console.log("All proxy endpoints configured");

// Redirect browser requests to the homepage.
proxyRouter.get("*", (req, res, next) => {
  console.log(`Checking if request is from browser: ${req.originalUrl}`);
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  console.log(`Is browser request: ${isBrowser}`);
  
  if (isBrowser) {
    console.log(`Redirecting browser request to homepage: ${req.originalUrl}`);
    res.redirect("/");
  } else {
    console.log(`Non-browser request, continuing: ${req.originalUrl}`);
    next();
  }
});

// Send a fake client error if user specifies an invalid proxy endpoint.
proxyRouter.use((req, res) => {
  console.error(`Invalid proxy endpoint requested: ${req.originalUrl}`);
  console.error(`Request body: ${JSON.stringify(req.body)}`);
  console.error(`Request method: ${req.method}`);
  
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

console.log("Proxy router setup completed");
export { proxyRouter as proxyRouter };