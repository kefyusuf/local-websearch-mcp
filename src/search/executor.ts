import type { SearchResultItem } from "../cache/types.js";
import type { SearchProvider } from "../providers/base.js";
import type { ProviderHealthTracker } from "../providers/health.js";
import type { SearchLocale } from "../search-utils.js";
import { fuseSearchResults } from "./fusion.js";

export type SearchStrategy = "fallback" | "aggregate";

export type ExecuteProviderSearchOptions = {
  providers: SearchProvider[];
  query: string;
  locale: SearchLocale;
  strategy: SearchStrategy;
  healthTracker: ProviderHealthTracker;
};

function dedupeProviderResults(results: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (!result.url || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

async function runProvider(
  provider: SearchProvider,
  query: string,
  locale: SearchLocale,
  healthTracker: ProviderHealthTracker
): Promise<SearchResultItem[]> {
  if (!healthTracker.isAvailable(provider.name)) {
    console.error(`Skipping provider ${provider.name}: provider is in backoff window`);
    return [];
  }

  try {
    const results = await provider.execute(query, locale);
    const deduped = dedupeProviderResults(results);

    if (deduped.length === 0) {
      healthTracker.record(provider.name, false);
      console.error(`Provider ${provider.name} returned 0 parsed results`);
      return [];
    }

    if (deduped.length < results.length) {
      console.error(`Deduplicated ${results.length - deduped.length} duplicate URLs from ${provider.name}`);
    }

    healthTracker.record(provider.name, true);
    console.error(`Provider ${provider.name} returned ${deduped.length} results`);
    return deduped;
  } catch (error) {
    healthTracker.record(provider.name, false);
    console.error(
      `Provider ${provider.name} error:`,
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

export async function executeProviderSearch({
  providers,
  query,
  locale,
  strategy,
  healthTracker,
}: ExecuteProviderSearchOptions): Promise<SearchResultItem[]> {
  if (strategy === "fallback") {
    for (const provider of providers) {
      const results = await runProvider(provider, query, locale, healthTracker);
      if (results.length > 0) return results;
    }
    return [];
  }

  const settled = await Promise.all(
    providers.map(async (provider) => ({
      provider: provider.name,
      results: await runProvider(provider, query, locale, healthTracker),
    }))
  );

  return fuseSearchResults(
    settled.filter(({ results }) => results.length > 0)
  );
}
