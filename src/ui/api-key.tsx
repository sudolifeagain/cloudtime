import { Panel } from "./components";
import type { DashboardData } from "./dashboard";

export function ApiKeyConfirmView({ data }: { data: DashboardData }) {
  return (
    <>
      <div>
        <p class="text-sm font-medium text-primary">API key</p>
        <h1 class="mt-1 text-3xl font-semibold tracking-normal">Regenerate API key</h1>
        <p class="mt-2 text-sm text-base-content/60">{data.user.username}</p>
      </div>

      <Panel class="relative min-h-96">
        <dialog open class="modal modal-open">
          <div class="modal-box rounded-lg">
            <h2 class="text-xl font-semibold tracking-normal">Regenerate API key?</h2>
            <p class="mt-3 text-sm leading-6 text-base-content/70">
              This immediately replaces the current API key. Existing editor and CLI clients stop authenticating until their configuration is updated with the new key.
            </p>
            <div class="mt-4 rounded-lg bg-base-200 p-3">
              <pre class="ct-mono whitespace-pre-wrap break-all">{`[settings]\napi_url = ${data.apiBaseUrl}\napi_key = <new key shown once>`}</pre>
            </div>
            <div class="modal-action">
              <a class="btn btn-ghost" href="/app">
                Cancel
              </a>
              <form method="post" action="/app/api-key">
                <button class="btn btn-error" type="submit">
                  Regenerate key
                </button>
              </form>
            </div>
          </div>
        </dialog>
      </Panel>
    </>
  );
}

