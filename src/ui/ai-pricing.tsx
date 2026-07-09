import { DataTable, EmptyState, Notice, Panel } from "./components";
import type { components } from "../types/generated";

type AiModelPrice = components["schemas"]["AIModelPrice"];

export type PricingFlash = { tone: "success" | "error" | "info"; message: string } | undefined;

type RateKey =
  | "input_cost_per_mtok"
  | "cached_input_cost_per_mtok"
  | "output_cost_per_mtok"
  | "reasoning_output_cost_per_mtok"
  | "cache_write_cost_per_mtok"
  | "cache_read_cost_per_mtok";

/** Rate fields in stored order, paired with a short label for the forms/table. */
const RATE_FIELDS: Array<[RateKey, string]> = [
  ["input_cost_per_mtok", "Input"],
  ["cached_input_cost_per_mtok", "Cached input"],
  ["output_cost_per_mtok", "Output"],
  ["reasoning_output_cost_per_mtok", "Reasoning output"],
  ["cache_write_cost_per_mtok", "Cache write"],
  ["cache_read_cost_per_mtok", "Cache read"],
];

/** `YYYY-MM-DD` for a `<input type="date">` value; empty when the date is absent. */
function dateValue(rfc3339: string | null | undefined): string {
  return rfc3339 ? rfc3339.slice(0, 10) : "";
}

/** Render `source_url` (validated `http(s)` only) as a safe external link. */
function SourceLink({ url }: { url: string | null | undefined }) {
  if (!url) return <span class="text-base-content/40">—</span>;
  return (
    <a class="link link-primary break-all" href={url} target="_blank" rel="noopener noreferrer">
      Source
    </a>
  );
}

function ratesSummary(price: AiModelPrice): string {
  const parts = RATE_FIELDS.filter(([key]) => price[key] != null).map(
    ([key, label]) => `${label}: ${price[key]}`,
  );
  return parts.length > 0 ? parts.join(", ") : "No rates";
}

function FlashNotice({ flash }: { flash: PricingFlash }) {
  if (!flash) return null;
  return <Notice tone={flash.tone}>{flash.message}</Notice>;
}

function RateInputs({ price }: { price?: AiModelPrice }) {
  return (
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {RATE_FIELDS.map(([key, label]) => (
        <label class="form-control grid gap-1">
          <span class="label-text text-sm">{label} / Mtok</span>
          <input
            class="input input-bordered input-sm w-full"
            type="number"
            name={key}
            min="0"
            max="1000000"
            step="any"
            inputmode="decimal"
            value={price && price[key] != null ? String(price[key]) : ""}
          />
        </label>
      ))}
    </div>
  );
}

export function AiPricingView({
  username,
  prices,
  flash,
}: {
  username: string;
  prices: AiModelPrice[];
  flash: PricingFlash;
}) {
  return (
    <>
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p class="text-sm font-medium text-primary">AI pricing</p>
          <h1 class="mt-1 text-3xl font-semibold tracking-normal">Model prices</h1>
          <p class="mt-2 text-sm text-base-content/60">{username}</p>
        </div>
        <a class="btn btn-outline btn-sm" href="/app">
          Back to dashboard
        </a>
      </div>

      <FlashNotice flash={flash} />

      <Notice tone="info">
        Estimated costs are API-equivalent estimates derived from these rows, not your actual
        subscription bill. Rates are per 1,000,000 tokens. Prices are effective-dated so historical
        estimates stay reproducible — disable a row instead of deleting it to keep past estimates
        intact.
      </Notice>

      <Panel title="Add price">
        <form method="post" action="/app/ai/prices" class="grid gap-5">
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label class="form-control grid gap-1">
              <span class="label-text font-medium">Provider</span>
              <input class="input input-bordered w-full" type="text" name="provider" required maxlength={255} placeholder="openai" />
            </label>
            <label class="form-control grid gap-1">
              <span class="label-text font-medium">Model</span>
              <input class="input input-bordered w-full" type="text" name="model" required maxlength={255} placeholder="gpt-4o" />
            </label>
            <label class="form-control grid gap-1">
              <span class="label-text font-medium">Currency</span>
              <input
                class="input input-bordered w-full uppercase"
                type="text"
                name="currency"
                value="USD"
                pattern="[A-Za-z]{3}"
                maxlength={3}
              />
            </label>
            <label class="label cursor-pointer justify-start gap-3 p-0 sm:pt-7">
              <input class="toggle toggle-primary" type="checkbox" name="is_enabled" checked />
              <span class="label-text font-medium">Enabled</span>
            </label>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <label class="form-control grid gap-1">
              <span class="label-text font-medium">Effective from</span>
              <input class="input input-bordered w-full" type="date" name="effective_from" required />
            </label>
            <label class="form-control grid gap-1">
              <span class="label-text font-medium">Effective to (optional)</span>
              <input class="input input-bordered w-full" type="date" name="effective_to" />
            </label>
          </div>

          <div class="grid gap-2">
            <span class="label-text font-medium">Rates (at least one required)</span>
            <RateInputs />
          </div>

          <label class="form-control grid gap-1">
            <span class="label-text font-medium">Source URL (optional)</span>
            <input
              class="input input-bordered w-full"
              type="url"
              name="source_url"
              maxlength={2048}
              placeholder="https://example.com/pricing"
            />
          </label>

          <div>
            <button class="btn btn-primary" type="submit">
              Add price
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="Price rows">
        <DataTable
          headers={["Provider / Model", "Currency", "Rates", "Effective", "Status", "Source", "Actions"]}
          empty="No price rows yet. Add one above to enable cost estimation."
          rows={prices.map((price) => [
            <div class="min-w-40">
              <div class="font-medium">{price.provider}</div>
              <div class="text-xs text-base-content/50">{price.model}</div>
            </div>,
            price.currency,
            <span class="text-xs text-base-content/70">{ratesSummary(price)}</span>,
            <div class="text-xs">
              <div>{dateValue(price.effective_from)}</div>
              <div class="text-base-content/50">{price.effective_to ? `to ${dateValue(price.effective_to)}` : "open"}</div>
            </div>,
            price.is_default ? (
              <span class="badge badge-neutral badge-sm">Default</span>
            ) : price.is_enabled ? (
              <span class="badge badge-success badge-sm">Enabled</span>
            ) : (
              <span class="badge badge-ghost badge-sm">Disabled</span>
            ),
            <SourceLink url={price.source_url} />,
            price.is_default ? (
              <span class="text-xs text-base-content/40">Read-only</span>
            ) : (
              <div class="flex flex-wrap gap-1">
                <a class="btn btn-ghost btn-xs" href={`/app/ai/prices/${price.id}/edit`}>
                  Edit
                </a>
                <form method="post" action={`/app/ai/prices/${price.id}/toggle`}>
                  <button class="btn btn-ghost btn-xs" type="submit">
                    {price.is_enabled ? "Disable" : "Enable"}
                  </button>
                </form>
                <form method="post" action={`/app/ai/prices/${price.id}/delete`}>
                  <button class="btn btn-ghost btn-xs text-error" type="submit">
                    Delete
                  </button>
                </form>
              </div>
            ),
          ])}
        />
      </Panel>
    </>
  );
}

export function AiPricingEditView({
  username,
  price,
  flash,
}: {
  username: string;
  price: AiModelPrice;
  flash: PricingFlash;
}) {
  return (
    <>
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p class="text-sm font-medium text-primary">AI pricing</p>
          <h1 class="mt-1 text-3xl font-semibold tracking-normal">Edit price</h1>
          <p class="mt-2 text-sm text-base-content/60">{username}</p>
        </div>
        <a class="btn btn-outline btn-sm" href="/app/ai/prices">
          Back to prices
        </a>
      </div>

      <FlashNotice flash={flash} />

      <Panel title={`${price.provider} / ${price.model}`}>
        <form method="post" action={`/app/ai/prices/${price.id}`} class="grid gap-5">
          <Notice tone="info">
            Provider, model, and effective-from are immutable — create a new row to change them.
            Clearing a rate here leaves it unchanged; to remove a rate entirely, delete and recreate
            the row.
          </Notice>

          <dl class="grid gap-3 text-sm sm:grid-cols-3">
            <ReadOnly label="Provider" value={price.provider} />
            <ReadOnly label="Model" value={price.model} />
            <ReadOnly label="Effective from" value={dateValue(price.effective_from)} />
          </dl>

          <div class="grid gap-4 sm:grid-cols-3">
            <label class="form-control grid gap-1">
              <span class="label-text font-medium">Currency</span>
              <input
                class="input input-bordered w-full uppercase"
                type="text"
                name="currency"
                value={price.currency}
                pattern="[A-Za-z]{3}"
                maxlength={3}
              />
            </label>
            <label class="form-control grid gap-1">
              <span class="label-text font-medium">Effective to (blank = open)</span>
              <input class="input input-bordered w-full" type="date" name="effective_to" value={dateValue(price.effective_to)} />
            </label>
            <label class="label cursor-pointer justify-start gap-3 p-0 sm:pt-7">
              <input class="toggle toggle-primary" type="checkbox" name="is_enabled" checked={price.is_enabled} />
              <span class="label-text font-medium">Enabled</span>
            </label>
          </div>

          <div class="grid gap-2">
            <span class="label-text font-medium">Rates / Mtok</span>
            <RateInputs price={price} />
          </div>

          <label class="form-control grid gap-1">
            <span class="label-text font-medium">Source URL (blank = clear)</span>
            <input
              class="input input-bordered w-full"
              type="url"
              name="source_url"
              maxlength={2048}
              value={price.source_url ?? ""}
              placeholder="https://example.com/pricing"
            />
          </label>

          <div class="flex flex-col gap-2 sm:flex-row">
            <button class="btn btn-primary" type="submit">
              Save price
            </button>
            <a class="btn btn-ghost" href="/app/ai/prices">
              Cancel
            </a>
          </div>
        </form>
      </Panel>
    </>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt class="text-base-content/60">{label}</dt>
      <dd class="mt-1 font-medium">{value || "—"}</dd>
    </div>
  );
}

export function AiPricingNotFoundView({ username }: { username: string }) {
  return (
    <>
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p class="text-sm font-medium text-primary">AI pricing</p>
          <h1 class="mt-1 text-3xl font-semibold tracking-normal">Price not found</h1>
          <p class="mt-2 text-sm text-base-content/60">{username}</p>
        </div>
        <a class="btn btn-outline btn-sm" href="/app/ai/prices">
          Back to prices
        </a>
      </div>
      <EmptyState>
        This price row does not exist, is not editable (CloudTime-shipped default), or belongs to
        another account.
      </EmptyState>
    </>
  );
}
