import { OpenrouterKey } from "./provider";
import { logger } from "../../../logger";
import { assertNever } from "../../utils";

const CHECK_TIMEOUT = 10000;
const SERVER_ERROR_RETRY_DELAY = 5000; // 5 seconds
const MAX_SERVER_ERROR_RETRIES = 2;
const CONNECTION_ERROR_RETRY_DELAY = 10000; // 10 seconds
const MAX_CONNECTION_ERROR_RETRIES = 2; // 3 total attempts (initial + 2 retries)

// Track server error counts for each key
const serverErrorCounts: Record<string, number> = {};
// Track connection error counts for each key
const connectionErrorCounts: Record<string, number> = {};

export class OpenrouterKeyChecker {
  private log = logger.child({ module: "key-checker", service: "openrouter" });

  constructor(private readonly update: (hash: string, key: Partial<OpenrouterKey>) => void) {}

  public async checkKey(key: OpenrouterKey): Promise<void> {
    try {
      const result = await this.validateKey(key);
      
      // If we get here, reset any connection error counters since the request succeeded
      if (connectionErrorCounts[key.hash]) {
        delete connectionErrorCounts[key.hash];
      }
      
      if (result === "server_error") {
        // Increment server error count for this key
        const currentCount = (serverErrorCounts[key.hash] || 0) + 1;
        serverErrorCounts[key.hash] = currentCount;
        
        if (currentCount <= MAX_SERVER_ERROR_RETRIES) {
          // Schedule a retry after delay
          this.log.info(
            { hash: key.hash, retryCount: currentCount },
            `Server error detected, scheduling retry ${currentCount} of ${MAX_SERVER_ERROR_RETRIES} in ${SERVER_ERROR_RETRY_DELAY/1000} seconds`
          );
          
          setTimeout(() => {
            this.log.info({ hash: key.hash }, "Retrying key check after server error");
            this.checkKey(key);
          }, SERVER_ERROR_RETRY_DELAY);
          
          // Just mark as checked for now, but don't disable
          this.update(key.hash, {
            lastChecked: Date.now(),
          });
          
          return;
        } else {
          // Max retries reached, handle as invalid
          this.log.warn(
            { hash: key.hash, retries: currentCount },
            "Key failed server error checks multiple times, marking as invalid"
          );
          
          // Reset the counter since we're handling it now
          delete serverErrorCounts[key.hash];
          
          // Mark as invalid
          this.handleCheckResult(key, "invalid");
          return;
        }
      } else {
        // If we get a non-server-error result, reset the server error count
        if (serverErrorCounts[key.hash]) {
          delete serverErrorCounts[key.hash];
        }
        
        // Handle the result normally
        this.handleCheckResult(key, result);
      }
    } catch (error) {
      // Increment connection error count for this key
      const currentCount = (connectionErrorCounts[key.hash] || 0) + 1;
      connectionErrorCounts[key.hash] = currentCount;
      
      if (currentCount <= MAX_CONNECTION_ERROR_RETRIES) {
        // Schedule a retry after delay
        this.log.warn(
          { error, hash: key.hash, retryCount: currentCount },
          `Failed to check key status, scheduling retry ${currentCount} of ${MAX_CONNECTION_ERROR_RETRIES} in ${CONNECTION_ERROR_RETRY_DELAY/1000} seconds`
        );
        
        setTimeout(() => {
          this.log.info({ hash: key.hash }, "Retrying key check after connection error");
          this.checkKey(key);
        }, CONNECTION_ERROR_RETRY_DELAY);
        
        // Just mark as checked for now, don't change status
        this.update(key.hash, {
          lastChecked: Date.now(),
        });
      } else {
        // Max retries reached, log final warning
        this.log.warn(
          { error, hash: key.hash, retries: currentCount },
          "Key failed connection checks multiple times, marking as invalid"
        );
        
        // Reset the counter since we're handling it now
        delete connectionErrorCounts[key.hash];
        
        // Mark as invalid after exhausting retries
        this.update(key.hash, {
          isDisabled: true,
          isRevoked: true, // Assuming connection failures after retries mean the key is invalid
          lastChecked: Date.now(),
        });
      }
    }
  }

  private async validateKey(key: OpenrouterKey): Promise<"valid" | "invalid" | "quota" | "server_error"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

    try {
      // Сначала проверяем платной моделью
      const paidResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.key}`,
        },
        body: JSON.stringify({
          model: "anthropic/claude-3-opus",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });

      if (paidResponse.status === 402) {
        // Если 402, проверяем бесплатной моделью
        const freeResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key.key}`,
          },
          body: JSON.stringify({
            model: "deepseek/deepseek-chat-v3.1:free",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
          }),
          signal: controller.signal,
        });

        if (freeResponse.status === 200) {
          // Ключ бесплатный
          this.update(key.hash, { isFreeTier: true, balance: 0 });
          return "valid";
        } else {
          // Ключ с исчерпанным лимитом
          return "quota";
        }
      } else if (paidResponse.status === 200) {
        // Ключ платный, получаем баланс
        const balance = await this.getKeyBalance(key.key);
        this.update(key.hash, { isFreeTier: false, balance });
        return "valid";
      } else if (paidResponse.status === 401) {
        return "invalid";
      } else {
        return "server_error";
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getKeyBalance(key: string): Promise<number> {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });

      if (response.status === 200) {
        const data = await response.json();
        return data.data?.limit_remaining || 0;
      }
    } catch (error) {
      this.log.warn({ error }, "Failed to get key balance");
    }
    return 0;
  }


  private handleCheckResult(
    key: OpenrouterKey,
    result: "valid" | "invalid" | "quota" | "server_error"
  ): void {
    switch (result) {
      case "valid":
        this.update(key.hash, {
          isDisabled: false,
          lastChecked: Date.now(),
        });
        break;
      case "invalid":
        this.log.warn({ hash: key.hash }, "Key is invalid");
        this.update(key.hash, {
          isDisabled: true,
          isRevoked: true,
          lastChecked: Date.now(),
        });
        break;
      case "quota":
        this.log.warn({ hash: key.hash }, "Key has exceeded its quota");
        this.update(key.hash, {
          isDisabled: true,
          isOverQuota: true,
          lastChecked: Date.now(),
        });
        break;
      case "server_error":
        // This case is now handled in the checkKey method with retries
        this.log.warn({ hash: key.hash }, "Server error when checking key");
        this.update(key.hash, {
          lastChecked: Date.now(),
        });
        break;
      default:
        assertNever(result);
    }
  }
}