import { OpenrouterKey } from "./provider";
import { logger } from "../../../logger";
import { assertNever } from "../../utils";

const CHECK_TIMEOUT = 10000;

export class OpenrouterKeyChecker {
  private log = logger.child({ module: "key-checker", service: "openrouter" });

  constructor(private readonly update: (hash: string, key: Partial<OpenrouterKey>) => void) {
    this.log.info("OpenrouterKeyChecker initialized");
  }

  public async checkKey(key: OpenrouterKey): Promise<void> {
    this.log.info({ hash: key.hash }, "Starting key validation check");
    try {
      const result = await this.validateKey(key);
      this.handleCheckResult(key, result);
    } catch (error) {
      if (error instanceof Error) {
        this.log.warn(
          { error: error.message, stack: error.stack, hash: key.hash },
          "Failed to check key status"
        );
      } else {
        this.log.warn(
          { error, hash: key.hash },
          "Failed to check key status with unknown error"
        );
      }
    }
  }

  private async validateKey(key: OpenrouterKey): Promise<"valid" | "invalid" | "quota" | "free"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      this.log.warn({ hash: key.hash }, "Key validation timed out after " + CHECK_TIMEOUT + "ms");
    }, CHECK_TIMEOUT);


    try {
      // Проверка информации о ключе
      const keyInfoResponse = await fetch("https://openrouter.ai/api/v1/key", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key.key}`,
          "Accept": "application/json",
        },
        signal: controller.signal,
      });


      if (keyInfoResponse.status !== 200) {
        return "invalid";
      }

      const keyInfoText = await keyInfoResponse.text();
      let keyInfo;
      
      try {
        keyInfo = JSON.parse(keyInfoText);
      } catch (e) {
        this.log.warn({ hash: key.hash, response: keyInfoText }, "Key info response is not JSON");
        return "invalid";
      }

      // Проверяем, является ли ключ бесплатным
      const isFreeTier = keyInfo.data?.is_free_tier;
      if (isFreeTier) {
        return "free";
      }

      // Проверка возможности использования платной модели
      const testResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          Authorization: `Bearer ${key.key}`,
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [
            {
              role: "user",
              content: "Hello"
            }
          ],
          max_tokens: 1000
        }),
        signal: controller.signal,
      });

      const responseText = await testResponse.text();
      
      if (testResponse.status === 200 || testResponse.status === 400) {
        return "valid";
      } else if (testResponse.status === 429) {
        return "quota";
      } else if (testResponse.status === 402) {
        // Проверяем сообщение об ошибке для определения типа платного ключа
        if (responseText.includes("Insufficient credits") || responseText.includes("requires more credits")) {
          return "quota";
        }
      }
      
      return "invalid";
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.log.warn({ hash: key.hash }, "Key validation aborted");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleCheckResult(
    key: OpenrouterKey,
    result: "valid" | "invalid" | "quota" | "free"
  ): void {
    switch (result) {
      case "valid":
        this.log.info({ hash: key.hash }, "Key is valid paid key");
        this.update(key.hash, {
          isDisabled: false,
          isFreeTier: false,
          lastChecked: Date.now(),
        });
        break;
      case "invalid":
        this.log.warn({ hash: key.hash }, "Key is invalid, marking as revoked");
        this.update(key.hash, {
          isDisabled: true,
          isRevoked: true,
          lastChecked: Date.now(),
        });
        break;
      case "quota":
        this.log.warn({ hash: key.hash }, "Key has exceeded its quota, disabling");
        this.update(key.hash, {
          isDisabled: true,
          isOverQuota: true,
          lastChecked: Date.now(),
        });
        break;
      case "free":
        this.log.warn({ hash: key.hash }, "Key is free tier, marking as free");
        this.update(key.hash, {
          isDisabled: false, // Можно оставить включенным для бесплатных моделей
          isFreeTier: true,
          lastChecked: Date.now(),
        });
        break;
      default:
        assertNever(result);
    }
  }
}