import { AnthropicChatMessage } from "../../../../shared/api-schemas";
import { containsImageContent } from "../../../../shared/api-schemas/anthropic";
import { Key, OpenAIKey, keyPool } from "../../../../shared/key-management";
import { isEmbeddingsRequest } from "../../common";
import { assertNever } from "../../../../shared/utils";
import { ProxyReqMutator } from "../index";
import { isFreeOpenRouterModel } from "../../../../shared/models/openrouter-free-models";

export const addKey: ProxyReqMutator = (manager) => {
  const req = manager.request;

  let assignedKey: Key;
  const { service, inboundApi, outboundApi, body } = req;

  if (!inboundApi || !outboundApi) {
    const err = new Error(
      "Request API format missing. Did you forget to add the request preprocessor to your router?"
    );
    req.log.error({ inboundApi, outboundApi, path: req.path }, err.message);
    throw err;
  }

  if (!service) {
    throw new Error("Service is undefined");
  }

  if (!body?.model) {
    throw new Error("You must specify a model with your request.");
  }

  let needsMultimodal = false;
  if (outboundApi === "anthropic-chat") {
    needsMultimodal = containsImageContent(
      body.messages as AnthropicChatMessage[]
    );
  }

  if (inboundApi === outboundApi) {
    // Pass streaming information for GPT-5 models that require verified keys for streaming
    const isStreaming = body.stream === true;
    
    // Special handling for OpenRouter
    if (service === "openrouter") {
      const model = body.model;
      const isFreeModel = isFreeOpenRouterModel(model);
      
      if (isFreeModel) {
        // Для бесплатных моделей сначала пробуем использовать бесплатные ключи
        try {
          assignedKey = keyPool.get(model, service, needsMultimodal, isStreaming, { freeTierOnly: true });
        } catch {
          // Если бесплатных ключей нет, используем любые доступные
          assignedKey = keyPool.get(model, service, needsMultimodal, isStreaming);
        }
      } else {
        // Для платных моделей используем только платные ключи
        assignedKey = keyPool.get(model, service, needsMultimodal, isStreaming, { freeTierOnly: false });
      }
    } else {
      assignedKey = keyPool.get(body.model, service, needsMultimodal, isStreaming);
    }
  } else {
    switch (outboundApi) {
      // If we are translating between API formats we may need to select a model
      // for the user, because the provided model is for the inbound API.
      // TODO: This whole else condition is probably no longer needed since API
      // translation now reassigns the model earlier in the request pipeline.
      case "anthropic-text":
      case "anthropic-chat":
      case "mistral-ai":
      case "mistral-text":
      case "google-ai":
        assignedKey = keyPool.get(body.model, service);
        break;
      case "openai-text":
        assignedKey = keyPool.get("gpt-3.5-turbo-instruct", service);
        break;
      case "openai-image":
        // Use the actual model from the request body instead of defaulting to dall-e-3
        // This ensures that gpt-image-1 requests get keys that are verified for gpt-image-1
        assignedKey = keyPool.get(body.model, service);
        break;
      case "openai-responses":
        assignedKey = keyPool.get(body.model, service);
        break;
      case "openai":
        throw new Error(
          `Outbound API ${outboundApi} is not supported for ${inboundApi}`
        );
      default:
        assertNever(outboundApi);
    }
  }

  manager.setKey(assignedKey);
  req.log.info(
    { key: assignedKey.hash, model: body.model, inboundApi, outboundApi },
    "Assigned key to request"
  );

  // TODO: KeyProvider should assemble all necessary headers
  switch (assignedKey.service) {
    case "anthropic":
      manager.setHeader("X-API-Key", assignedKey.key);
      if (!manager.request.headers["anthropic-version"]) {
        manager.setHeader("anthropic-version", "2023-06-01");
      }
      break;
    case "openai":
      const key: OpenAIKey = assignedKey as OpenAIKey;
      if (key.organizationId && !key.key.includes("svcacct")) {
        manager.setHeader("OpenAI-Organization", key.organizationId);
      }
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "mistral-ai":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "azure":
      const azureKey = assignedKey.key;
      manager.setHeader("api-key", azureKey);
      break;
    case "deepseek":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "xai":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
	case "openrouter":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "cohere":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "qwen":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "moonshot":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "aws":
    case "gcp":
    case "google-ai":
      throw new Error("add-key should not be used for this service.");
    default:
      assertNever(assignedKey.service);
  }
};