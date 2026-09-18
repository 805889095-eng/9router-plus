import { QoderExecutor } from "./qoder.js";
import { PROVIDERS } from "../config/providers.js";
import { QODER_CN_CHAT_BASE, QODER_CHAT_SIG_PATH } from "../shared/qoder/constants.js";

/**
 * QoderCnExecutor — handles Qoder China (qoder.cn) requests.
 * Inherits the COSY encryption, request transformation, and SSE coalescing from QoderExecutor,
 * pointing directly to https://gateway.qoder.com.cn instead of api3.qoder.sh.
 */
export class QoderCnExecutor extends QoderExecutor {
  constructor() {
    super();
    this.provider = "qoder-cn";
    this.config = PROVIDERS["qoder-cn"] || PROVIDERS.qoder;
  }

  buildUrl(credentials) {
    return `${QODER_CN_CHAT_BASE}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
  }
}

export default QoderCnExecutor;
