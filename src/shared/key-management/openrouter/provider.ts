import { Key, KeyProvider, createGenericGetLockoutPeriod } from "..";
import { OpenrouterKeyChecker } from "./checker";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { OpenrouterModelFamily, ModelFamily } from "../../models"; // Added ModelFamily



// XaiKeyUsage is removed, tokenUsage from base Key interface will be used.
export interface OpenrouterKey extends Key {
  readonly service: "openrouter";
  readonly modelFamilies: OpenrouterModelFamily[];
  isOverQuota: boolean;
  isFreeTier: boolean;
}

export class OpenrouterKeyProvider implements KeyProvider<OpenrouterKey> {
  readonly service = "openrouter";

  private keys: OpenrouterKey[] = [];
  private checker?: OpenrouterKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.openrouterKey?.trim();
    if (!keyConfig) {
      return;
    }

    const keys = keyConfig.split(",").map((k) => k.trim());
    for (const key of keys) {
      if (!key) continue;
      this.keys.push({
        key,
        service: this.service,
        modelFamilies: ["openrouter"],
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        lastChecked: 0,
        hash: this.hashKey(key),
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        tokenUsage: {}, // Initialize new tokenUsage field
        isOverQuota: false,
        isFreeTier: false, // Инициализируем как false
      });
    }
  }

  private hashKey(key: string): string {
    return require("crypto").createHash("sha256").update(key).digest("hex");
  }

  public init() {
    if (this.keys.length === 0) return;
    if (!config.checkKeys) {
      this.log.warn(
        "Key checking is disabled. Keys will not be verified."
      );
      return;
    }
    this.checker = new OpenrouterKeyChecker(this.update.bind(this));
    for (const key of this.keys) {
      void this.checker.checkKey(key);
    }
  }

  public get(model: string): OpenrouterKey {
    const isFreeModel = this.isFreeModel(model);
    const availableKeys = this.keys.filter((k) => {
      if (k.isDisabled) return false;
      
      // Бесплатные ключи могут использовать только бесплатные модели
      if (k.isFreeTier) {
        return isFreeModel;
      }
      
      // Платные ключи могут использовать любые модели
      return true;
    });

    if (availableKeys.length === 0) {
      throw new Error(
        isFreeModel 
          ? "No free OpenRouter keys available for free model" 
          : "No paid OpenRouter keys available for paid model"
      );
    }

    const key = availableKeys[Math.floor(Math.random() * availableKeys.length)];
    key.lastUsed = Date.now();
    this.throttle(key.hash);
    return { ...key };
  }

  private isFreeModel(model: string): boolean {
	const FREE_MODELS = [
	  "nvidia/nemotron-nano-9b-v2:free",
	  "deepseek/deepseek-chat-v3.1:free",
	  "openai/gpt-oss-120b:free",
	  "openai/gpt-oss-20b:free",
	  "z-ai/glm-4.5-air:free",
	  "qwen/qwen3-coder:free",
	  "moonshotai/kimi-k2:free",
	  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
	  "google/gemma-3n-e2b-it:free",
	  "tencent/hunyuan-a13b-instruct:free",
	  "tngtech/deepseek-r1t2-chimera:free",
	  "mistralai/mistral-small-3.2-24b-instruct:free",
	  "moonshotai/kimi-dev-72b:free",
	  "deepseek/deepseek-r1-0528-qwen3-8b:free",
	  "deepseek/deepseek-r1-0528:free",
	  "mistralai/devstral-small-2505:free",
	  "google/gemma-3n-e4b-it:free",
	  "meta-llama/llama-3.3-8b-instruct:free",
	  "qwen/qwen3-4b:free",
	  "qwen/qwen3-30b-a3b:free",
	  "qwen/qwen3-8b:free",
	  "qwen/qwen3-14b:free",
	  "qwen/qwen3-235b-a22b:free",
	  "tngtech/deepseek-r1t-chimera:free",
	  "microsoft/mai-ds-r1:free",
	  "shisa-ai/shisa-v2-llama3.3-70b:free",
	  "arliai/qwq-32b-arliai-rpr-v1:free",
	  "agentica-org/deepcoder-14b-preview:free",
	  "moonshotai/kimi-vl-a3b-thinking:free",
	  "nvidia/llama-3.1-nemotron-ultra-253b-v1:free",
	  "meta-llama/llama-4-maverick:free",
	  "meta-llama/llama-4-scout:free",
	  "qwen/qwen2.5-vl-32b-instruct:free",
	  "deepseek/deepseek-chat-v3-0324:free",
	  "mistralai/mistral-small-3.1-24b-instruct:free",
	  "google/gemma-3-4b-it:free",
	  "google/gemma-3-12b-it:free",
	  "rekaai/reka-flash-3:free",
	  "google/gemma-3-27b-it:free",
	  "qwen/qwq-32b:free",
	  "nousresearch/deephermes-3-llama-3-8b-preview:free",
	  "cognitivecomputations/dolphin3.0-r1-mistral-24b:free",
	  "cognitivecomputations/dolphin3.0-mistral-24b:free",
	  "qwen/qwen2.5-vl-72b-instruct:free",
	  "mistralai/mistral-small-24b-instruct-2501:free",
	  "deepseek/deepseek-r1-distill-qwen-14b:free",
	  "deepseek/deepseek-r1-distill-llama-70b:free",
	  "deepseek/deepseek-r1:free",
	  "google/gemini-2.0-flash-exp:free",
	  "meta-llama/llama-3.3-70b-instruct:free",
	  "qwen/qwen-2.5-coder-32b-instruct:free",
	  "meta-llama/llama-3.2-3b-instruct:free",
	  "qwen/qwen-2.5-72b-instruct:free",
	  "meta-llama/llama-3.1-405b-instruct:free",
	  "mistralai/mistral-nemo:free",
	  "google/gemma-2-9b-it:free",
	  "mistralai/mistral-7b-instruct:free"
	];
    
  return FREE_MODELS.includes(model) || model.endsWith(":free");
  }

  public list(): Omit<OpenrouterKey, "key">[] {
    return this.keys.map(({ key, ...rest }) => rest);
  }

  public disable(key: OpenrouterKey): void {
    const found = this.keys.find((k) => k.hash === key.hash);
    if (found) {
      found.isDisabled = true;
    }
  }

  public update(hash: string, update: Partial<OpenrouterKey>): void {
    const key = this.keys.find((k) => k.hash === hash);
    if (key) {
      Object.assign(key, update);
    }
  }

  public available(): number {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public incrementUsage(keyHash: string, modelFamily: OpenrouterModelFamily, usage: { input: number; output: number }) {
    const key = this.keys.find((k) => k.hash === keyHash);
    if (!key) return;

    key.promptCount++;

    if (!key.tokenUsage) {
      key.tokenUsage = {};
    }
    // Xai only has one model family "xai"
    if (!key.tokenUsage[modelFamily]) {
      key.tokenUsage[modelFamily] = { input: 0, output: 0 };
    }

    const currentFamilyUsage = key.tokenUsage[modelFamily]!;
    currentFamilyUsage.input += usage.input;
    currentFamilyUsage.output += usage.output;
  }

  /**
   * Upon being rate limited, a key will be locked out for this many milliseconds
   * while we wait for other concurrent requests to finish.
   */
  private static readonly RATE_LIMIT_LOCKOUT = 2000;
  /**
   * Upon assigning a key, we will wait this many milliseconds before allowing it
   * to be used again. This is to prevent the queue from flooding a key with too
   * many requests while we wait to learn whether previous ones succeeded.
   */
  private static readonly KEY_REUSE_DELAY = 500;

  getLockoutPeriod = createGenericGetLockoutPeriod(() => this.keys);

  public markRateLimited(keyHash: string) {
    this.log.debug({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + OpenrouterKeyProvider.RATE_LIMIT_LOCKOUT;
  }

  public recheck(): void {
    if (!this.checker || !config.checkKeys) return;
    for (const key of this.keys) {
      this.update(key.hash, { 
        isOverQuota: false,
        isDisabled: false,
        lastChecked: 0 
      });
      void this.checker.checkKey(key);
    }
  }

  /**
   * Applies a short artificial delay to the key upon dequeueing, in order to
   * prevent it from being immediately assigned to another request before the
   * current one can be dispatched.
   **/
  private throttle(hash: string) {
    const now = Date.now();
    const key = this.keys.find((k) => k.hash === hash)!;

    const currentRateLimit = key.rateLimitedUntil;
    const nextRateLimit = now + OpenrouterKeyProvider.KEY_REUSE_DELAY;

    key.rateLimitedAt = now;
    key.rateLimitedUntil = Math.max(currentRateLimit, nextRateLimit);
  }
}
