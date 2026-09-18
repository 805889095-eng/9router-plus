import { QoderExecutor } from "./qoder.js";
import { PROVIDERS } from "../config/providers.js";
import { QODER_CN_CHAT_BASE, QODER_CHAT_SIG_PATH } from "../shared/qoder/constants.js";

/**
 * QoderCnExecutor — Qoder China (qoder.cn) inference path.
 *
 * Inherits COSY signing, body encoding and SSE coalescing from QoderExecutor;
 * only the host changes (gateway.qoder.com.cn instead of api3.qoder.sh).
 *
 * `execute()` is overridden for one reason: the COSY signature is computed over
 * the public endpoint bundle, and `getQoderModelConfig` fetches the live model
 * catalog — both must see `qoder-cn` on `credentials.provider` or they fall back
 * to the international hosts and every request dies with
 * `model_config ... not yet known`. The chat path's credentials object has no
 * `provider` field, so we stamp it here.
 */
export class QoderCnExecutor extends QoderExecutor {
  constructor() {
    super();
    this.provider = "qoder-cn";
    this.config = PROVIDERS["qoder-cn"] || PROVIDERS.qoder;
  }

  buildUrl() {
    return `${QODER_CN_CHAT_BASE}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
  }

  async execute(args) {
    return super.execute({
      ...args,
      credentials: { ...(args.credentials || {}), provider: "qoder-cn" },
    });
  }
}

export default QoderCnExecutor;
