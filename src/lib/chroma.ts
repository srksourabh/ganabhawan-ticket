import type { Product, Show } from './types';

type ChromaMetadata = Record<string, string | number | boolean>;
type ChromaCollection = { id: string };

export interface SearchDocument {
  id: string;
  document: string;
  metadata: ChromaMetadata;
}

export interface CatalogueSearchResult {
  id: string;
  kind: 'show' | 'product';
  title: string;
  titleBn: string;
  description: string;
  score: number;
  productId?: string;
  showId?: string;
  price?: number;
  available?: number;
}

interface ChromaResponse<T> { data?: T; error?: string; message?: string; }

const collectionName = process.env.CHROMA_COLLECTION || 'ganabhawan_catalogue';

function chromaUrl() {
  const value = process.env.CHROMA_URL?.replace(/\/$/, '');
  if (!value) throw new Error('CHROMA_URL is required for catalogue search.');
  return value;
}

async function chroma<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${chromaUrl()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json() as ChromaResponse<T>;
  if (!response.ok) throw new Error(body.error || body.message || `Chroma request failed (${response.status}).`);
  return (body.data ?? body) as T;
}

async function collection(): Promise<ChromaCollection> {
  return chroma<ChromaCollection>('/api/v1/collections', {
    method: 'POST', body: JSON.stringify({ name: collectionName, get_or_create: true }),
  });
}

export function catalogueDocuments(shows: Show[], products: Product[]): SearchDocument[] {
  const showDocs = shows.map(show => ({
    id: `show:${show.id}`,
    document: [show.title, show.title_bn, show.troupe, show.genre, show.synopsis, show.synopsis_bn].join(' '),
    metadata: { kind: 'show', showId: show.id, title: show.title, titleBn: show.title_bn },
  }));
  const productDocs = products.map(product => ({
    id: `product:${product.id}`,
    document: [product.name, product.name_bn, product.category, product.kind, ...product.coverage.map(show => `${show.title} ${show.title_bn}`)].join(' '),
    metadata: { kind: 'product', productId: product.id, title: product.name, titleBn: product.name_bn, price: product.price, available: product.available },
  }));
  return [...showDocs, ...productDocs];
}

export async function indexCatalogue(shows: Show[], products: Product[]) {
  const target = await collection();
  const documents = catalogueDocuments(shows, products);
  if (documents.length) {
    await chroma(`/api/v1/collections/${target.id}/upsert`, {
      method: 'POST', body: JSON.stringify({ ids: documents.map(x => x.id), documents: documents.map(x => x.document), metadatas: documents.map(x => x.metadata) }),
    });
  }
  return { indexed: documents.length };
}

export async function searchCatalogue(text: string, limit = 8): Promise<CatalogueSearchResult[]> {
  const query = text.trim();
  if (!query) return [];
  const target = await collection();
  const result = await chroma<{ ids: string[][]; documents?: (string | null)[][]; metadatas?: (ChromaMetadata | null)[][]; distances?: number[][] }>(`/api/v1/collections/${target.id}/query`, {
    method: 'POST', body: JSON.stringify({ query_texts: [query], n_results: Math.min(Math.max(limit, 1), 20), include: ['documents', 'metadatas', 'distances'] }),
  });
  return (result.ids?.[0] || []).map((id, index) => {
    const metadata = result.metadatas?.[0]?.[index] || {};
    return {
      id, kind: metadata.kind as 'show' | 'product', title: String(metadata.title || id), titleBn: String(metadata.titleBn || ''),
      description: String(result.documents?.[0]?.[index] || ''), score: 1 - Number(result.distances?.[0]?.[index] ?? 1),
      productId: metadata.productId as string | undefined, showId: metadata.showId as string | undefined,
      price: typeof metadata.price === 'number' ? metadata.price : undefined, available: typeof metadata.available === 'number' ? metadata.available : undefined,
    };
  });
}
