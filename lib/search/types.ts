// The search-provider seam (B-5.5). Brave is the first implementation; Tavily
// or Exa can drop in behind this interface if Brave's result quality disappoints.

import type { SearchResult } from '@/lib/types';

export interface SearchProvider {
  id: string;
  search(query: string, opts: { maxResults: number }): Promise<SearchResult[]>;
}

export type { SearchResult };
