import { QoderExecutor } from "./qoder.js";
import { PROVIDERS } from "../config/providers.js";
import { QODER_CN_CHAT_BASE, QODER_CHAT_SIG_PATH } from "../shared/qoder/constants.js";
import { cliBridgeExecute, CLI_BRIDGE_MODELS } from "./qoder-cli-bridge.js";

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
    // CLI bridge: Qoder's gateway hard-blocks some models (notably `qfmodel`)
    // for non-IDE sessions with 406 "Session blocked" regardless of
    // credentials, IP or client fingerprint. Serve those models through the
    // official `qodercn` CLI instead (disable with QODER_CLI_FALLBACK=0).
    let bridgeModel = "";
    if (args) {
      bridgeModel = args.model;
      if (!bridgeModel && args.body) bridgeModel = args.body.model;
    }
    const bridgeOff = ["0", "false"].indexOf(process.env.QODER_CLI_FALLBACK) !== -1;
    if (!bridgeOff && CLI_BRIDGE_MODELS.indexOf(bridgeModel) !== -1) {
      try {
        return await cliBridgeExecute({
          model: bridgeModel,
          upstreamBody: args.body,
          stream: args.stream,
          credentials: args.credentials,
          log: args.log,
        });
      } catch (err) {
        if (args && args.log && args.log.error) args.log.error("QODER-CLI bridge failed", err && err.message);
      }
    }
    return super.execute({
      ...args,
      credentials: { ...(args.credentials || {}), provider: "qoder-cn" },
    });
  }
}

export default QoderCnExecutor;
