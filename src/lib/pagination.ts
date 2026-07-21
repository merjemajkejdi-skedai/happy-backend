// Single source of truth for pagination — every list endpoint uses this so
// the meta shape can never drift between modules.
const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;

export interface PaginationQuery {
  page?: string;
  per_page?: string;
}

export interface PaginationParams {
  page: number;
  perPage: number;
  skip: number;
  take: number;
}

export function parsePagination(query: PaginationQuery): PaginationParams {
  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(query.per_page) || DEFAULT_PER_PAGE));
  return { page, perPage, skip: (page - 1) * perPage, take: perPage };
}

export interface PaginationMeta {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export function buildPaginationMeta(page: number, perPage: number, total: number): PaginationMeta {
  return { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) };
}
