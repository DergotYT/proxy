import { OpenrouterKey } from "./provider";
import { logger } from "../../../logger";
import { assertNever } from "../../utils";

const CHECK_TIMEOUT = 10000;

interface OpenRouterKeyInfo {
  key: string;
  free_tier: 'free' | 'paid';
  is_provisioning: boolean;
  limit_remaining: string;
  limit: string;
  label: string;
  total_credits: string;
  total_usage: string;
  provisioning_keys?: any[];
  provisioning_parent?: string;
  error?: string;
}

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
      // Получаем информацию о ключе
      const keyInfo = await this.getKeyInfo(key.key, controller);
      
      if (keyInfo.error) {
        return "invalid";
      }

      // Проверяем баланс и лимиты
      if (keyInfo.free_tier === 'free') {
        const usage = parseInt(keyInfo.limit_remaining.split(' ')[0]);
        if (usage <= 0) {
          return "quota";
        }
      } else {
        const balance = parseFloat(keyInfo.limit_remaining.replace('$', ''));
        if (balance <= 0) {
          return "quota";
        }
      }

      return "valid";

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.log.warn({ hash: key.hash }, "Key validation aborted");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getKeyInfo(apiKey: string, controller: AbortController): Promise<OpenRouterKeyInfo> {
    // Запрос информации о ключе
    const keyResponse = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      signal: controller.signal
    });

    if (!keyResponse.ok) {
      return {
        key: apiKey,
        free_tier: 'paid',
        is_provisioning: false,
        limit_remaining: '0',
        limit: '0',
        label: '',
        total_credits: '0',
        total_usage: '0',
        error: `HTTP ${keyResponse.status}`
      };
    }

    const keyData = await keyResponse.json();
    const data = keyData.data || {};

    // Запрос информации о кредитах
    const creditsResponse = await fetch('https://openrouter.ai/api/v1/credits', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      signal: controller.signal
    });

    let creditsData = { data: {} };
    if (creditsResponse.ok) {
      creditsData = await creditsResponse.json();
    }

    const credits = creditsData.data || {};

    // Обработка информации о балансе
    const free_tier = data.is_free_tier ? 'free' : 'paid';
    let limit_remaining = '0';
    let limit = '0';

    if (free_tier === 'free') {
      const usage = data.usage || 0;
      const free_requests_remaining = Math.max(0, 10 - usage);
      limit_remaining = `${free_requests_remaining} free requests`;
      limit = '10 free requests';
    } else {
      limit_remaining = data.limit_remaining !== undefined ? 
        `${data.limit_remaining}$` : 'нет лимита';
      limit = data.limit !== undefined ? `${data.limit}$` : 'нет лимита';
    }

    return {
      key: apiKey,
      free_tier,
      is_provisioning: data.is_provisioning_key || false,
      limit_remaining,
      limit,
      label: data.label || 'N/A',
      total_credits: credits.total_credits !== undefined ? 
        `${credits.total_credits}$` : 'N/A',
      total_usage: credits.total_usage !== undefined ? 
        `${credits.total_usage}$` : 'N/A'
    };
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