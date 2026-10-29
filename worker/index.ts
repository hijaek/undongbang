import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { handleApi } from '../server/api';
import type { Env } from '../server/core';
import { closeWeeks } from '../server/accounting';
import { syncSheets } from '../server/sheets';
import { cleanup } from '../server/media';
import {handleOpsMcp,runMaintenance} from '../server/operations';
import {canonicalRedirect} from '../server/site-origin';

const worker = {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    const redirect = canonicalRedirect(request, (env as unknown as Env).APP_ORIGIN);
    if (redirect) return redirect;
    const pathname = new URL(request.url).pathname;
    if(pathname==='/mcp')return handleOpsMcp(request,env as unknown as Env);
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) return handleApi(request,env as unknown as Env,ctx);
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },
  async scheduled(_event: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    const e=env as unknown as Env;
    ctx.waitUntil(runMaintenance(e));
  },
};

export default worker;
