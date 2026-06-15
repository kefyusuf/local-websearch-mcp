import type { SearchResultItem } from "../cache/types.js";
import type { SearchLocale } from "../search-utils.js";

export interface SearchProvider {
  name: string;
  execute(query: string, locale: SearchLocale): Promise<SearchResultItem[]>;
}
