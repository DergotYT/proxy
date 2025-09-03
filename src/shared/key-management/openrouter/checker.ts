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

  private async validateKey(key: OpenrouterKey): Promise<"valid" | "invalid" | "quota"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      this.log.warn({ hash: key.hash }, "Key validation timed out after " + CHECK_TIMEOUT + "ms");
    }, CHECK_TIMEOUT);

    try {
      // Проверка ключа через OpenRouter API
      const keyInfoResponse = await fetch("https://openrouter.ai/api/v1/key", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key.key}`,
        },
        signal: controller.signal,
      });

      if (keyInfoResponse.status !== 200) {
        return "invalid";
      }

      // Проверка возможности использования модели anthropic/claude-sonnet-4
      const testResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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
          max_tokens: 10
        }),
        signal: controller.signal,
      });

      if (testResponse.status === 200 || testResponse.status === 400) {
        return "valid";
      } else if (testResponse.status === 429) {
        return "quota";
      } else if (testResponse.status === 403) {
        this.log.warn(
          { status: testResponse.status, hash: key.hash },
          "Forbidden (403) response, key is invalid"
        );
        return "invalid";
      } else {
        this.log.warn(
          { status: testResponse.status, hash: key.hash },
          "Unexpected status code while testing key usage"
        );
        return "invalid";
      }
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
    result: "valid" | "invalid" | "quota"
  ): void {
    switch (result) {
      case "valid":
        this.log.info({ hash: key.hash }, "Key is valid and enabled");
        this.update(key.hash, {
          isDisabled: false,
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
      default:
        assertNever(result);
    }
  }
}