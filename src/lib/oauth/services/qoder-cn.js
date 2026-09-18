import {
  QODER_CN_DEVICE_TOKEN_URL,
  QODER_CN_LOGIN_URL,
  QODER_CN_USERINFO_URL,
} from "../../qoder/constants.js";
import { QoderService } from "./qoder.js";

const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class QoderCnService extends QoderService {
  initiateDeviceFlow() {
    const { verifier, challenge } = this.generatePkcePair();
    const nonce = crypto.randomUUID ? crypto.randomUUID() : this.generatePkcePair().verifier.slice(0, 36);
    const machineId = crypto.randomUUID ? crypto.randomUUID() : this.generatePkcePair().verifier.slice(0, 36);

    const params = new URLSearchParams({
      challenge,
      challenge_method: "S256",
      machine_id: machineId,
      nonce,
    });

    return {
      verificationUriComplete: `${QODER_CN_LOGIN_URL}?${params.toString()}`,
      codeVerifier: verifier,
      nonce,
      machineId,
    };
  }

  async pollDeviceToken({ nonce, codeVerifier }) {
    if (!nonce || !codeVerifier) {
      throw new Error("pollDeviceToken: missing nonce or code verifier");
    }
    const url = `${QODER_CN_DEVICE_TOKEN_URL}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(codeVerifier)}&challenge_method=S256`;

    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Go-http-client/2.0",
      },
    });

    if (response.status === 202 || response.status === 404) {
      return { status: "pending" };
    }

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Qoder CN device token response was not JSON: ${text.slice(0, 100)}`);
    }

    if (!response.ok) {
      throw new Error(body.errorMessage || body.message || `Qoder CN device token failed with status ${response.status}`);
    }

    const token = body.token || body.access_token || body.data?.token || body.data?.access_token;
    if (!token) {
      return { status: "pending" };
    }

    const expireTime = QoderService.parseExpiry(
      body.expires_at || body.expiresAt || body.data?.expires_at,
      body.expires_in ?? body.expiresIn ?? body.data?.expires_in,
    );

    return {
      status: "ok",
      accessToken: token,
      refreshToken: body.refresh_token || body.refreshToken || body.data?.refresh_token || "",
      userId: body.user_id || body.userId || body.data?.user_id || body.data?.userId || "",
      expireTime,
    };
  }

  async fetchUserInfo(accessToken) {
    if (!accessToken) return { name: "", email: "", organizationId: "" };
    try {
      const response = await fetchWithTimeout(QODER_CN_USERINFO_URL, {
        method: "GET",
        headers: {
          Authorization: *** ${accessToken}`,
          Accept: "application/json",
          "User-Agent": "Go-http-client/2.0",
        },
      });
      if (!response.ok) return { name: "", email: "", organizationId: "" };
      const body = await response.json();
      const user = body.data || body.user || body;
      return {
        name: user.name || user.username || user.nickname || user.display_name || "",
        email: user.email || user.mail || "",
        organizationId: user.organization_id || user.organizationId || user.org_id || "",
      };
    } catch {
      return { name: "", email: "", organizationId: "" };
    }
  }
}
