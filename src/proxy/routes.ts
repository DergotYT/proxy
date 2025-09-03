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

// Log initialization
console.log("Initializing proxy router with middleware and routes");

// Remove `expect: 100-continue` header from requests due to incompatibility
// with node-http-proxy.
proxyRouter.use((req, _res, next) => {
  req.log?.info("Removing 'expect: 100-continue' header from request");
  if (req.headers.expect) {
    req.log?.debug(`Found expect header: ${req.headers.expect}`);
    delete req.headers.expect;
    req.log?.debug("Expect header removed successfully");
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
proxyRouter.use(gatekeeper);
proxyRouter.use(checkRisuToken);
console.log("Authentication and rate limiting middleware added");

// Initialize request queue metadata.
proxyRouter.use((req, _res, next) => {
  req.log?.info("Initializing request queue metadata");
  req.startTime = Date.now();
  req.retryCount = 0;
  req.log?.debug({ startTime: req.startTime, retryCount: req.retryCount }, "Request metadata initialized");
  next();
});

// Proxy endpoints with detailed logging
console.log("Configuring proxy endpoints:");
proxyRouter.use("/openai", addV1, (req, res, next) => {
  req.log?.info("Routing to OpenAI endpoint");
  next();
}, openai);

proxyRouter.use("/openai-image", addV1, (req, res, next) => {
  req.log?.info("Routing to OpenAI Image endpoint");
  next();
}, openaiImage);

proxyRouter.use("/anthropic", addV1, (req, res, next) => {
  req.log?.info("Routing to Anthropic endpoint");
  next();
}, anthropic);

proxyRouter.use("/google-ai", addV1, (req, res, next) => {
  req.log?.info("Routing to Google AI endpoint");
  next();
}, googleAI);

proxyRouter.use("/mistral-ai", addV1, (req, res, next) => {
  req.log?.info("Routing to Mistral AI endpoint");
  next();
}, mistralAI);

proxyRouter.use("/aws", (req, res, next) => {
  req.log?.info("Routing to AWS endpoint");
  next();
}, aws);

proxyRouter.use("/gcp/claude", addV1, (req, res, next) => {
  req.log?.info("Routing to GCP Claude endpoint");
  next();
}, gcp);

proxyRouter.use("/azure/openai", addV1, (req, res, next) => {
  req.log?.info("Routing to Azure OpenAI endpoint");
  next();
}, azure);

proxyRouter.use("/deepseek", addV1, (req, res, next) => {
  req.log?.info("Routing to DeepSeek endpoint");
  next();
}, deepseek);

proxyRouter.use("/xai", addV1, (req, res, next) => {
  req.log?.info("Routing to XAI endpoint");
  next();
}, xai);

proxyRouter.use("/openrouter", addV1, (req, res, next) => {
  req.log?.info("Routing to OpenRouter endpoint");
  next();
}, openrouter);

proxyRouter.use("/cohere", addV1, (req, res, next) => {
  req.log?.info("Routing to Cohere endpoint");
  next();
}, cohere);

proxyRouter.use("/qwen", addV1, (req, res, next) => {
  req.log?.info("Routing to Qwen endpoint");
  next();
}, qwen);

proxyRouter.use("/moonshot", addV1, (req, res, next) => {
  req.log?.info("Routing to Moonshot endpoint");
  next();
}, moonshot);

console.log("All proxy endpoints configured successfully");

// Redirect browser requests to the homepage.
proxyRouter.get("*", (req, res, next) => {
  req.log?.info("Checking if request is from browser");
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  
  if (isBrowser) {
    req.log?.info("Browser detected, redirecting to homepage");
    res.redirect("/");
  } else {
    req.log?.info("Non-browser request, continuing to next middleware");
    next();
  }
});

// Send a fake client error if user specifies an invalid proxy endpoint.
proxyRouter.use((req, res) => {
  req.log?.warn("Invalid proxy endpoint requested", {
    originalUrl: req.originalUrl,
    method: req.method,
    body: req.body
  });
  
  sendErrorToClient({
    req,
    res,
    options: {
      title: "Proxy error (HTTP 404 Not Found) {originalUrl} {req.originalUrl}",
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

console.log("Proxy router configuration completed");
export { proxyRouter as proxyRouter };