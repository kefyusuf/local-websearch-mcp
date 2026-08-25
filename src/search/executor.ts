import type { SearchResultItem } from "../cache/types.js";
import type { SearchProvider } from "../providers/base.js";
import type { ProviderHealthTracker } from "../providers/health.js";
import { filterSearchResultsByDomain, type SearchLocale } from "../search-utils.js";
import { fuseSearchResults } from "./fusion.js";
import type { SearchPlan } from "./planner.js";

export type SearchStrategy = "fallback" | "aggregate";
export type SearchResultFilter = (results: SearchResultItem[]) => SearchResultItem[];

export type ExecuteProviderSearchOptions = {
  providers: SearchProvider[];
  query: string;
  locale: SearchLocale;
  strategy: SearchStrategy;
  healthTracker: ProviderHealthTracker;
  resultFilter?: SearchResultFilter;
};

export type ExecuteSearchPlanOptions = {
  providers: SearchProvider[];
  query: string;
  locale: SearchLocale;
  plan: SearchPlan;
  healthTracker: ProviderHealthTracker;
  resultFilter?: SearchResultFilter;
};

function dedupeProviderResults(results: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (!result.url || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

function uniqueProvidersByName(providers: SearchProvider[]): SearchProvider[] {
  const seen = new Set<string>();
  return providers.filter((provider) => {
    if (seen.has(provider.name)) return false;
    seen.add(provider.name);
    return true;
  });
}

function providersInPlanOrder(
  providers: SearchProvider[],
  providerNames: string[],
): SearchProvider[] {
  const byName = new Map<string, SearchProvider>();
  for (const provider of providers) {
    if (!byName.has(provider.name)) byName.set(provider.name, provider);
  }

  return providerNames
    .map((name) => byName.get(name))
    .filter((provider): provider is SearchProvider => provider !== undefined);
}

function applyResultFilter(
  results: SearchResultItem[],
  resultFilter?: SearchResultFilter,
): SearchResultItem[] {
  return resultFilter ? resultFilter(results) : results;
}

function inferSiteResultFilter(query: string): SearchResultFilter | undefined {
  const match = query.match(/(?:^|\s)site:([^\s]+)\s*$/i);
  const domain = match?.[1];
  return domain
    ? (results) => filterSearchResultsByDomain(results, domain)
    : undefined;
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
  resultFilter,
}: ExecuteProviderSearchOptions): Promise<SearchResultItem[]> {
  if (strategy === "fallback") {
    for (const provider of providers) {
      const results = applyResultFilter(
        await runProvider(provider, query, locale, healthTracker),
        resultFilter,
      );
      if (results.length > 0) return results;
    }
    return [];
  }

  const aggregateProviders = uniqueProvidersByName(providers);
  const settled = await Promise.all(
    aggregateProviders.map(async (provider) => ({
      provider: provider.name,
      results: applyResultFilter(
        await runProvider(provider, query, locale, healthTracker),
        resultFilter,
      ),
    }))
  );

  return fuseSearchResults(
    settled.filter(({ results }) => results.length > 0)
  );
}

export async function executeSearchPlan({
  providers,
  query,
  locale,
  plan,
  healthTracker,
  resultFilter,
}: ExecuteSearchPlanOptions): Promise<SearchResultItem[]> {
  const effectiveResultFilter = resultFilter ?? inferSiteResultFilter(query);
  const primaryProviders = providersInPlanOrder(providers, plan.primaryProviderNames);
  const primaryResults = await executeProviderSearch({
    providers: primaryProviders,
    query,
    locale,
    strategy: plan.strategy,
    healthTracker,
    resultFilter: effectiveResultFilter,
  });

  if (
    plan.strategy === "fallback" ||
    primaryResults.length > 0 ||
    plan.fallbackProviderNames.length === 0
  ) {
    return primaryResults;
  }

  const fallbackProviders = providersInPlanOrder(providers, plan.fallbackProviderNames);
  return executeProviderSearch({
    providers: fallbackProviders,
    query,
    locale,
    strategy: "fallback",
    healthTracker,
    resultFilter: effectiveResultFilter,
  });
}
