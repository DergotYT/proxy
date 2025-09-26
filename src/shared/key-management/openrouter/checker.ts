// src/shared/key-management/openrouter/checker.ts

import { AxiosError } from "axios";
import { getAxiosInstance } from "../../network";
import { KeyCheckerBase } from "../key-checker-base";
import type { OpenRouterKey, OpenRouterKeyProvider, OpenRouterKeyStatus } from "./provider";

const axios = getAxiosInstance();

const MIN_CHECK_INTERVAL = 3 * 1000;
const KEY_CHECK_PERIOD = 1000 * 60 * 60 * 24;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type KeyInfoResponse = {
  data: {
    is_free_tier: boolean;
    limit_remaining: number | null;
    limit: number | null;
    usage: number; // For free tier
  };
};

type ModelsResponse = {
  data: Array<{
    id: string;
    pricing?: { completion?: string };
  }>;
};

type ErrorResponse = {
  error: { message: string };
};

type UpdateFn = typeof OpenRouterKeyProvider.prototype.update;

export class OpenRouterKeyChecker extends KeyCheckerBase<OpenRouterKey> {
  constructor(keys: OpenRouterKey[], updateKey: UpdateFn) {
    super(keys, {
      service: "openrouter",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      updateKey,
    });
  }

  protected async testKeyOrFail(key: OpenRouterKey) {
    const { status, info } = await this.testKey(key);
    this.updateKey(key.hash, { status, info });
    this.log.info(
      { key: key.hash, status, info },
      "Checked OpenRouter key."
    );
  }

  protected handleAxiosError(key: OpenRouterKey, error: AxiosError) {
    if (error.response?.status === 429) {
      this.updateKey(key.hash, { 
        status: 'UNKNOWN (Rate Limited)', 
        info: 'Rate limit exceeded during check.' 
      });
      return;
    }
    
    this.log.error(
      { key: key.hash, error: error.message },
      "Network error while checking key; trying this key again in an hour."
    );
    const oneHour = 60 * 60 * 1000;
    const next = Date.now() - (KEY_CHECK_PERIOD - oneHour);
    this.updateKey(key.hash, { lastChecked: next });
  }

  private async makeRequest<T>(key: OpenRouterKey, endpoint: string, method: 'GET' | 'POST' = 'GET', data?: any): Promise<{ status: number, data: T | ErrorResponse }> {
    const headers = { 'Authorization': `Bearer ${key.key}`, 'Content-Type': 'application/json' };
    const config = { headers };
    
    try {
      let response;
      if (method === 'POST') {
        response = await axios.post<T>(`${OPENROUTER_BASE_URL}/${endpoint}`, data, config);
      } else {
        response = await axios.get<T>(`${OPENROUTER_BASE_URL}/${endpoint}`, config);
      }
      return { status: response.status, data: response.data as T };
    } catch (e: any) {
      const error = e as AxiosError<ErrorResponse>;
      return { 
        status: error.response?.status || 500, 
        data: error.response?.data || { error: { message: error.message } } 
      };
    }
  }
  
  private async testKey(key: OpenRouterKey): Promise<{ status: OpenRouterKeyStatus, info: string }> {
    const { status: keyStatus, data: keyData } = await this.makeRequest<KeyInfoResponse>(key, 'key');

    if (keyStatus === 429) {
      return { status: 'UNKNOWN (Rate Limited)', info: "Could not verify due to rate limits" };
    }
    
    if (keyStatus !== 200 || !keyData.data) {
      const errorMsg = (keyData as ErrorResponse).error?.message || 'Invalid response';
      return { status: 'DEAD', info: errorMsg };
    }
    
    const keyInfo = keyData.data;

    if (keyInfo.is_free_tier) {
      const usage = keyInfo.usage || 0.0;
      // Assuming free tier is $0.01
      const remaining = Math.max(0, 0.01 - usage); 
      const status: OpenRouterKeyStatus = remaining > 0.000001 ? 'FREE (Active)' : 'FREE (Exhausted)';
      const info = `Remaining: $${remaining.toFixed(6)}`;
      return { status, info };
    } else {
      // Paid key logic
      const limitRemaining = keyInfo.limit_remaining;
      const limitVal = keyInfo.limit;
      
      if (limitRemaining !== null && limitRemaining > 0) {
        const limitStr = limitVal !== null ? `Limit: $${limitVal.toFixed(2)}` : "No limit";
        const info = `Remaining: $${limitRemaining.toFixed(4)} | ${limitStr}`;
        return { status: 'PAID (Balance)', info };
      }
      
      // If limit_remaining is 0 or null, test a request.
      const cheapestModel = await this.getCheapestPaidModelId(key);
      const testModelId = cheapestModel.id;

      if (!testModelId) {
        return { status: 'PAID (No Models)', info: "Key is valid but has no paid models enabled" };
      }
      
      const { status: testStatus, data: testData } = await this.testModelRequest(key, testModelId);
      const errorMsg = (testData as ErrorResponse).error?.message || '';

      if (testStatus === 200) {
        return { status: 'PAID (Pay-as-you-go)', info: "Active, no pre-paid balance or limit" };
      } 
      
      if (testStatus === 402) {
        return { status: 'PAID (No Credits)', info: "Out of pre-paid credits" };
      }
      
      if (testStatus === 400 && errorMsg.includes("Key limit exceeded")) {
        return { status: 'PAID (Limit Reached)', info: "Monthly spending limit has been reached" };
      }
      
      return { status: 'DEAD', info: errorMsg || 'Test request failed' };
    }
  }

  private async getCheapestPaidModelId(key: OpenRouterKey): Promise<{ id: string | null, price: number }> {
    const { status, data } = await this.makeRequest<ModelsResponse>(key, 'models');
    if (status !== 200 || !data.data) {
        return { id: null, price: Infinity };
    }
    
    let cheapestModelId: string | null = null;
    let minPrice = Infinity;

    for (const model of data.data) {
        const priceStr = model.pricing?.completion;
        if (priceStr) {
            try {
                const price = parseFloat(priceStr);
                if (price > 0 && price < minPrice) {
                    minPrice = price;
                    cheapestModelId = model.id;
                }
            } catch (e) {
                // Ignore invalid pricing strings
            }
        }
    }
    return { id: cheapestModelId, price: minPrice };
  }
  
  private async testModelRequest(key: OpenRouterKey, modelId: string): Promise<{ status: number, data: any }> {
    const payload = { 
      "model": modelId, 
      "messages": [{"role": "user", "content": "1"}], 
      "max_tokens": 1
    };
    return this.makeRequest<any>(key, 'chat/completions', 'POST', payload);
  }
}